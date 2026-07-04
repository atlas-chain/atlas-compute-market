/**
 * Benchmark work function, commitment and verification (spec §5).
 *
 * This module is both the server-side verifier and the reference prover
 * (used by tests and scripts/bench-client.ts, and the contract for the
 * future Rust provider agent).
 *
 * Pinned constructions (spec §5.1/§5.4 leave these to the reference impl):
 *
 *  - s_0 preimage: seed(32) ‖ laneNonce(16) ‖ providerId(raw 20) ‖
 *    laneId(ASCII) ‖ workerIndex(uint32 BE).
 *  - Checkpoints: C values c_1..c_C where c_j = state after j·(L/C) steps,
 *    so c_C = s_L (the final state). c_0 = s_0 is NOT in the tree — the
 *    verifier derives it from the seed. L must be divisible by C.
 *  - Merkle tree over the C checkpoints: leaf = keccak256(0x00 ‖ c_j),
 *    node = keccak256(0x01 ‖ left ‖ right), duplicate-last for odd widths.
 *    Leaf index of c_j is j-1.
 *  - Fiat–Shamir sampling: h = keccak256(challengeId(32) ‖ laneId(ASCII) ‖
 *    root_0 ‖ … ‖ root_{workers-1}) (roots in workerIndex order); indices
 *    are drawn as keccak256(h ‖ uint32 BE counter) → first 4 bytes BE
 *    mod C, skipping duplicates, until K distinct segment indices.
 *    The same K indices apply to every worker of the lane.
 *  - An opening for segment j proves c_j → c_{j+1}: it carries prev
 *    (c_j; for j=0 this is s_0 and has no path), prevPath, next (c_{j+1})
 *    and nextPath. In addition every worker proves its final state with a
 *    path for leaf C-1, binding `final` to the committed root.
 *  - Segment 0 is ALWAYS opened, in addition to the K sampled segments
 *    (required opening list = [0] ∪ sampled). Without this, a chain not
 *    anchored at s_0 — i.e. not bound to the seed/nonce/provider — would
 *    pass whenever segment 0 escapes the sample.
 *
 * NOTE (spec §5.4 / review): the Fiat–Shamir sampling here is grindable by
 * a cheating prover regenerating fake checkpoints; the protocol will move
 * to server-issued indices in a later revision. Implemented as specced.
 */
import { keccak256, bytesToHex, hexToBytes, concatBytes } from "./crypto.ts";

export interface LaneParams {
  seed: Uint8Array; // 32 bytes, per challenge
  laneNonce: Uint8Array; // 16 bytes, per lane (issued at /start)
  providerId: string; // 0x-address
  laneId: string;
  chainLen: number; // L
  checkpoints: number; // C, divides L
  samples: number; // K
}

export interface Opening {
  seg: number; // segment index j in [0, C)
  prev: string; // 0x… c_j (s_0 when j=0)
  prevPath: string[] | null; // merkle path for leaf j-1; null when j=0
  next: string; // 0x… c_{j+1}
  nextPath: string[]; // merkle path for leaf j
}

export interface WorkerProof {
  workerIndex: number;
  root: string; // 0x… merkle root over c_1..c_C
  final: string; // 0x… s_L (== c_C)
  finalPath: string[]; // merkle path for leaf C-1
  openings: Opening[];
}

const LEAF_TAG = new Uint8Array([0x00]);
const NODE_TAG = new Uint8Array([0x01]);

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function s0(p: LaneParams, workerIndex: number): Uint8Array {
  return keccak256(
    concatBytes(
      p.seed,
      p.laneNonce,
      hexToBytes(p.providerId.slice(2)),
      new TextEncoder().encode(p.laneId),
      u32be(workerIndex),
    ),
  );
}

/** Run one worker's chain; returns the C checkpoint states c_1..c_C. */
export function computeChain(p: LaneParams, workerIndex: number): Uint8Array[] {
  const { chainLen: L, checkpoints: C } = p;
  if (L % C !== 0) throw new Error("chainLen must be divisible by checkpoints");
  const segLen = L / C;
  let state = s0(p, workerIndex);
  const cps: Uint8Array[] = [];
  for (let j = 0; j < C; j++) {
    for (let k = 0; k < segLen; k++) state = keccak256(state);
    cps.push(state);
  }
  return cps;
}

// ---------------------------------------------------------------- merkle

export function merkleLeaves(checkpoints: Uint8Array[]): Uint8Array[] {
  return checkpoints.map((c) => keccak256(concatBytes(LEAF_TAG, c)));
}

export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  let level = leaves;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left; // duplicate-last
      next.push(keccak256(concatBytes(NODE_TAG, left, right)));
    }
    level = next;
  }
  return level[0]!;
}

export function merklePath(leaves: Uint8Array[], index: number): Uint8Array[] {
  const path: Uint8Array[] = [];
  let level = leaves;
  let idx = index;
  while (level.length > 1) {
    const sibling = idx % 2 === 0 ? (level[idx + 1] ?? level[idx]!) : level[idx - 1]!;
    path.push(sibling);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      next.push(keccak256(concatBytes(NODE_TAG, left, right)));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return path;
}

export function verifyPath(
  checkpoint: Uint8Array,
  index: number,
  path: Uint8Array[],
  root: Uint8Array,
): boolean {
  let node = keccak256(concatBytes(LEAF_TAG, checkpoint));
  let idx = index;
  for (const sibling of path) {
    node =
      idx % 2 === 0
        ? keccak256(concatBytes(NODE_TAG, node, sibling))
        : keccak256(concatBytes(NODE_TAG, sibling, node));
    idx = Math.floor(idx / 2);
  }
  return bytesToHex(node) === bytesToHex(root) && idx === 0;
}

// ------------------------------------------------------------- sampling

/** Fiat–Shamir segment indices: K distinct values in [0, C). */
export function sampleIndices(
  challengeId: string,
  laneId: string,
  rootsInWorkerOrder: Uint8Array[],
  K: number,
  C: number,
): number[] {
  const h = keccak256(
    concatBytes(hexToBytes(challengeId.slice(2)), new TextEncoder().encode(laneId), ...rootsInWorkerOrder),
  );
  const out: number[] = [];
  const seen = new Set<number>();
  for (let ctr = 0; out.length < Math.min(K, C); ctr++) {
    const digest = keccak256(concatBytes(h, u32be(ctr)));
    const idx = new DataView(digest.buffer, digest.byteOffset).getUint32(0, false) % C;
    if (!seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}

/** Segment 0 is always opened so every chain is anchored at s_0. */
export function requiredSegments(sampled: number[]): number[] {
  return [0, ...sampled.filter((j) => j !== 0)];
}

// --------------------------------------------------------------- prover

/** Build a full lane proof (reference prover — tests, bench client, Rust-port contract). */
export function proveLane(p: LaneParams, workers: number, challengeId: string): WorkerProof[] {
  const perWorker = [];
  for (let w = 0; w < workers; w++) {
    const cps = computeChain(p, w);
    const leaves = merkleLeaves(cps);
    perWorker.push({ cps, leaves, root: merkleRoot(leaves) });
  }
  const sampled = sampleIndices(
    challengeId,
    p.laneId,
    perWorker.map((x) => x.root),
    p.samples,
    p.checkpoints,
  );
  const indices = requiredSegments(sampled);
  const hex = (b: Uint8Array) => "0x" + bytesToHex(b);
  return perWorker.map((x, w) => {
    const C = p.checkpoints;
    const openings: Opening[] = indices.map((j) => ({
      seg: j,
      prev: hex(j === 0 ? s0(p, w) : x.cps[j - 1]!),
      prevPath: j === 0 ? null : merklePath(x.leaves, j - 1).map(hex),
      next: hex(x.cps[j]!),
      nextPath: merklePath(x.leaves, j).map(hex),
    }));
    return {
      workerIndex: w,
      root: hex(x.root),
      final: hex(x.cps[C - 1]!),
      finalPath: merklePath(x.leaves, C - 1).map(hex),
      openings,
    };
  });
}

// ------------------------------------------------------------- verifier

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

const HEX32_RE = /^0x[0-9a-f]{64}$/;

/**
 * Verify a lane submission. Cost ≈ workers × K × (L/C) hashes plus
 * O(workers × K × log C) path checks.
 */
export function verifyLane(p: LaneParams, workers: number, challengeId: string, proofs: unknown): VerifyResult {
  if (!Array.isArray(proofs) || proofs.length !== workers) {
    return { ok: false, reason: `expected ${workers} worker proofs` };
  }
  const C = p.checkpoints;
  const segLen = p.chainLen / C;

  // structural pass + collect roots in workerIndex order
  const roots: Uint8Array[] = [];
  for (let w = 0; w < workers; w++) {
    const wp = proofs[w] as WorkerProof;
    if (
      !wp ||
      wp.workerIndex !== w ||
      typeof wp.root !== "string" ||
      !HEX32_RE.test(wp.root) ||
      typeof wp.final !== "string" ||
      !HEX32_RE.test(wp.final) ||
      !Array.isArray(wp.finalPath) ||
      !Array.isArray(wp.openings)
    ) {
      return { ok: false, reason: `worker ${w}: malformed proof` };
    }
    roots.push(hexToBytes(wp.root.slice(2)));
  }

  const expected = requiredSegments(sampleIndices(challengeId, p.laneId, roots, p.samples, C));

  for (let w = 0; w < workers; w++) {
    const wp = proofs[w] as WorkerProof;
    const root = roots[w]!;

    // final state must be leaf C-1 of the committed tree
    const finalState = hexToBytes(wp.final.slice(2));
    if (!verifyPath(finalState, C - 1, wp.finalPath.map((h) => hexToBytes(h.slice(2))), root)) {
      return { ok: false, reason: `worker ${w}: final state not bound to root` };
    }

    if (wp.openings.length !== expected.length) {
      return { ok: false, reason: `worker ${w}: expected ${expected.length} openings` };
    }
    for (let i = 0; i < expected.length; i++) {
      const j = expected[i]!;
      const op = wp.openings[i]!;
      if (op.seg !== j || !HEX32_RE.test(op.prev) || !HEX32_RE.test(op.next)) {
        return { ok: false, reason: `worker ${w}: opening ${i} malformed or wrong segment` };
      }
      const prev = hexToBytes(op.prev.slice(2));
      const next = hexToBytes(op.next.slice(2));

      if (j === 0) {
        // c_0 = s_0 is derived, not committed
        if (op.prev !== "0x" + bytesToHex(s0(p, w))) {
          return { ok: false, reason: `worker ${w}: segment 0 start != s_0` };
        }
      } else {
        if (!op.prevPath || !verifyPath(prev, j - 1, op.prevPath.map((h) => hexToBytes(h.slice(2))), root)) {
          return { ok: false, reason: `worker ${w}: segment ${j} start not in tree` };
        }
      }
      if (!verifyPath(next, j, op.nextPath.map((h) => hexToBytes(h.slice(2))), root)) {
        return { ok: false, reason: `worker ${w}: segment ${j} end not in tree` };
      }

      // recompute the segment
      let state = prev;
      for (let k = 0; k < segLen; k++) state = keccak256(state);
      if (bytesToHex(state) !== bytesToHex(next)) {
        return { ok: false, reason: `worker ${w}: segment ${j} recomputation mismatch` };
      }
    }
  }
  return { ok: true };
}

/** score(lane) = workers × L / elapsedSeconds, rounded (§5.2). */
export function laneScore(workers: number, chainLen: number, elapsedMs: number): number {
  return Math.round((workers * chainLen) / (elapsedMs / 1000));
}
