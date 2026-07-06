/** Unit tests for the dev requestor simulator's pure parts (no server, no stores). */
import { describe, expect, test } from "bun:test";
import {
  SHAPES,
  requestorPersona,
  verifyOfferItem,
  checkRegistryFilters,
  type WireOfferItem,
  type JobShape,
} from "../src/dev-requestors.ts";
import { devProviderDirectory } from "../src/dev-seed.ts";
import { keccak256, addressFromPrivateKey, signPayload, payloadHash } from "../src/crypto.ts";
import { toIso } from "../src/validate.ts";
import { config } from "../src/config.ts";

const providerPriv = keccak256(new TextEncoder().encode("test-provider"));
const providerId = addressFromPrivateKey(providerPriv);
const serviceAddr = addressFromPrivateKey(config.servicePrivKey);

/** A minimal, correctly signed §8.4 offer item, as the query endpoint returns it. */
function makeItem(overrides: { coreCount?: number; ramGib?: number; full?: number; price?: string } = {}): WireOfferItem {
  const now = Date.now();
  const attestation = {
    type: "attest/cpu/v1",
    providerId,
    coreCount: overrides.coreCount ?? 16,
    ramGib: overrides.ramGib ?? 64,
    scores: { full: overrides.full ?? 9000 },
  };
  const template = { type: "offer/v1", providerId, compute: { model: "cpu/v1" }, expiresAt: toIso(now + 86_400_000) };
  const offerId = payloadHash(template);
  const terms = {
    type: "terms/v1",
    providerId,
    offerId,
    seq: 1,
    minPricePerHour: overrides.price ?? "0.10",
    validUntil: toIso(now + 60_000),
  };
  return {
    offerId,
    template: { envelope: { payload: template, signature: signPayload(template, providerPriv) } },
    attestation: { envelope: { payload: attestation, signature: signPayload(attestation, config.servicePrivKey) } },
    terms: { envelope: { payload: terms, signature: signPayload(terms, providerPriv) } },
    status: "active",
  };
}

describe("requestor personas", () => {
  test("deterministic and distinct across indices", () => {
    expect(requestorPersona(3).requestorId).toBe(requestorPersona(3).requestorId);
    expect(requestorPersona(0).requestorId).not.toBe(requestorPersona(1).requestorId);
    expect(requestorPersona(0).displayName).toBe("dev-requestor-01");
  });

  test("shape ceilings are valid price.perHour.max values (§8.4 param syntax, ≤8 chars)", () => {
    for (const s of SHAPES) {
      expect(s.maxPricePerHour).toMatch(/^\d+(\.\d+)?$/);
      expect(s.maxPricePerHour.length).toBeLessThanOrEqual(8);
      expect(["price", "score.full"]).toContain(s.sort);
    }
  });
});

describe("client-side verification (§9 step 2)", () => {
  test("accepts a properly signed item", () => {
    expect(verifyOfferItem(makeItem(), serviceAddr, Date.now())).toBeNull();
  });

  test("rejects a tampered terms price", () => {
    const item = makeItem();
    (item.terms!.envelope.payload as { minPricePerHour: string }).minPricePerHour = "0.01";
    expect(verifyOfferItem(item, serviceAddr, Date.now())).toContain("terms signature");
  });

  test("rejects an attestation not signed by the service", () => {
    const item = makeItem();
    item.attestation.envelope.signature = signPayload(item.attestation.envelope.payload, providerPriv);
    expect(verifyOfferItem(item, serviceAddr, Date.now())).toContain("service key");
  });

  test("rejects missing or expired terms", () => {
    const noTerms = makeItem();
    noTerms.terms = null;
    expect(verifyOfferItem(noTerms, serviceAddr, Date.now())).toContain("no dynamic terms");

    const expired = makeItem();
    (expired.terms!.envelope.payload as { validUntil: string }).validUntil = toIso(Date.now() - 1000);
    // note: mutating validUntil also breaks the signature, so re-sign to isolate the expiry check
    expired.terms!.envelope.signature = signPayload(expired.terms!.envelope.payload, providerPriv);
    expect(verifyOfferItem(expired, serviceAddr, Date.now())).toContain("expired");
  });
});

describe("registry filter cross-check", () => {
  const shape: JobShape = {
    shape: "t",
    filters: { "cores.min": 8, "ram.gib.min": 32, "score.full.min": 5000 },
    maxPricePerHour: "0.25",
    sort: "price",
    runMs: [1, 2],
    idleMs: [1, 2],
    retryMs: [1, 2],
  };

  test("passes an item that honors filters and ceiling", () => {
    expect(checkRegistryFilters(makeItem(), shape)).toBeNull();
  });

  test("flags violations of each floor and of the price ceiling", () => {
    expect(checkRegistryFilters(makeItem({ coreCount: 4 }), shape)).toContain("cores.min");
    expect(checkRegistryFilters(makeItem({ ramGib: 16 }), shape)).toContain("ram.gib.min");
    expect(checkRegistryFilters(makeItem({ full: 100 }), shape)).toContain("score.full.min");
    expect(checkRegistryFilters(makeItem({ price: "0.50" }), shape)).toContain("ceiling");
  });
});

describe("dev provider directory", () => {
  test("matches the dev-seed persona formula, including the offline cadence", () => {
    const dir = devProviderDirectory(10);
    expect(dir.size).toBe(10);
    const infos = [...dir.values()];
    expect(infos[0]!.displayName).toBe("dev-dummy-01");
    // behaviors cycle steady,steady,steady,flaky,offline
    expect(infos[3]!.behavior).toBe("flaky");
    expect(infos[4]!.behavior).toBe("offline");
    expect(infos[9]!.behavior).toBe("offline");
  });
});
