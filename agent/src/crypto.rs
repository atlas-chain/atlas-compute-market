//! Identity, hashing and signatures — port of src/crypto.ts (spec §3).
//!
//! digest    = keccak256("\x19Atlas Compute v1:\n" || jcs(payload))
//! signature = 65 bytes r‖s‖v (v ∈ {0,1}), 0x-hex on the wire
//! address   = "0x" + last 20 bytes of keccak256(uncompressedPubkey[1:])
//!
//! Signatures are RFC 6979 deterministic with low-s normalization on both
//! sides (noble v2 ⇄ k256), so the reference and this port produce
//! identical bytes for identical payloads — asserted by tests/vectors.rs.

use k256::ecdsa::SigningKey;
use serde_json::Value;
use tiny_keccak::{Hasher, Keccak};

pub const DOMAIN_PREFIX: &[u8] = b"\x19Atlas Compute v1:\n";

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    keccak256_concat(&[data])
}

pub fn keccak256_concat(parts: &[&[u8]]) -> [u8; 32] {
    let mut k = Keccak::v256();
    for p in parts {
        k.update(p);
    }
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

pub fn payload_digest(payload: &Value) -> [u8; 32] {
    let canon = crate::jcs::jcs(payload).expect("signed payloads must be JCS-serializable plain data");
    keccak256_concat(&[DOMAIN_PREFIX, canon.as_bytes()])
}

/// Content-address of a payload: "0x" + hex of payload_digest.
pub fn payload_hash(payload: &Value) -> String {
    format!("0x{}", hex::encode(payload_digest(payload)))
}

/// Sign a payload; returns "0x" + 130 hex chars (r‖s‖v, v ∈ {0,1}).
pub fn sign_payload(payload: &Value, key: &SigningKey) -> String {
    let (sig, recid) = key
        .sign_prehash_recoverable(&payload_digest(payload))
        .expect("signing an in-range digest cannot fail");
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = recid.to_byte();
    format!("0x{}", hex::encode(out))
}

pub fn address_from_key(key: &SigningKey) -> String {
    let point = key.verifying_key().to_encoded_point(false);
    let h = keccak256(&point.as_bytes()[1..]);
    format!("0x{}", hex::encode(&h[12..]))
}

pub fn parse_privkey(hex_str: &str) -> Result<SigningKey, String> {
    let raw = hex::decode(hex_str.trim().trim_start_matches("0x")).map_err(|e| format!("privkey is not hex: {e}"))?;
    SigningKey::from_slice(&raw).map_err(|e| format!("invalid secp256k1 private key: {e}"))
}

/// Decode "0x…"/"…" hex into a fixed-size array (seeds, nonces, ids).
pub fn hex_fixed<const N: usize>(s: &str) -> Result<[u8; N], String> {
    let raw = hex::decode(s.trim_start_matches("0x")).map_err(|e| format!("bad hex {s:?}: {e}"))?;
    raw.try_into().map_err(|_| format!("expected {N} bytes in {s:?}"))
}
