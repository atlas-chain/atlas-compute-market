/** Provider registration and lookup (§6.1, §8.1). */
import type { Server } from "bun";
import { sql, logPayload } from "../db.ts";
import { redis } from "../redis.ts";
import { config } from "../config.ts";
import { err } from "../errors.ts";
import { parseIso } from "../validate.ts";
import { envelopeOut, fromJsonb, json, readEnvelope, clientIp, hexToBuf, bufToHex, type RouteReq } from "../http.ts";

function validateProfile(p: Record<string, unknown>): void {
  const signedAt = parseIso(p.signedAt);
  if (signedAt === null) throw err("VALIDATION", "signedAt must be ISO 8601 (§3.6)", { field: "signedAt" });
  if (signedAt > Date.now() + config.signedAtMaxFutureMs) {
    throw err("VALIDATION", "signedAt too far in the future", { field: "signedAt" });
  }
  if (typeof p.displayName !== "string" || p.displayName.length < 1 || p.displayName.length > 128) {
    throw err("VALIDATION", "displayName must be a 1–128 char string", { field: "displayName" });
  }
  if (
    !Array.isArray(p.netEndpoints) ||
    p.netEndpoints.length > 16 ||
    !p.netEndpoints.every((e) => typeof e === "string" && e.length >= 1 && e.length <= 256)
  ) {
    throw err("VALIDATION", "netEndpoints must be up to 16 strings", { field: "netEndpoints" });
  }
  const hb = p.heartbeatIntervalSec;
  if (typeof hb !== "number" || !Number.isInteger(hb) || hb < config.heartbeatMin || hb > config.heartbeatMax) {
    throw err("VALIDATION", `heartbeatIntervalSec must be an integer in [${config.heartbeatMin}, ${config.heartbeatMax}]`, {
      field: "heartbeatIntervalSec",
    });
  }
  if (p.contact !== undefined && (typeof p.contact !== "string" || p.contact.length > 256)) {
    throw err("VALIDATION", "contact must be a string ≤ 256 chars", { field: "contact" });
  }
}

export async function postProvider(req: Request, server: Server<unknown>): Promise<Response> {
  const ip = clientIp(req, server);
  const [maxReg, winReg] = config.rl.registrationPerIp;
  const retry = await redis.rateLimit("reg", ip, maxReg, winReg);
  if (retry > 0) throw err("RATE_LIMITED", "too many registrations", { retryAfterMs: retry });

  const w = await readEnvelope(req, "profile/v1");
  validateProfile(w.payload);

  const [maxProf, winProf] = config.rl.profilePerProvider;
  const retryP = await redis.rateLimit("profile", w.signer, maxProf, winProf);
  if (retryP > 0) throw err("RATE_LIMITED", "too many profile updates", { retryAfterMs: retryP });

  const providerId = hexToBuf(w.signer);
  const signedAt = new Date(parseIso(w.payload.signedAt)!);

  const existing = await sql`select signed_at from providers where provider_id = ${providerId}`;
  if (existing.length > 0 && signedAt.getTime() <= (existing[0].signed_at as Date).getTime()) {
    throw err("STALE_PAYLOAD", "a profile with an equal or newer signedAt is already stored");
  }

  await logPayload(hexToBuf(w.hash), "profile/v1", providerId, w.payload, hexToBuf(w.signature));
  await sql`
    insert into providers (provider_id, profile_hash, signed_at, heartbeat_interval_sec, first_seen_at, updated_at)
    values (${providerId}, ${hexToBuf(w.hash)}, ${signedAt}, ${w.payload.heartbeatIntervalSec as number}, now(), now())
    on conflict (provider_id) do update
      set profile_hash = excluded.profile_hash,
          signed_at = excluded.signed_at,
          heartbeat_interval_sec = excluded.heartbeat_interval_sec,
          updated_at = now()`;

  return json({ providerId: w.signer }, existing.length > 0 ? 200 : 201);
}

/** GET /v1/providers — paginated directory of registered providers (§8.1). Unsigned aggregates. */
export async function listProviders(req: Request, server: Server<unknown>): Promise<Response> {
  const ip = clientIp(req, server);
  const [maxQ, winQ] = config.rl.queryPerIp;
  const retry = await redis.rateLimit("query", ip, maxQ, winQ);
  if (retry > 0) throw err("RATE_LIMITED", "query rate exceeded", { retryAfterMs: retry });

  const url = new URL(req.url);
  const intParam = (name: string, def: number): number => {
    const v = url.searchParams.get(name);
    if (v === null) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw err("VALIDATION", `${name} must be a non-negative integer`, { field: name });
    return n;
  };
  const limit = Math.min(Math.max(1, intParam("limit", config.providersDefaultLimit)), config.providersMaxLimit);
  const offset = intParam("offset", 0);

  const [{ total }] = await sql`select count(*)::int as total from providers`;
  const rows: Record<string, unknown>[] = await sql`
    select p.provider_id, p.first_seen_at, p.heartbeat_interval_sec,
           pl.payload->>'displayName' as display_name,
           a.core_count, a.ram_gib, a.cpu_model, a.expires_at as att_expires_at,
           a.score_single, a.score_quad, a.score_eight, a.score_full,
           a.score_ram_bandwidth, a.score_dag_hash,
           (select count(*)::int from offers o
             where o.provider_id = p.provider_id and o.revoked_at is null and o.expires_at > now()) as active_offers
    from providers p
    join payload_log pl on pl.hash = p.profile_hash
    left join lateral (
      select * from attestations a
      where a.provider_id = p.provider_id and a.expires_at > now()
      order by a.measured_at desc limit 1
    ) a on true
    order by p.first_seen_at desc, p.provider_id
    limit ${limit} offset ${offset}`;

  const ids = rows.map((r) => bufToHex(r.provider_id as Uint8Array));
  const seenMap = await redis.lastSeenBatch(ids);

  // live/busy-offer counts per provider, derived from the Redis live set
  // and the avail/v1 busy flags (§6.5) — both empty maps when degraded
  const liveByProvider = new Map<string, number>();
  const busyByProvider = new Map<string, number>();
  const live = await redis.liveOffers(Date.now());
  if (live.length > 0) {
    const liveIds = live.map(([id]) => id);
    const busySet = await redis.busyBatch(liveIds);
    // bytea[] params aren't serializable by Bun SQL — ship hex and decode in SQL
    const hexList = liveIds.map((id) => id.slice(2)).join(",");
    const busyHex = [...busySet].map((id) => id.slice(2)).join(",");
    const counts = await sql`
      select provider_id, count(*)::int as n,
             count(*) filter (where encode(offer_id, 'hex') = any(string_to_array(${busyHex}, ',')))::int as busy
      from offers
      where offer_id in (select decode(h, 'hex') from unnest(string_to_array(${hexList}, ',')) h)
      group by provider_id`;
    for (const c of counts) {
      liveByProvider.set(bufToHex(c.provider_id), c.n as number);
      busyByProvider.set(bufToHex(c.provider_id), c.busy as number);
    }
  }

  const items = rows.map((r, i) => ({
    providerId: ids[i]!,
    displayName: r.display_name as string,
    heartbeatIntervalSec: r.heartbeat_interval_sec as number,
    activeOffers: r.active_offers as number,
    liveOffers: liveByProvider.get(ids[i]!) ?? 0,
    busyOffers: busyByProvider.get(ids[i]!) ?? 0,
    attestation:
      r.att_expires_at === null
        ? null
        : {
            coreCount: r.core_count as number,
            ramGib: Number(r.ram_gib),
            cpuModel: (r.cpu_model as string | null) ?? null,
            scores: {
              singleCore: Number(r.score_single),
              quadCore: Number(r.score_quad),
              eightCore: Number(r.score_eight),
              full: Number(r.score_full),
              ramBandwidth: r.score_ram_bandwidth === null ? null : Number(r.score_ram_bandwidth),
              dagHash: r.score_dag_hash === null ? null : Number(r.score_dag_hash),
            },
            expiresAt: (r.att_expires_at as Date).toISOString(),
          },
    firstSeenAt: (r.first_seen_at as Date).toISOString(),
    lastSeenAt: seenMap.get(ids[i]!) ?? null,
  }));

  return json({ items, total, limit, offset });
}

export async function getProvider(req: RouteReq): Promise<Response> {
  const id = req.params.providerId?.toLowerCase() ?? "";
  if (!/^0x[0-9a-f]{40}$/.test(id)) throw err("VALIDATION", "invalid providerId");
  const providerId = hexToBuf(id);

  const rows = await sql`
    select p.first_seen_at, pl.payload, pl.signature, pl.received_at
    from providers p join payload_log pl on pl.hash = p.profile_hash
    where p.provider_id = ${providerId}`;
  if (rows.length === 0) throw err("UNKNOWN_PROVIDER", "provider not registered");

  const att = await sql`
    select attestation_id, model, core_count, ram_gib, cpu_model,
           score_single, score_quad, score_eight, score_full,
           score_ram_bandwidth, score_dag_hash, expires_at
    from attestations
    where provider_id = ${providerId} and expires_at > now()
    order by measured_at desc limit 1`;

  // this provider's active offers with per-offer live/busy state, for
  // provider-page views — same unsigned server-derived caveat as §8.1
  const offerRows: Record<string, unknown>[] = await sql`
    select offer_id, expires_at from offers
    where provider_id = ${providerId} and revoked_at is null and expires_at > now()
    order by created_at desc`;
  const offerIds = offerRows.map((o) => bufToHex(o.offer_id as Uint8Array));
  const [termsMap, busySet] = await Promise.all([redis.getTermsBatch(offerIds), redis.busyBatch(offerIds)]);
  const offers = offerRows.map((o, i) => {
    const oid = offerIds[i]!;
    const terms = termsMap.get(oid) ?? null;
    const tp = (terms?.envelope as { payload?: { minPricePerHour?: string; capacity?: { coresFree?: number } } } | undefined)
      ?.payload;
    return {
      offerId: oid,
      status: terms === null ? "stale" : busySet.has(oid) ? "busy" : "active",
      minPricePerHour: tp?.minPricePerHour ?? null,
      coresFree: tp?.capacity?.coresFree ?? null,
      expiresAt: (o.expires_at as Date).toISOString(),
    };
  });

  const r = rows[0];
  return json({
    ...envelopeOut(fromJsonb(r.payload), bufToHex(r.signature), r.received_at),
    attestation:
      att.length > 0
        ? {
            id: bufToHex(att[0].attestation_id),
            model: att[0].model,
            coreCount: att[0].core_count as number,
            ramGib: Number(att[0].ram_gib),
            cpuModel: (att[0].cpu_model as string | null) ?? null,
            scores: {
              singleCore: Number(att[0].score_single),
              quadCore: Number(att[0].score_quad),
              eightCore: Number(att[0].score_eight),
              full: Number(att[0].score_full),
              ramBandwidth: att[0].score_ram_bandwidth === null ? null : Number(att[0].score_ram_bandwidth),
              dagHash: att[0].score_dag_hash === null ? null : Number(att[0].score_dag_hash),
            },
            expiresAt: (att[0].expires_at as Date).toISOString(),
          }
        : null,
    offers,
    stats: {
      activeOffers: offers.length,
      liveOffers: offers.filter((o) => o.status !== "stale").length,
      busyOffers: offers.filter((o) => o.status === "busy").length,
      lastSeenAt: await redis.lastSeen(id),
      firstSeenAt: (r.first_seen_at as Date).toISOString(),
    },
  });
}
