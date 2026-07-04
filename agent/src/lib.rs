//! Atlas Compute Market provider agent.
//!
//! Rust port of the reference provider implementation:
//!   - `jcs`    ⇄ src/jcs.ts     (RFC 8785 canonical JSON)
//!   - `crypto` ⇄ src/crypto.ts  (payload digest, r‖s‖v signatures, addresses)
//!   - `bench`  ⇄ src/bench.ts   (benchmark work function, commitment, proofs)
//!   - `api`    — HTTP client for the registry flow of scripts/bench-client.ts
//!
//! Byte-for-byte parity with the TypeScript reference is enforced by
//! tests/vectors.rs against test/vectors/agent-vectors.json.

pub mod api;
pub mod bench;
pub mod crypto;
pub mod jcs;
