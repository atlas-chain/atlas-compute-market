/**
 * Generate cross-implementation test vectors for the Rust agent.
 *
 *   bun run scripts/gen-bench-vectors.ts
 *
 * Writes test/vectors/agent-vectors.json, consumed by agent/tests/vectors.rs.
 * Regenerate only when the reference implementation (src/jcs.ts, src/crypto.ts,
 * src/bench.ts) changes; the Rust port must reproduce every value byte-for-byte.
 */
import { jcs } from "../src/jcs.ts";
import { addressFromPrivateKey, bytesToHex, hexToBytes, payloadHash, signPayload } from "../src/crypto.ts";
import { computeChain, merkleLeaves, merkleRoot, proveLane, s0, sampleIndices, type LaneParams } from "../src/bench.ts";

const hex = (b: Uint8Array) => "0x" + bytesToHex(b);
const priv = hexToBytes("00".repeat(31) + "01"); // well-known dev key, vectors only
const providerId = addressFromPrivateKey(priv);

const jcsCases: unknown[] = [
  null,
  true,
  false,
  0,
  -1,
  9007199254740991, // 2^53 − 1, the integer ceiling of the wire format
  "plain",
  {},
  [],
  { b: 1, a: [1, "x", null, false], "é": "u", e: { z: 0, y: [{}] } },
  // key order is UTF-16 code units (RFC 8785): "𐀀" (U+10000, surrogate D800…)
  // sorts BEFORE "�", the opposite of code-point order
  { "�": "replacement", "𐀀": "supplementary", A: "ascii", "é": "combining" },
  { s: 'quote" back\\ slash/ ctl\b\f\n\r\t del é 😀' },
];

const cryptoPayload = {
  type: "attest-request/v1",
  providerId,
  model: "cpu/v1",
  arch: "x64",
  coreCount: 16,
  ramGib: 64,
  cpuModel: "Vector CPU (test)",
  signedAt: "2026-07-04T12:00:00.000Z",
};

function laneVector(
  seedByte: string,
  nonceByte: string,
  chalByte: string,
  laneId: string,
  workers: number,
  chainLen: number,
  checkpoints: number,
  samples: number,
) {
  const params: LaneParams = {
    seed: hexToBytes(seedByte.repeat(32)),
    laneNonce: hexToBytes(nonceByte.repeat(16)),
    providerId,
    laneId,
    chainLen,
    checkpoints,
    samples,
  };
  const challengeId = "0x" + chalByte.repeat(32);
  const chains = Array.from({ length: workers }, (_, w) => computeChain(params, w));
  const roots = chains.map((c) => merkleRoot(merkleLeaves(c)));
  return {
    params: { seed: hex(params.seed), laneNonce: hex(params.laneNonce), providerId, laneId, chainLen, checkpoints, samples },
    workers,
    challengeId,
    s0: Array.from({ length: workers }, (_, w) => hex(s0(params, w))),
    checkpoints: chains.map((c) => c.map(hex)),
    roots: roots.map(hex),
    sampledIndices: sampleIndices(challengeId, laneId, roots, samples, checkpoints),
    proofs: proveLane(params, workers, challengeId),
  };
}

const vectors = {
  jcs: jcsCases.map((value) => ({ value, canonical: jcs(value) })),
  crypto: {
    privKey: hex(priv),
    address: providerId,
    payload: cryptoPayload,
    canonical: jcs(cryptoPayload),
    digestHash: payloadHash(cryptoPayload),
    signature: signPayload(cryptoPayload, priv),
  },
  lanes: [
    laneVector("11", "22", "33", "quad", 2, 64, 8, 3),
    // C = 6 → odd merkle widths, exercises the duplicate-last rule
    laneVector("44", "55", "66", "full", 3, 24, 6, 4),
  ],
};

await Bun.write(new URL("../test/vectors/agent-vectors.json", import.meta.url), JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote test/vectors/agent-vectors.json (provider ${providerId})`);
