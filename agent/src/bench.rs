//! Benchmark work function, commitment and proof — port of the reference
//! prover in src/bench.ts (spec §5; pinned constructions per its header):
//!
//!  - s_0 preimage: seed(32) ‖ laneNonce(16) ‖ providerId(raw 20) ‖
//!    laneId(ASCII) ‖ workerIndex(uint32 BE).
//!  - Checkpoints c_1..c_C, c_j = state after j·(L/C) keccak256 steps.
//!  - Merkle: leaf = keccak256(0x00 ‖ c_j) at index j−1,
//!    node = keccak256(0x01 ‖ left ‖ right), duplicate-last for odd widths.
//!  - Fiat–Shamir indices from keccak256(challengeId ‖ laneId ‖ roots…),
//!    counter-extended, first 4 bytes BE mod C, distinct, K draws.
//!  - Openings in required order [0] ∪ sampled; segment 0 anchors s_0.
//!
//! The chains are the timed workload: one OS thread per worker.

use crate::crypto::{keccak256, keccak256_concat};
use serde_json::{json, Value};

pub struct LaneParams {
    pub seed: [u8; 32],
    pub lane_nonce: [u8; 16],
    pub provider_id: [u8; 20],
    pub lane_id: String,
    pub chain_len: u32,
    pub checkpoints: u32,
    pub samples: u32,
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn path_json(path: &[[u8; 32]]) -> Value {
    Value::Array(path.iter().map(|p| Value::String(hex0x(p))).collect())
}

pub fn s0(p: &LaneParams, worker_index: u32) -> [u8; 32] {
    keccak256_concat(&[
        &p.seed,
        &p.lane_nonce,
        &p.provider_id,
        p.lane_id.as_bytes(),
        &worker_index.to_be_bytes(),
    ])
}

/// Run one worker's chain; returns the C checkpoint states c_1..c_C.
pub fn compute_chain(p: &LaneParams, worker_index: u32) -> Vec<[u8; 32]> {
    assert!(
        p.chain_len % p.checkpoints == 0,
        "chainLen must be divisible by checkpoints"
    );
    let seg_len = p.chain_len / p.checkpoints;
    let mut state = s0(p, worker_index);
    let mut cps = Vec::with_capacity(p.checkpoints as usize);
    for _ in 0..p.checkpoints {
        for _ in 0..seg_len {
            state = keccak256(&state);
        }
        cps.push(state);
    }
    cps
}

// ---------------------------------------------------------------- merkle

pub fn merkle_leaves(checkpoints: &[[u8; 32]]) -> Vec<[u8; 32]> {
    checkpoints.iter().map(|c| keccak256_concat(&[&[0u8], c])).collect()
}

pub fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut level = leaves.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for i in (0..level.len()).step_by(2) {
            let left = level[i];
            let right = *level.get(i + 1).unwrap_or(&left); // duplicate-last
            next.push(keccak256_concat(&[&[1u8], &left, &right]));
        }
        level = next;
    }
    level[0]
}

pub fn merkle_path(leaves: &[[u8; 32]], index: usize) -> Vec<[u8; 32]> {
    let mut path = Vec::new();
    let mut level = leaves.to_vec();
    let mut idx = index;
    while level.len() > 1 {
        let sibling = if idx % 2 == 0 {
            *level.get(idx + 1).unwrap_or(&level[idx])
        } else {
            level[idx - 1]
        };
        path.push(sibling);
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        for i in (0..level.len()).step_by(2) {
            let left = level[i];
            let right = *level.get(i + 1).unwrap_or(&left);
            next.push(keccak256_concat(&[&[1u8], &left, &right]));
        }
        level = next;
        idx /= 2;
    }
    path
}

// ------------------------------------------------------------- sampling

/// Fiat–Shamir segment indices: K distinct values in [0, C).
pub fn sample_indices(challenge_id: &[u8; 32], lane_id: &str, roots: &[[u8; 32]], k: u32, c: u32) -> Vec<u32> {
    let mut parts: Vec<&[u8]> = vec![challenge_id, lane_id.as_bytes()];
    for r in roots {
        parts.push(r);
    }
    let h = keccak256_concat(&parts);
    let target = k.min(c) as usize;
    let mut out = Vec::with_capacity(target);
    let mut seen = std::collections::HashSet::new();
    let mut ctr: u32 = 0;
    while out.len() < target {
        let d = keccak256_concat(&[&h, &ctr.to_be_bytes()]);
        let idx = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % c;
        if seen.insert(idx) {
            out.push(idx);
        }
        ctr += 1;
    }
    out
}

/// Segment 0 is always opened so every chain is anchored at s_0.
pub fn required_segments(sampled: &[u32]) -> Vec<u32> {
    let mut v = vec![0u32];
    v.extend(sampled.iter().copied().filter(|&j| j != 0));
    v
}

// --------------------------------------------------------------- prover

/// Build a full lane proof. Chains run on one thread per worker; the JSON
/// matches the reference proveLane output field-for-field (WorkerProof[]).
pub fn prove_lane(p: &LaneParams, workers: u32, challenge_id: &[u8; 32]) -> Vec<Value> {
    let per_worker: Vec<(Vec<[u8; 32]>, Vec<[u8; 32]>, [u8; 32])> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|w| {
                scope.spawn(move || {
                    let cps = compute_chain(p, w);
                    let leaves = merkle_leaves(&cps);
                    let root = merkle_root(&leaves);
                    (cps, leaves, root)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().expect("worker thread panicked")).collect()
    });

    let roots: Vec<[u8; 32]> = per_worker.iter().map(|x| x.2).collect();
    let sampled = sample_indices(challenge_id, &p.lane_id, &roots, p.samples, p.checkpoints);
    let indices = required_segments(&sampled);
    let c = p.checkpoints as usize;

    per_worker
        .iter()
        .enumerate()
        .map(|(w, (cps, leaves, root))| {
            let openings: Vec<Value> = indices
                .iter()
                .map(|&j| {
                    let ju = j as usize;
                    json!({
                        "seg": j,
                        "prev": if j == 0 { hex0x(&s0(p, w as u32)) } else { hex0x(&cps[ju - 1]) },
                        "prevPath": if j == 0 { Value::Null } else { path_json(&merkle_path(leaves, ju - 1)) },
                        "next": hex0x(&cps[ju]),
                        "nextPath": path_json(&merkle_path(leaves, ju)),
                    })
                })
                .collect();
            json!({
                "workerIndex": w,
                "root": hex0x(root),
                "final": hex0x(&cps[c - 1]),
                "finalPath": path_json(&merkle_path(leaves, c - 1)),
                "openings": openings,
            })
        })
        .collect()
}
