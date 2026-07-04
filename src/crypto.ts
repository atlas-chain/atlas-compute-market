/**
 * Identity, hashing and signatures (spec §3).
 *
 * digest    = keccak256("\x19Atlas Compute v1:\n" || jcs(payload))
 * signature = 65 bytes r‖s‖v  (v = 0/1; 27/28 accepted and normalized)
 * address   = "0x" + last 20 bytes of keccak256(uncompressedPubkey[1:])
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";
import { jcsBytes } from "./jcs.ts";

export const DOMAIN_PREFIX = new TextEncoder().encode("\x19Atlas Compute v1:\n");

export { keccak_256 as keccak256, bytesToHex, hexToBytes, concatBytes };

/** keccak256(prefix || jcs(payload)) — both the signing digest and the object hash. */
export function payloadDigest(payload: unknown): Uint8Array {
  return keccak_256(concatBytes(DOMAIN_PREFIX, jcsBytes(payload)));
}

/** Content-address of a payload: "0x" + hex of payloadDigest. */
export function payloadHash(payload: unknown): string {
  return "0x" + bytesToHex(payloadDigest(payload));
}

export function addressFromPrivateKey(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false);
  return "0x" + bytesToHex(keccak_256(pub.slice(1)).slice(12));
}

/** Sign a payload object; returns "0x" + 130 hex chars (r‖s‖v, v∈{0,1}). */
export function signPayload(payload: unknown, priv: Uint8Array): string {
  const digest = payloadDigest(payload);
  // noble v2 "recovered" format puts the recovery byte FIRST; spec wants r‖s‖v.
  // (options cast: noble's published types lag the runtime `format` option)
  const sig = secp256k1.sign(digest, priv, { prehash: false, format: "recovered" } as never) as Uint8Array;
  const rsv = concatBytes(sig.slice(1), sig.slice(0, 1));
  return "0x" + bytesToHex(rsv);
}

/**
 * Recover the signer address of a payload from an r‖s‖v signature.
 * Returns the lowercase 0x-address, or null if the signature is unparseable.
 */
export function recoverSigner(payload: unknown, signatureHex: string): string | null {
  const digest = payloadDigest(payload);
  return recoverSignerOfDigest(digest, signatureHex);
}

export function recoverSignerOfDigest(digest: Uint8Array, signatureHex: string): string | null {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signatureHex)) return null;
  const rsv = hexToBytes(signatureHex.slice(2));
  let v = rsv[64]!;
  if (v === 27 || v === 28) v -= 27;
  if (v !== 0 && v !== 1) return null;
  // back to noble's recovery-byte-first layout
  const nobleSig = concatBytes(new Uint8Array([v]), rsv.slice(0, 64));
  try {
    const compressed = secp256k1.recoverPublicKey(nobleSig, digest, {
      prehash: false,
      format: "recovered",
    } as never) as Uint8Array;
    const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
    return "0x" + bytesToHex(keccak_256(uncompressed.slice(1)).slice(12));
  } catch {
    return null;
  }
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
