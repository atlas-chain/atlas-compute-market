//! Byte-for-byte parity with the TypeScript reference implementation.
//!
//! Vectors: test/vectors/agent-vectors.json, generated from src/jcs.ts,
//! src/crypto.ts and src/bench.ts by `bun run scripts/gen-bench-vectors.ts`.
//! If these tests fail after a reference change, regenerate the vectors and
//! port the change — the registry verifies exactly what the reference emits.

use atlas_agent::bench::{compute_chain, merkle_leaves, merkle_root, prove_lane, s0, sample_indices, LaneParams};
use atlas_agent::crypto::{address_from_key, hex_fixed, parse_privkey, payload_hash, sign_payload};
use atlas_agent::jcs::jcs;
use serde_json::Value;

const VECTORS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../test/vectors/agent-vectors.json"));

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("agent-vectors.json parses")
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

#[test]
fn jcs_matches_reference() {
    for (i, case) in vectors()["jcs"].as_array().expect("jcs cases").iter().enumerate() {
        let canonical = jcs(&case["value"]).unwrap_or_else(|e| panic!("jcs case {i} failed: {e}"));
        assert_eq!(canonical, case["canonical"].as_str().expect("canonical"), "jcs case {i}");
    }
}

#[test]
fn crypto_matches_reference() {
    let v = vectors();
    let c = &v["crypto"];
    let key = parse_privkey(c["privKey"].as_str().unwrap()).expect("vector privkey");

    assert_eq!(address_from_key(&key), c["address"].as_str().unwrap(), "address");
    assert_eq!(jcs(&c["payload"]).unwrap(), c["canonical"].as_str().unwrap(), "canonical payload");
    assert_eq!(payload_hash(&c["payload"]), c["digestHash"].as_str().unwrap(), "digest");
    // RFC 6979 + low-s on both sides ⇒ identical signature bytes
    assert_eq!(sign_payload(&c["payload"], &key), c["signature"].as_str().unwrap(), "signature");
}

/// Not a parity test — a local timing probe for one production-size chain
/// (chainLen 2^20, C 1024). Run: cargo test --release -- --ignored --nocapture
#[test]
#[ignore]
fn perf_single_chain() {
    let params = LaneParams {
        seed: [0x11; 32],
        lane_nonce: [0x22; 16],
        provider_id: [0x33; 20],
        lane_id: "single".to_string(),
        chain_len: 1_048_576,
        checkpoints: 1024,
        samples: 16,
    };
    let t0 = std::time::Instant::now();
    let cps = compute_chain(&params, 0);
    let ms = t0.elapsed().as_millis();
    println!("single 2^20-step chain: {ms} ms ({} checkpoints)", cps.len());
}

#[test]
fn lanes_match_reference() {
    let v = vectors();
    for lane in v["lanes"].as_array().expect("lane vectors") {
        let p = &lane["params"];
        let lane_id = p["laneId"].as_str().unwrap();
        let params = LaneParams {
            seed: hex_fixed(p["seed"].as_str().unwrap()).unwrap(),
            lane_nonce: hex_fixed(p["laneNonce"].as_str().unwrap()).unwrap(),
            provider_id: hex_fixed(p["providerId"].as_str().unwrap()).unwrap(),
            lane_id: lane_id.to_string(),
            chain_len: p["chainLen"].as_u64().unwrap() as u32,
            checkpoints: p["checkpoints"].as_u64().unwrap() as u32,
            samples: p["samples"].as_u64().unwrap() as u32,
        };
        let workers = lane["workers"].as_u64().unwrap() as u32;
        let challenge_id: [u8; 32] = hex_fixed(lane["challengeId"].as_str().unwrap()).unwrap();

        let mut roots = Vec::new();
        for w in 0..workers {
            let wu = w as usize;
            assert_eq!(
                hex0x(&s0(&params, w)),
                lane["s0"][wu].as_str().unwrap(),
                "lane {lane_id} worker {w}: s0"
            );
            let cps = compute_chain(&params, w);
            let expected: Vec<&str> = lane["checkpoints"][wu]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap())
                .collect();
            let actual: Vec<String> = cps.iter().map(|c| hex0x(c)).collect();
            assert_eq!(actual, expected, "lane {lane_id} worker {w}: checkpoints");

            let root = merkle_root(&merkle_leaves(&cps));
            assert_eq!(hex0x(&root), lane["roots"][wu].as_str().unwrap(), "lane {lane_id} worker {w}: root");
            roots.push(root);
        }

        let sampled = sample_indices(&challenge_id, lane_id, &roots, params.samples, params.checkpoints);
        let expected_sampled: Vec<u32> = lane["sampledIndices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap() as u32)
            .collect();
        assert_eq!(sampled, expected_sampled, "lane {lane_id}: sampled indices");

        let proofs = Value::Array(prove_lane(&params, workers, &challenge_id));
        assert_eq!(proofs, lane["proofs"], "lane {lane_id}: full proof JSON");
    }
}
