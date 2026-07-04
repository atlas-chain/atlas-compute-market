/**
 * End-to-end: docker Postgres + Redis, in-process server, full provider flow
 * via the reference client, then requestor-side query/liveness assertions.
 *
 * Skipped automatically when docker is unavailable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const PG_PORT = 55432;
const REDIS_PORT = 56379;
const API_PORT = 58080;
const BASE = `http://localhost:${API_PORT}`;

// tiny benchmark so the whole run takes milliseconds of hashing
process.env.DATABASE_URL = `postgres://atlas:atlas@localhost:${PG_PORT}/atlas`;
process.env.REDIS_URL = `redis://localhost:${REDIS_PORT}`;
process.env.ATLAS_CHAIN_LEN = "4096";
process.env.ATLAS_CHECKPOINTS = "64";
process.env.ATLAS_SAMPLES = "8";
process.env.ATLAS_LIVENESS_TTL_MS = "50";

const docker = Bun.which("docker") !== null && (await Bun.$`docker info`.quiet().nothrow()).exitCode === 0;
const CONTAINERS = ["atlas-it-pg", "atlas-it-redis"];

const jsonOf = async (res: Response): Promise<any> => res.json();

async function waitFor(probe: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await probe().catch(() => false)) return;
    await Bun.sleep(300);
  }
  throw new Error(`timeout waiting for ${what}`);
}

describe.skipIf(!docker)("end-to-end provider → requestor flow", () => {
  let server: { stop: (force?: boolean) => void };
  let flow: Awaited<ReturnType<typeof import("../scripts/bench-client.ts").runProviderFlow>>;

  beforeAll(async () => {
    for (const c of CONTAINERS) await Bun.$`docker rm -f ${c}`.quiet().nothrow();
    await Bun.$`docker run -d --rm --name atlas-it-pg -e POSTGRES_USER=atlas -e POSTGRES_PASSWORD=atlas -e POSTGRES_DB=atlas -p ${PG_PORT}:5432 postgres:16-alpine`.quiet();
    await Bun.$`docker run -d --rm --name atlas-it-redis -p ${REDIS_PORT}:6379 redis:7-alpine`.quiet();
    await waitFor(
      async () => (await Bun.$`docker exec atlas-it-pg pg_isready -U atlas`.quiet().nothrow()).exitCode === 0,
      "postgres",
    );
    await waitFor(
      async () => (await Bun.$`docker exec atlas-it-redis redis-cli ping`.quiet().nothrow()).exitCode === 0,
      "redis",
    );
    const { startServer } = await import("../src/server.ts");
    server = await startServer(API_PORT);

    const { hexToBytes } = await import("../src/crypto.ts");
    const { runProviderFlow } = await import("../scripts/bench-client.ts");
    flow = await runProviderFlow({
      baseUrl: BASE,
      priv: hexToBytes("0000000000000000000000000000000000000000000000000000000000000002"),
      coreCount: 2,
      ramGib: 16,
      cpuModel: "test-cpu",
      minPricePerHour: "0.05",
      log: () => {},
    });
  }, 120_000);

  afterAll(async () => {
    server?.stop(true);
    for (const c of CONTAINERS) await Bun.$`docker rm -f ${c}`.quiet().nothrow();
  });

  test("health reports both stores up", async () => {
    const res = await fetch(`${BASE}/v1/health`);
    expect(await jsonOf(res)).toEqual({ postgres: "ok", redis: "ok" });
  });

  test("attestation is persisted, service-signed, and fetchable", async () => {
    const res = await fetch(`${BASE}/v1/attestations/${flow.attestation.attestationId}`);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.envelope.payload.providerId).toBe(flow.providerId);
    expect(body.envelope.payload.scores.singleCore).toBeGreaterThan(0);
    expect(body.envelope.payload.scores.full).toBeGreaterThan(0);
    expect(body.envelope.payload.scores.ramBandwidth).toBeNull();
    // service signature verifies against the spec-advertised key
    const { recoverSigner } = await import("../src/crypto.ts");
    const spec = await jsonOf(await fetch(`${BASE}/v1/spec`));
    expect(recoverSigner(body.envelope.payload, body.envelope.signature)).toBe(spec.serviceKey);
  });

  test("provider profile shows attestation summary and active offer", async () => {
    const body = await jsonOf(await fetch(`${BASE}/v1/providers/${flow.providerId}`));
    expect(body.attestation.id).toBe(flow.attestation.attestationId);
    expect(body.stats.activeOffers).toBe(1);
    expect(body.stats.lastSeenAt).not.toBeNull();
  });

  test("query returns the live offer with verifiable envelopes", async () => {
    const res = await fetch(`${BASE}/v1/offers?model=cpu/v1&cores.min=2&score.single.min=1&price.perHour.max=0.10`);
    const body = await jsonOf(res);
    expect(body.items.length).toBe(1);
    const item = body.items[0];
    expect(item.offerId).toBe(flow.offerId);
    expect(item.status).toBe("active");
    expect(item.terms.envelope.payload.minPricePerHour).toBe("0.05");
    const { recoverSigner } = await import("../src/crypto.ts");
    expect(recoverSigner(item.template.envelope.payload, item.template.envelope.signature)).toBe(flow.providerId);
    expect(recoverSigner(item.terms.envelope.payload, item.terms.envelope.signature)).toBe(flow.providerId);
  });

  test("query filters exclude the offer when floors are not met", async () => {
    const body = await jsonOf(await fetch(`${BASE}/v1/offers?cores.min=64`));
    expect(body.items.length).toBe(0);
    const tooCheap = await jsonOf(await fetch(`${BASE}/v1/offers?price.perHour.max=0.01`));
    expect(tooCheap.items.length).toBe(0);
  });

  test("liveness snapshot lists [offerKey, price]; offerKey resolves", async () => {
    const body = await jsonOf(await fetch(`${BASE}/v1/liveness`));
    expect(body.unit).toBe("GLM");
    expect(body.cols).toEqual(["offerKey", "minPricePerHour"]);
    const key = flow.offerId.slice(2, 22);
    expect(body.rows).toContainEqual([key, "0.05"]);
    expect(body.count).toBe(body.rows.length);
    // 20-hex offerKey accepted in place of the full id (§8.5)
    const byKey = await jsonOf(await fetch(`${BASE}/v1/offers/${key}`));
    expect(byKey.offerId).toBe(flow.offerId);
  });

  test("seq regression is rejected with 409", async () => {
    const { signPayload, hexToBytes } = await import("../src/crypto.ts");
    const { toIso } = await import("../src/validate.ts");
    const priv = hexToBytes("0000000000000000000000000000000000000000000000000000000000000002");
    const payload = {
      type: "terms/v1",
      providerId: flow.providerId,
      offerId: flow.offerId,
      seq: 1, // not > stored 1
      signedAt: toIso(Date.now()),
      validUntil: toIso(Date.now() + 60_000),
      unit: "GLM",
      minPricePerHour: "0.06",
    };
    const res = await fetch(`${BASE}/v1/offers/${flow.offerId}/terms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature: signPayload(payload, priv) }),
    });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).error.code).toBe("SEQ_REGRESSION");
  });

  test("foreign signature is rejected with SIG_MISMATCH", async () => {
    const { signPayload, hexToBytes } = await import("../src/crypto.ts");
    const { toIso } = await import("../src/validate.ts");
    const stranger = hexToBytes("0000000000000000000000000000000000000000000000000000000000000003");
    const payload = {
      type: "terms/v1",
      providerId: flow.providerId, // claims to be the provider…
      offerId: flow.offerId,
      seq: 99,
      signedAt: toIso(Date.now()),
      validUntil: toIso(Date.now() + 60_000),
      unit: "GLM",
      minPricePerHour: "0.01",
    };
    const res = await fetch(`${BASE}/v1/offers/${flow.offerId}/terms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature: signPayload(payload, stranger) }), // …but signs with another key
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error.code).toBe("SIG_MISMATCH");
  });

  test("revocation removes the offer from liveness; status becomes revoked", async () => {
    const { signPayload, hexToBytes } = await import("../src/crypto.ts");
    const { toIso } = await import("../src/validate.ts");
    const priv = hexToBytes("0000000000000000000000000000000000000000000000000000000000000002");
    const payload = {
      type: "revoke/v1",
      providerId: flow.providerId,
      offerId: flow.offerId,
      signedAt: toIso(Date.now()),
    };
    const res = await fetch(`${BASE}/v1/offers/${flow.offerId}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature: signPayload(payload, priv) }),
    });
    expect(res.status).toBe(200);

    const offer = await jsonOf(await fetch(`${BASE}/v1/offers/${flow.offerId}`));
    expect(offer.status).toBe("revoked");

    await Bun.sleep(120); // let the cached snapshot (50 ms ttl) roll over
    const live = await jsonOf(await fetch(`${BASE}/v1/liveness`));
    expect(live.rows).not.toContainEqual([flow.offerId.slice(2, 22), "0.05"]);
  });
});
