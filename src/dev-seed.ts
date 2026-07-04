/**
 * Dev-only dummy market seeder (ATLAS_DEV_SEED=N, default 0 = off).
 *
 * Creates N fake providers with deterministic keys, properly signed profiles,
 * offers and service-signed attestations with fabricated scores (no benchmark
 * is run), then keeps a heartbeat loop posting DynamicTerms with price jitter
 * so the market has live data to browse. Personas cycle through liveness
 * behaviors: steady (heartbeats every interval), flaky (skips ~half), and
 * offline (registered but never heartbeats → stale).
 *
 * Everything goes through the real signing path — envelopes verify like any
 * provider's — but scores are invented, so NEVER enable this in a production
 * market. Idempotent across restarts: providers are keyed deterministically
 * and offers are only re-created once expired.
 */
import { sql, logPayload } from "./db.ts";
import { redis } from "./redis.ts";
import { config } from "./config.ts";
import { keccak256, addressFromPrivateKey, signPayload, payloadHash } from "./crypto.ts";
import { toIso } from "./validate.ts";
import { hexToBuf } from "./http.ts";

interface Persona {
  priv: Uint8Array;
  providerId: string;
  displayName: string;
  coreCount: number;
  ramGib: number;
  cpuModel: string;
  basePrice: number;
  heartbeatIntervalSec: number;
  behavior: "steady" | "flaky" | "offline";
  offerId?: string;
}

const CPUS = [
  ["AMD EPYC 9654", 96, 384],
  ["AMD Ryzen 9 7950X", 16, 128],
  ["Intel Xeon Platinum 8480+", 56, 256],
  ["Intel Core i9-14900K", 24, 64],
  ["AMD EPYC 7443P", 24, 128],
  ["Intel Xeon E-2388G", 8, 32],
  ["AMD Ryzen 5 5600X", 6, 32],
  ["Ampere Altra Q80-30 (x64 emu)", 4, 16],
] as const;

function persona(i: number): Persona {
  const priv = keccak256(new TextEncoder().encode(`atlas-dev-seed:${i}`));
  const [cpuModel, coreCount, ramGib] = CPUS[i % CPUS.length]!;
  const behaviors = ["steady", "steady", "steady", "flaky", "offline"] as const;
  return {
    priv,
    providerId: addressFromPrivateKey(priv),
    displayName: `dev-dummy-${String(i + 1).padStart(2, "0")}`,
    coreCount,
    ramGib,
    cpuModel,
    basePrice: 0.01 + 0.005 * coreCount + (i % 7) * 0.01,
    // DynamicTerms expire after 2I + 30s, so I=15 gives dev offers a
    // predictable 60-second stale threshold.
    heartbeatIntervalSec: 15,
    behavior: behaviors[i % behaviors.length]!,
  };
}

/** Fabricated but plausible score: ~600 CU/core single, sublinear scaling. */
function fakeScores(coreCount: number, i: number) {
  const perCore = 500 + ((i * 97) % 300);
  const at = (n: number) => Math.round(perCore * Math.min(n, coreCount) * 0.92 ** Math.log2(Math.min(n, coreCount)));
  return { singleCore: at(1), quadCore: at(4), eightCore: at(8), full: at(coreCount), ramBandwidth: null, dagHash: null };
}

async function ensureProvider(p: Persona, now: number): Promise<void> {
  const providerBytes = hexToBuf(p.providerId);
  const existing = await sql`select 1 from providers where provider_id = ${providerBytes}`;
  if (existing.length === 0) {
    const profile = {
      type: "profile/v1",
      providerId: p.providerId,
      displayName: p.displayName,
      netEndpoints: [`wss://${p.displayName}.dev.invalid:443`],
      heartbeatIntervalSec: p.heartbeatIntervalSec,
      contact: "dev-seed@invalid",
      signedAt: toIso(now),
    };
    const sig = signPayload(profile, p.priv);
    const hash = payloadHash(profile);
    await logPayload(hexToBuf(hash), "profile/v1", providerBytes, profile, hexToBuf(sig));
    await sql`
      insert into providers (provider_id, profile_hash, signed_at, heartbeat_interval_sec, first_seen_at, updated_at)
      values (${providerBytes}, ${hexToBuf(hash)}, ${new Date(now)}, ${p.heartbeatIntervalSec}, now(), now())
      on conflict (provider_id) do nothing`;
  }

  // reuse a live offer if one exists; otherwise mint attestation + offer
  const offers = await sql`
    select offer_id from offers
    where provider_id = ${providerBytes} and revoked_at is null and expires_at > now()
    order by created_at desc limit 1`;
  if (offers.length > 0) {
    p.offerId = "0x" + Buffer.from(offers[0].offer_id).toString("hex");
    return;
  }

  const attestation = {
    type: "attest/cpu/v1",
    model: "cpu/v1",
    providerId: p.providerId,
    challengeId: payloadHash({ devSeed: p.providerId, at: now }), // synthetic — no benchmark was run
    arch: "x64",
    coreCount: p.coreCount,
    ramGib: p.ramGib,
    cpuModel: p.cpuModel,
    scores: fakeScores(p.coreCount, p.coreCount),
    measuredAt: toIso(now),
    expiresAt: toIso(now + config.attestationTtlMs),
    attesterKey: addressFromPrivateKey(config.servicePrivKey),
    specVersion: config.specVersion,
  };
  const attSig = signPayload(attestation, config.servicePrivKey);
  const attestationId = payloadHash(attestation);
  await logPayload(hexToBuf(attestationId), "attest/cpu/v1", providerBytes, attestation, hexToBuf(attSig));
  await sql`
    insert into attestations (attestation_id, provider_id, model, arch, core_count, ram_gib, cpu_model,
                              score_single, score_quad, score_eight, score_full,
                              measured_at, expires_at, signature)
    values (${hexToBuf(attestationId)}, ${providerBytes}, 'cpu/v1', 'x64',
            ${p.coreCount}, ${p.ramGib}, ${p.cpuModel},
            ${attestation.scores.singleCore}, ${attestation.scores.quadCore},
            ${attestation.scores.eightCore}, ${attestation.scores.full},
            ${new Date(now)}, ${new Date(now + config.attestationTtlMs)}, ${hexToBuf(attSig)})
    on conflict (attestation_id) do nothing`;

  const offer = {
    type: "offer/v1",
    providerId: p.providerId,
    compute: { model: "cpu/v1", attestationId },
    constraintsHint: "dev-seed dummy offer — not schedulable",
    expiresAt: toIso(now + 7 * 86_400_000),
    signedAt: toIso(now),
  };
  const offerSig = signPayload(offer, p.priv);
  const offerId = payloadHash(offer);
  await logPayload(hexToBuf(offerId), "offer/v1", providerBytes, offer, hexToBuf(offerSig));
  await sql`
    insert into offers (offer_id, provider_id, attestation_id, template, model, expires_at, created_at,
                        arch, core_count, ram_gib, score_single, score_quad, score_eight, score_full)
    values (${hexToBuf(offerId)}, ${providerBytes}, ${hexToBuf(attestationId)}, ${offer},
            'cpu/v1', ${new Date(now + 7 * 86_400_000)}, now(),
            'x64', ${p.coreCount}, ${p.ramGib},
            ${attestation.scores.singleCore}, ${attestation.scores.quadCore},
            ${attestation.scores.eightCore}, ${attestation.scores.full})
    on conflict (offer_id) do nothing`;
  p.offerId = offerId;
}

/** ≤8 chars per §6.3: jitter around base, e.g. "0.1234". */
function jitteredPrice(base: number): string {
  const v = base * (0.9 + 0.2 * Math.random());
  return v.toFixed(4).slice(0, 8);
}

async function heartbeat(p: Persona, seq: number): Promise<void> {
  if (!p.offerId) return;
  const now = Date.now();
  const terms = {
    type: "terms/v1",
    providerId: p.providerId,
    offerId: p.offerId,
    seq,
    unit: config.unit,
    minPricePerHour: jitteredPrice(p.basePrice),
    capacity: { coresFree: Math.floor(Math.random() * (p.coreCount + 1)) },
    signedAt: toIso(now),
    validUntil: toIso(now + 10 * 60_000),
  };
  const sig = signPayload(terms, p.priv);
  const ttlMs = Math.min(10 * 60_000, (2 * p.heartbeatIntervalSec + 30) * 1000);
  await redis.setSeq(p.offerId, seq);
  await redis.setTerms(
    p.offerId,
    { envelope: { payload: terms, signature: sig }, receivedAt: toIso(now) },
    ttlMs,
    terms.minPricePerHour,
    now + ttlMs,
  );
  await redis.touchProvider(p.providerId, toIso(now));
}

/** Seed N dummy providers and start the heartbeat loop. Returns a stopper (for tests). */
export async function seedDevMarket(n: number): Promise<() => void> {
  console.warn(`⚠ ATLAS_DEV_SEED=${n} — seeding ${n} DUMMY providers with fabricated attestations. Dev/testing only.`);
  const personas = Array.from({ length: n }, (_, i) => persona(i));
  const now = Date.now();
  for (const p of personas) await ensureProvider(p, now);

  // seq must only ever grow, including across restarts — derive from wall clock.
  // Schedule providers independently so a large dev market does not produce a
  // synchronized Redis burst every tick.
  let seq = Math.floor(Date.now() / 1000);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  const schedule = (p: Persona, delayMs: number) => {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (stopped) return;
      if (p.behavior !== "flaky" || Math.random() >= 0.5) {
        seq += 1;
        await heartbeat(p, seq).catch((e) => console.error("[dev-seed] heartbeat failed:", e));
      }
      if (!stopped) schedule(p, 20_000 + Math.random() * 5_000);
    }, delayMs);
    timer.unref?.();
    timers.add(timer);
  };

  for (const p of personas) {
    if (p.behavior !== "offline") schedule(p, Math.random() * 25_000);
  }

  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
