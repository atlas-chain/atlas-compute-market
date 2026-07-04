import { describe, expect, test } from "bun:test";
import {
  computeChain,
  laneScore,
  merkleLeaves,
  merklePath,
  merkleRoot,
  proveLane,
  s0,
  sampleIndices,
  verifyLane,
  verifyPath,
  type LaneParams,
  type WorkerProof,
} from "../src/bench.ts";
import { randomBytes, bytesToHex } from "../src/crypto.ts";

const CID = "0x" + "11".repeat(32);

function params(over: Partial<LaneParams> = {}): LaneParams {
  return {
    seed: new Uint8Array(32).fill(7),
    laneNonce: new Uint8Array(16).fill(9),
    providerId: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    laneId: "quad",
    chainLen: 4096,
    checkpoints: 64,
    samples: 8,
    ...over,
  };
}

describe("chain + merkle primitives", () => {
  test("s_0 differs per worker, lane and nonce", () => {
    const p = params();
    expect(bytesToHex(s0(p, 0))).not.toBe(bytesToHex(s0(p, 1)));
    expect(bytesToHex(s0(p, 0))).not.toBe(bytesToHex(s0(params({ laneId: "single" }), 0)));
    expect(bytesToHex(s0(p, 0))).not.toBe(
      bytesToHex(s0(params({ laneNonce: new Uint8Array(16).fill(1) }), 0)),
    );
  });

  test("checkpoints are deterministic and end at s_L", () => {
    const p = params();
    const a = computeChain(p, 0);
    const b = computeChain(p, 0);
    expect(a.length).toBe(p.checkpoints);
    expect(bytesToHex(a[p.checkpoints - 1]!)).toBe(bytesToHex(b[p.checkpoints - 1]!));
  });

  test("merkle path verification, including odd widths", () => {
    for (const n of [1, 2, 3, 64, 65]) {
      const leavesSrc = Array.from({ length: n }, () => randomBytes(32));
      const leaves = merkleLeaves(leavesSrc);
      const root = merkleRoot(leaves);
      for (const i of [0, n - 1, Math.floor(n / 2)]) {
        const path = merklePath(leaves, i);
        expect(verifyPath(leavesSrc[i]!, i, path, root)).toBe(true);
        // wrong leaf fails
        expect(verifyPath(randomBytes(32), i, path, root)).toBe(false);
      }
    }
  });

  test("sampling is deterministic, distinct, in range, root-sensitive", () => {
    const roots = [randomBytes(32), randomBytes(32)];
    const a = sampleIndices(CID, "quad", roots, 8, 64);
    const b = sampleIndices(CID, "quad", roots, 8, 64);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(8);
    expect(a.every((i) => i >= 0 && i < 64)).toBe(true);
    const c = sampleIndices(CID, "quad", [roots[1]!, roots[0]!], 8, 64);
    expect(c).not.toEqual(a);
  });
});

describe("lane prove/verify roundtrip", () => {
  test("honest 4-worker proof verifies", () => {
    const p = params();
    const proofs = proveLane(p, 4, CID);
    expect(verifyLane(p, 4, CID, proofs).ok).toBe(true);
  });

  test("skipped work is detected", () => {
    const p = params();
    const proofs = proveLane(p, 2, CID) as WorkerProof[];
    // fake: replace one worker's checkpoints with garbage but keep structure —
    // roots change, indices re-derive, recomputation must fail somewhere
    const cheat = structuredClone(proofs);
    cheat[1]!.openings.forEach((o) => {
      o.next = "0x" + bytesToHex(randomBytes(32));
    });
    expect(verifyLane(p, 2, CID, cheat).ok).toBe(false);
  });

  test("final state must be bound to the committed root", () => {
    const p = params();
    const proofs = proveLane(p, 1, CID) as WorkerProof[];
    proofs[0]!.final = "0x" + bytesToHex(randomBytes(32));
    const res = verifyLane(p, 1, CID, proofs);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("final");
  });

  test("wrong worker count / wrong s_0 rejected", () => {
    const p = params();
    const proofs = proveLane(p, 2, CID);
    expect(verifyLane(p, 3, CID, proofs).ok).toBe(false);
    const wrongNonce = params({ laneNonce: new Uint8Array(16).fill(2) });
    expect(verifyLane(wrongNonce, 2, CID, proofs).ok).toBe(false);
  });

  test("proof from another challenge does not verify", () => {
    const p = params();
    const proofs = proveLane(p, 1, CID);
    expect(verifyLane(p, 1, "0x" + "22".repeat(32), proofs).ok).toBe(false);
  });
});

describe("scoring", () => {
  test("laneScore = workers*L/sec", () => {
    expect(laneScore(4, 1_000_000, 2000)).toBe(2_000_000);
    expect(laneScore(1, 4096, 500)).toBe(8192);
  });
});
