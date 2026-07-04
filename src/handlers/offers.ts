/** Offer templates, dynamic terms, revocation (§6.2–§6.4, §8.3). */
import type { Server } from "bun";
import { sql, logPayload } from "../db.ts";
import { redis } from "../redis.ts";
import { config } from "../config.ts";
import { err } from "../errors.ts";
import { parseIso, toIso, isValidPrice, isPlainObject, isHash } from "../validate.ts";
import { envelopeOut, fromJsonb, json, readEnvelope, clientIp, hexToBuf, bufToHex, type RouteReq } from "../http.ts";

// ---------------------------------------------------------------- submit

export async function postOffer(req: Request, server: Server<unknown>): Promise<Response> {
  const w = await readEnvelope(req, "offer/v1");
  const p = w.payload;

  const [maxT, winT] = config.rl.templatePerProvider;
  const retry = await redis.rateLimit("tpl", w.signer, maxT, winT);
  if (retry > 0) throw err("RATE_LIMITED", "too many template submissions", { retryAfterMs: retry });

  const providerBytes = hexToBuf(w.signer);
  const provider = await sql`select 1 from providers where provider_id = ${providerBytes}`;
  if (provider.length === 0) throw err("UNKNOWN_PROVIDER", "register a profile first");

  const now = Date.now();
  const signedAt = parseIso(p.signedAt);
  if (signedAt === null) throw err("VALIDATION", "signedAt must be ISO 8601", { field: "signedAt" });
  if (signedAt > now + config.signedAtMaxFutureMs) {
    throw err("VALIDATION", "signedAt too far in the future", { field: "signedAt" });
  }

  if (!isPlainObject(p.compute)) throw err("VALIDATION", "compute block required", { field: "compute" });
  if (p.compute.model !== "cpu/v1") {
    throw err("VALIDATION", "unsupported compute model", { field: "compute.model" });
  }
  if (!isHash(p.compute.attestationId)) {
    throw err("VALIDATION", "compute.attestationId must be a 0x hash", { field: "compute.attestationId" });
  }
  if (p.constraintsHint !== undefined && (typeof p.constraintsHint !== "string" || p.constraintsHint.length > 1024)) {
    throw err("VALIDATION", "constraintsHint must be a string ≤ 1024 chars", { field: "constraintsHint" });
  }
  const expiresAt = parseIso(p.expiresAt);
  if (expiresAt === null) throw err("VALIDATION", "expiresAt must be ISO 8601", { field: "expiresAt" });
  if (expiresAt <= now) throw err("EXPIRED", "expiresAt is in the past", { field: "expiresAt" });
  if (expiresAt > now + config.templateMaxAheadMs) {
    throw err("VALIDATION", "expiresAt more than 180 days ahead (§6.2)", { field: "expiresAt" });
  }

  const att = await sql`
    select * from attestations where attestation_id = ${hexToBuf(p.compute.attestationId)}`;
  if (att.length === 0) throw err("UNKNOWN_ATTESTATION", "referenced attestation not found");
  const a = att[0];
  if (bufToHex(a.provider_id) !== w.signer) {
    throw err("VALIDATION", "attestation belongs to a different provider", { field: "compute.attestationId" });
  }
  if (a.model !== p.compute.model) {
    throw err("VALIDATION", "attestation model does not match offer model", { field: "compute.model" });
  }
  if ((a.expires_at as Date).getTime() <= now) throw err("ATTESTATION_EXPIRED", "referenced attestation has expired");

  const offerId = w.hash;
  const existing = await sql`select 1 from offers where offer_id = ${hexToBuf(offerId)}`;
  if (existing.length > 0) return json({ offerId }, 200); // idempotent (§8.3)

  const cap = await sql`
    select count(*)::int as n from offers
    where provider_id = ${providerBytes} and revoked_at is null and expires_at > now()`;
  if (cap[0].n >= config.offerCapPerProvider) {
    throw err("LIMIT_EXCEEDED", `active-offer cap (${config.offerCapPerProvider}) reached`);
  }

  const effectiveExpiry = new Date(Math.min(expiresAt, (a.expires_at as Date).getTime()));
  await logPayload(hexToBuf(offerId), "offer/v1", providerBytes, p, hexToBuf(w.signature));
  await sql`
    insert into offers (offer_id, provider_id, attestation_id, template, model, expires_at, created_at,
                        arch, core_count, ram_gib,
                        score_single, score_quad, score_eight, score_full,
                        score_ram_bandwidth, score_dag_hash)
    values (${hexToBuf(offerId)}, ${providerBytes}, ${a.attestation_id}, ${JSON.stringify(p)}::jsonb,
            'cpu/v1', ${effectiveExpiry}, now(),
            ${a.arch}, ${a.core_count}, ${a.ram_gib},
            ${a.score_single}, ${a.score_quad}, ${a.score_eight}, ${a.score_full},
            ${a.score_ram_bandwidth}, ${a.score_dag_hash})`;

  return json({ offerId }, 201);
}

// ---------------------------------------------------------------- lookup

export interface OfferRow {
  offer_id: Uint8Array;
  provider_id: Uint8Array;
  template: Record<string, unknown>;
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
  tpl_sig: Uint8Array;
  att_payload: Record<string, unknown>;
  att_sig: Uint8Array;
  att_received: Date;
  heartbeat_interval_sec: number;
}

const OFFER_SELECT = `
  select o.offer_id, o.provider_id, o.template, o.expires_at, o.revoked_at, o.created_at,
         pl.signature as tpl_sig,
         al.payload as att_payload, al.signature as att_sig, al.received_at as att_received,
         p.heartbeat_interval_sec
  from offers o
  join payload_log pl on pl.hash = o.offer_id
  join payload_log al on al.hash = o.attestation_id
  join providers p on p.provider_id = o.provider_id`;

/** Resolve full 0x-hash or 20-hex offerKey prefix (§8.5) to one offer row. */
export async function findOffer(idOrKey: string): Promise<OfferRow | null> {
  const id = idOrKey.toLowerCase();
  let rows;
  if (/^0x[0-9a-f]{64}$/.test(id)) {
    rows = await sql.unsafe(`${OFFER_SELECT} where o.offer_id = $1`, [hexToBuf(id)]);
  } else if (/^[0-9a-f]{20}$/.test(id)) {
    rows = await sql.unsafe(`${OFFER_SELECT} where substring(o.offer_id from 1 for 10) = $1 limit 2`, [
      Uint8Array.from(Buffer.from(id, "hex")),
    ]);
    if (rows.length > 1) throw err("VALIDATION", "offerKey prefix is ambiguous — use the full offerId");
  } else {
    throw err("VALIDATION", "offer id must be a 0x hash or a 20-hex offerKey");
  }
  return rows.length === 0 ? null : (rows[0] as OfferRow);
}

export type OfferStatus = "active" | "stale" | "expired" | "revoked";

export function offerStatus(row: OfferRow, hasLiveTerms: boolean, nowMs: number): OfferStatus {
  if (row.revoked_at) return "revoked";
  if (row.expires_at.getTime() <= nowMs) return "expired";
  return hasLiveTerms ? "active" : "stale";
}

export async function offerResponse(row: OfferRow, nowMs: number) {
  const offerId = bufToHex(row.offer_id);
  const terms = await redis.getTerms(offerId);
  return {
    offerId,
    template: envelopeOut(fromJsonb(row.template), bufToHex(row.tpl_sig), row.created_at),
    attestation: envelopeOut(fromJsonb(row.att_payload), bufToHex(row.att_sig), row.att_received),
    terms: terms
      ? {
          envelope: terms.envelope,
          meta: { hash: null, receivedAt: terms.receivedAt }, // hash omitted: terms are ephemeral (§6.3)
        }
      : null,
    status: offerStatus(row, terms !== null, nowMs),
  };
}

export async function getOffer(req: RouteReq): Promise<Response> {
  const row = await findOffer(req.params.offerId ?? "");
  if (!row) throw err("UNKNOWN_OFFER", "offer not found");
  return json(await offerResponse(row, Date.now()));
}

// ----------------------------------------------------------------- terms

export async function postTerms(req: RouteReq): Promise<Response> {
  const w = await readEnvelope(req, "terms/v1");
  const p = w.payload;
  const now = Date.now();

  const row = await findOffer(req.params.offerId ?? "");
  if (!row) throw err("UNKNOWN_OFFER", "offer not found");
  const offerId = bufToHex(row.offer_id);

  // spec §12: 1 per I/2 s with burst 3 — approximated as 3 per 1.5·I window
  const I = row.heartbeat_interval_sec;
  const retry = await redis.rateLimit("terms", offerId, 3, Math.ceil(1.5 * I * 1000));
  if (retry > 0) throw err("RATE_LIMITED", "heartbeating faster than declared interval", { retryAfterMs: retry });

  if (row.revoked_at) throw err("REVOKED", "offer is revoked");
  if (row.expires_at.getTime() <= now) throw err("EXPIRED", "offer is expired");
  if (w.signer !== bufToHex(row.provider_id)) throw err("SIG_MISMATCH", "signer is not the offer's provider");
  if (p.offerId !== offerId) throw err("VALIDATION", "payload.offerId must match the offer", { field: "offerId" });

  if (p.unit !== config.unit) {
    throw err("VALIDATION", `unit must be "${config.unit}" (single-currency market, §6.3)`, { field: "unit" });
  }
  if (!isValidPrice(p.minPricePerHour)) {
    throw err("VALIDATION", "minPricePerHour must be a non-negative decimal string of at most 8 characters", {
      field: "minPricePerHour",
    });
  }
  if (typeof p.seq !== "number" || !Number.isInteger(p.seq) || p.seq < 0 || p.seq > Number.MAX_SAFE_INTEGER) {
    throw err("VALIDATION", "seq must be a non-negative integer", { field: "seq" });
  }
  const signedAt = parseIso(p.signedAt);
  const validUntil = parseIso(p.validUntil);
  if (signedAt === null) throw err("VALIDATION", "signedAt must be ISO 8601", { field: "signedAt" });
  if (validUntil === null) throw err("VALIDATION", "validUntil must be ISO 8601", { field: "validUntil" });
  if (signedAt > now + config.signedAtMaxFutureMs) {
    throw err("VALIDATION", "signedAt too far in the future", { field: "signedAt" });
  }
  if (validUntil - signedAt > config.termsMaxValidityMs) {
    throw err("TERMS_TOO_LONG", "validUntil − signedAt exceeds 3600 s (§6.3)");
  }
  if (validUntil <= now) throw err("VALIDATION", "validUntil is already in the past", { field: "validUntil" });
  if (p.capacity !== undefined) {
    if (!isPlainObject(p.capacity) || (p.capacity.coresFree !== undefined &&
        (typeof p.capacity.coresFree !== "number" || !Number.isInteger(p.capacity.coresFree) || p.capacity.coresFree < 0))) {
      throw err("VALIDATION", "capacity.coresFree must be a non-negative integer", { field: "capacity" });
    }
  }

  // seq strictly increasing; absent counter (Redis loss) rebuilds lazily (§14)
  const stored = await redis.getSeq(offerId);
  if (stored !== null && (p.seq as number) <= stored) {
    throw err("SEQ_REGRESSION", `seq must exceed ${stored}`, { field: "seq" });
  }
  await redis.setSeq(offerId, p.seq as number);

  // Redis TTL = min(validUntil − now, 2·I + 30 s)  (§10)
  const ttlMs = Math.min(validUntil - now, (2 * I + 30) * 1000);
  const receivedAt = toIso(now);
  const ok = await redis.setTerms(
    offerId,
    { envelope: { payload: p, signature: w.signature }, receivedAt },
    ttlMs,
    p.minPricePerHour as string,
    now + ttlMs,
  );
  if (!ok) throw err("INTERNAL", "liveness store unavailable (Redis absent, §2 degraded mode)");
  await redis.touchProvider(w.signer, receivedAt);

  // `reattest` is reserved for §5.6 surprise re-challenges (always null in the first pass)
  return json({ ok: true, seq: p.seq, expiresInMs: ttlMs, reattest: null });
}

// ---------------------------------------------------------------- revoke

export async function postRevoke(req: RouteReq): Promise<Response> {
  const w = await readEnvelope(req, "revoke/v1");
  const row = await findOffer(req.params.offerId ?? "");
  if (!row) throw err("UNKNOWN_OFFER", "offer not found");
  const offerId = bufToHex(row.offer_id);

  if (w.signer !== bufToHex(row.provider_id)) throw err("SIG_MISMATCH", "signer is not the offer's provider");
  if (w.payload.offerId !== offerId) throw err("VALIDATION", "payload.offerId must match the offer", { field: "offerId" });
  if (parseIso(w.payload.signedAt) === null) throw err("VALIDATION", "signedAt must be ISO 8601", { field: "signedAt" });

  await logPayload(hexToBuf(w.hash), "revoke/v1", row.provider_id, w.payload, hexToBuf(w.signature));
  await sql`update offers set revoked_at = now() where offer_id = ${row.offer_id} and revoked_at is null`;
  await redis.dropOffer(offerId);

  return json({ ok: true, offerId, status: "revoked" });
}
