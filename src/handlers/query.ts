/** Requestor search (§8.4) and the liveness snapshot (§8.5). */
import type { Server } from "bun";
import { sql } from "../db.ts";
import { redis } from "../redis.ts";
import { config } from "../config.ts";
import { err } from "../errors.ts";
import { keccak256, bytesToHex, randomBytes } from "../crypto.ts";
import { json, clientIp, bufToHex } from "../http.ts";
import { offerStatus, type OfferRow } from "./offers.ts";
import { envelopeOut, fromJsonb } from "../http.ts";

type Freshness = "strict" | "normal" | "any";
const SORTS = ["price", "score.full", "score.single", "score.ramBandwidth", "score.dagHash", "random"] as const;
type Sort = (typeof SORTS)[number];

interface Cursor {
  seed: string;
  offset: number;
}

function parseCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (typeof c.seed === "string" && Number.isInteger(c.offset) && c.offset >= 0) return c;
  } catch {
    /* fall through */
  }
  throw err("VALIDATION", "malformed cursor");
}

function numParam(url: URL, name: string): number | null {
  const v = url.searchParams.get(name);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw err("VALIDATION", `${name} must be a number`, { field: name });
  return n;
}

export async function getOffers(req: Request, server: Server<unknown>): Promise<Response> {
  const ip = clientIp(req, server);
  const [maxQ, winQ] = config.rl.queryPerIp;
  const retry = await redis.rateLimit("query", ip, maxQ, winQ);
  if (retry > 0) throw err("RATE_LIMITED", "query rate exceeded", { retryAfterMs: retry });

  const url = new URL(req.url);
  const model = url.searchParams.get("model") ?? "cpu/v1";
  if (model !== "cpu/v1") return json({ items: [], nextCursor: null }); // unknown model simply matches nothing (§4.1)

  const arch = url.searchParams.get("arch");
  if (arch !== null && arch !== "x64") return json({ items: [], nextCursor: null });

  const freshness = (url.searchParams.get("freshness") ?? "normal") as Freshness;
  if (!["strict", "normal", "any"].includes(freshness)) throw err("VALIDATION", "freshness must be strict|normal|any");
  const sort = (url.searchParams.get("sort") ?? "random") as Sort;
  if (!SORTS.includes(sort)) throw err("VALIDATION", `sort must be one of ${SORTS.join("|")}`);
  const limit = Math.min(Math.max(1, numParam(url, "limit") ?? config.queryDefaultLimit), config.queryMaxLimit);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const priceMax = url.searchParams.get("price.perHour.max");
  if (priceMax !== null && !/^\d+(\.\d+)?$/.test(priceMax)) {
    throw err("VALIDATION", "price.perHour.max must be a decimal", { field: "price.perHour.max" });
  }

  // score.ramBandwidth/dagHash match only non-null scores (§8.4) — always empty in the first pass (§5.5)
  if (numParam(url, "score.ramBandwidth.min") !== null || numParam(url, "score.dagHash.min") !== null) {
    return json({ items: [], nextCursor: null });
  }

  const wheres: string[] = ["o.model = 'cpu/v1'", "o.revoked_at is null", "o.expires_at > now()"];
  const params: unknown[] = [];
  const add = (cond: string, v: unknown) => {
    params.push(v);
    wheres.push(cond.replace("?", `$${params.length}`));
  };
  const coresMin = numParam(url, "cores.min");
  if (coresMin !== null) add("o.core_count >= ?", coresMin);
  const ramMin = numParam(url, "ram.gib.min");
  if (ramMin !== null) add("o.ram_gib >= ?", ramMin);
  for (const [param, col] of [
    ["score.single.min", "score_single"],
    ["score.quad.min", "score_quad"],
    ["score.eight.min", "score_eight"],
    ["score.full.min", "score_full"],
  ] as const) {
    const v = numParam(url, param);
    if (v !== null) add(`o.${col} >= ?`, v);
  }

  const candidates = (await sql.unsafe(
    `select o.offer_id, o.provider_id, o.template, o.expires_at, o.revoked_at, o.created_at,
            o.score_single, o.score_quad, o.score_eight, o.score_full,
            pl.signature as tpl_sig,
            al.payload as att_payload, al.signature as att_sig, al.received_at as att_received,
            p.heartbeat_interval_sec
     from offers o
     join payload_log pl on pl.hash = o.offer_id
     join payload_log al on al.hash = o.attestation_id
     join providers p on p.provider_id = o.provider_id
     where ${wheres.join(" and ")}
     limit ${config.queryMaxCandidates}`,
    params,
  )) as (OfferRow & Record<string, unknown>)[];

  // liveness + price pass against current DynamicTerms (§8.4, §14)
  const now = Date.now();
  const ids = candidates.map((r) => bufToHex(r.offer_id));
  const termsMap = await redis.getTermsBatch(ids);

  type Enriched = { row: OfferRow & Record<string, unknown>; id: string; price: number | null; live: boolean };
  const enriched: Enriched[] = [];
  for (const row of candidates) {
    const id = bufToHex(row.offer_id);
    const terms = termsMap.get(id) ?? null;
    let fresh = false;
    let price: number | null = null;
    if (terms) {
      const age = now - Date.parse(terms.receivedAt);
      const I = row.heartbeat_interval_sec * 1000;
      fresh = freshness === "strict" ? age <= I : age <= 2 * I + 30_000;
      price = Number((terms.envelope as { payload: { minPricePerHour: string } }).payload.minPricePerHour);
    }
    if (freshness !== "any" && !fresh) continue;
    if (priceMax !== null && (price === null || price > Number(priceMax))) continue;
    enriched.push({ row, id, price, live: terms !== null });
  }

  // deterministic ordering; random uses a per-query seed carried in the cursor (§8.4)
  const seed = cursor?.seed ?? bytesToHex(randomBytes(8));
  const scoreCol: Record<string, string> = {
    "score.full": "score_full",
    "score.single": "score_single",
    "score.ramBandwidth": "score_ram_bandwidth",
    "score.dagHash": "score_dag_hash",
  };
  enriched.sort((a, b) => {
    if (sort === "price") {
      const pa = a.price ?? Infinity;
      const pb = b.price ?? Infinity;
      if (pa !== pb) return pa - pb;
    } else if (sort !== "random") {
      const col = scoreCol[sort]!;
      const sa = Number(a.row[col] ?? 0);
      const sb = Number(b.row[col] ?? 0);
      if (sa !== sb) return sb - sa;
    } else {
      const ka = bytesToHex(keccak256(new TextEncoder().encode(seed + a.id)));
      const kb = bytesToHex(keccak256(new TextEncoder().encode(seed + b.id)));
      if (ka !== kb) return ka < kb ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });

  const offset = cursor?.offset ?? 0;
  const page = enriched.slice(offset, offset + limit);
  const items = await Promise.all(
    page.map(async ({ row, id }) => {
      const terms = termsMap.get(id) ?? null;
      return {
        offerId: id,
        template: envelopeOut(fromJsonb(row.template), bufToHex(row.tpl_sig), row.created_at),
        attestation: envelopeOut(fromJsonb(row.att_payload), bufToHex(row.att_sig), row.att_received),
        terms: terms ? { envelope: terms.envelope, meta: { hash: null, receivedAt: terms.receivedAt } } : null,
        status: offerStatus(row, terms !== null, now),
      };
    }),
  );
  const nextCursor =
    offset + limit < enriched.length
      ? Buffer.from(JSON.stringify({ seed, offset: offset + limit })).toString("base64url")
      : null;

  return json({ items, nextCursor });
}

// ------------------------------------------------------------- liveness

/** GET /v1/liveness — global compact snapshot; cached blob shared by all pollers (§8.5). */
export async function getLiveness(req: Request, server: Server<unknown>): Promise<Response> {
  const ip = clientIp(req, server);
  const [maxL, winL] = config.rl.livenessPerIp;
  const retry = await redis.rateLimit("live", ip, maxL, winL);
  if (retry > 0) throw err("RATE_LIMITED", "liveness poll rate exceeded", { retryAfterMs: retry });

  let blob = await redis.getCachedSnapshot();
  if (!blob) {
    const now = Date.now();
    const rows = await redis.liveOffers(now);
    blob = JSON.stringify({
      at: Math.floor(now / 1000),
      ttlSec: Math.max(1, Math.round(config.livenessTtlMs / 1000)),
      unit: config.unit,
      count: rows.length,
      cols: ["offerKey", "minPricePerHour"],
      // offerKey = first 80 bits of offerId, no 0x (§8.5)
      rows: rows.map(([id, price]) => [id.slice(2, 22), price]),
    });
    await redis.setCachedSnapshot(blob, config.livenessTtlMs);
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (req.headers.get("accept-encoding")?.includes("gzip")) {
    return new Response(Bun.gzipSync(blob), { headers: { ...headers, "content-encoding": "gzip" } });
  }
  return new Response(blob, { headers });
}
