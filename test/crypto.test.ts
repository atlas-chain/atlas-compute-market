import { describe, expect, test } from "bun:test";
import {
  addressFromPrivateKey,
  hexToBytes,
  payloadHash,
  recoverSigner,
  signPayload,
} from "../src/crypto.ts";

const PRIV1 = hexToBytes("0000000000000000000000000000000000000000000000000000000000000001");
const PRIV2 = hexToBytes("0000000000000000000000000000000000000000000000000000000000000002");

describe("identity & signatures", () => {
  test("address derivation matches Ethereum scheme (known vector)", () => {
    expect(addressFromPrivateKey(PRIV1)).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    expect(addressFromPrivateKey(PRIV2)).toBe("0x2b5ad5c4795c026514f8317c7a215e218dccd6cf");
  });

  test("sign → recover roundtrip", () => {
    const payload = { type: "profile/v1", providerId: addressFromPrivateKey(PRIV1), n: 42 };
    const sig = signPayload(payload, PRIV1);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(recoverSigner(payload, sig)).toBe(addressFromPrivateKey(PRIV1));
  });

  test("recovery is sensitive to payload changes", () => {
    const payload = { a: 1 };
    const sig = signPayload(payload, PRIV1);
    expect(recoverSigner({ a: 2 }, sig)).not.toBe(addressFromPrivateKey(PRIV1));
  });

  test("accepts v=27/28 encoding", () => {
    const payload = { a: 1 };
    const sig = signPayload(payload, PRIV1);
    const v = parseInt(sig.slice(-2), 16) + 27;
    const sig27 = sig.slice(0, -2) + v.toString(16);
    expect(recoverSigner(payload, sig27)).toBe(addressFromPrivateKey(PRIV1));
  });

  test("payload hash is canonical (key order does not matter)", () => {
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
    expect(payloadHash({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("malformed signatures return null, not throw", () => {
    expect(recoverSigner({ a: 1 }, "0xzz")).toBeNull();
    expect(recoverSigner({ a: 1 }, "0x" + "00".repeat(65))).toBeNull();
  });
});
