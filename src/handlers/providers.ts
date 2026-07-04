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
    select attestation_id, model, score_single, score_quad, score_eight, score_full,
           score_ram_bandwidth, score_dag_hash, expires_at
    from attestations
    where provider_id = ${providerId} and expires_at > now()
    order by measured_at desc limit 1`;

  const stats = await sql`
    select count(*)::int as active_offers
    from offers where provider_id = ${providerId} and revoked_at is null and expires_at > now()`;

  const r = rows[0];
  return json({
    ...envelopeOut(fromJsonb(r.payload), bufToHex(r.signature), r.received_at),
    attestation:
      att.length > 0
        ? {
            id: bufToHex(att[0].attestation_id),
            model: att[0].model,
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
    stats: {
      activeOffers: stats[0].active_offers,
      lastSeenAt: await redis.lastSeen(id),
      firstSeenAt: (r.first_seen_at as Date).toISOString(),
    },
  });
}
