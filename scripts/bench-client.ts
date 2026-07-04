/**
 * Reference provider agent: register → benchmark → attestation → offer → heartbeat.
 * Also the executable contract for the future Rust agent.
 *
 *   BASE_URL=http://localhost:8080 PROVIDER_PRIVKEY=0x… bun run scripts/bench-client.ts
 */
import { addressFromPrivateKey, hexToBytes, signPayload } from "../src/crypto.ts";
import { proveLane, type LaneParams } from "../src/bench.ts";
import { toIso } from "../src/validate.ts";

export interface ClientOptions {
  baseUrl: string;
  priv: Uint8Array;
  coreCount: number;
  ramGib: number;
  cpuModel?: string;
  minPricePerHour: string;
  log?: (msg: string) => void;
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function envelope(payload: Record<string, unknown>, priv: Uint8Array) {
  return { payload, signature: signPayload(payload, priv) };
}

export async function runProviderFlow(opts: ClientOptions) {
  const log = opts.log ?? console.log;
  const providerId = addressFromPrivateKey(opts.priv);
  const { baseUrl, priv } = opts;

  // 1. register profile (§6.1)
  const profile = await post(
    `${baseUrl}/v1/providers`,
    envelope(
      {
        type: "profile/v1",
        providerId,
        signedAt: toIso(Date.now()),
        displayName: `node-${providerId.slice(2, 8)}`,
        netEndpoints: [`p2p://${providerId.slice(2, 10)}.example`],
        heartbeatIntervalSec: 60,
      },
      priv,
    ),
  );
  if (profile.status >= 400) throw new Error(`profile: ${JSON.stringify(profile.body)}`);
  log(`registered provider ${providerId}`);

  // 2. open benchmark challenge (§5.3 step 1)
  const chal = await post(
    `${baseUrl}/v1/attest/challenge`,
    envelope(
      {
        type: "attest-request/v1",
        providerId,
        model: "cpu/v1",
        arch: "x64",
        coreCount: opts.coreCount,
        ramGib: opts.ramGib,
        ...(opts.cpuModel ? { cpuModel: opts.cpuModel } : {}),
        signedAt: toIso(Date.now()),
      },
      priv,
    ),
  );
  if (chal.status >= 400) throw new Error(`challenge: ${JSON.stringify(chal.body)}`);
  const c = chal.body.payload;
  log(`challenge ${c.challengeId.slice(0, 18)}… chainLen=${c.chainLen} C=${c.checkpoints} K=${c.samples}`);

  // 3. lanes, in order (§5.3 step 2)
  let attestation: any = null;
  for (const { laneId, workers } of c.lanes) {
    const start = await post(`${baseUrl}/v1/attest/${c.challengeId}/lane/${laneId}/start`, {});
    if (start.status >= 400) throw new Error(`start ${laneId}: ${JSON.stringify(start.body)}`);

    const params: LaneParams = {
      seed: hexToBytes(c.seed.slice(2)),
      laneNonce: hexToBytes(start.body.laneNonce.slice(2)),
      providerId,
      laneId,
      chainLen: c.chainLen,
      checkpoints: c.checkpoints,
      samples: c.samples,
    };
    const t0 = performance.now();
    const proofs = proveLane(params, workers, c.challengeId);
    const submit = await post(
      `${baseUrl}/v1/attest/${c.challengeId}/lane/${laneId}`,
      envelope(
        { type: "lane-proof/v1", providerId, challengeId: c.challengeId, laneId, workers: proofs },
        priv,
      ),
    );
    if (submit.status >= 400) throw new Error(`submit ${laneId}: ${JSON.stringify(submit.body)}`);
    log(
      `lane ${laneId}: ${workers}w computed in ${(performance.now() - t0).toFixed(0)}ms, ` +
        `server elapsed ${submit.body.elapsedMs}ms`,
    );
    if (submit.body.attestation) attestation = submit.body.attestation;
  }
  if (!attestation) throw new Error("no attestation returned on final lane");
  log(`attestation ${attestation.attestationId.slice(0, 18)}… scores=${JSON.stringify(attestation.envelope.payload.scores)}`);

  // 4. publish an offer referencing the attestation (§6.2)
  const offer = await post(
    `${baseUrl}/v1/offers`,
    envelope(
      {
        type: "offer/v1",
        providerId,
        signedAt: toIso(Date.now()),
        compute: { model: "cpu/v1", attestationId: attestation.attestationId },
        expiresAt: toIso(Date.now() + 7 * 86_400_000),
      },
      priv,
    ),
  );
  if (offer.status >= 400) throw new Error(`offer: ${JSON.stringify(offer.body)}`);
  const offerId = offer.body.offerId;
  log(`offer ${offerId.slice(0, 18)}…`);

  // 5. heartbeat with price (§6.3)
  const terms = await post(
    `${baseUrl}/v1/offers/${offerId}/terms`,
    envelope(
      {
        type: "terms/v1",
        providerId,
        offerId,
        seq: 1,
        signedAt: toIso(Date.now()),
        validUntil: toIso(Date.now() + 180_000),
        unit: "GLM",
        minPricePerHour: opts.minPricePerHour,
        capacity: { coresFree: opts.coreCount },
      },
      priv,
    ),
  );
  if (terms.status >= 400) throw new Error(`terms: ${JSON.stringify(terms.body)}`);
  log(`heartbeat ok (ttl ${terms.body.expiresInMs}ms) — offer is live`);

  return { providerId, challengeId: c.challengeId, attestation, offerId };
}

if (import.meta.main) {
  const priv = process.env.PROVIDER_PRIVKEY;
  if (!priv) {
    console.error("PROVIDER_PRIVKEY required (0x-prefixed 32-byte hex)");
    process.exit(1);
  }
  await runProviderFlow({
    baseUrl: process.env.BASE_URL ?? "http://localhost:8080",
    priv: hexToBytes(priv.replace(/^0x/, "")),
    coreCount: Number(process.env.CORE_COUNT ?? navigator.hardwareConcurrency ?? 4),
    ramGib: Number(process.env.RAM_GIB ?? 16),
    cpuModel: process.env.CPU_MODEL,
    minPricePerHour: process.env.MIN_PRICE_PER_HOUR ?? "0.05",
  });
}
