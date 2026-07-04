import { describe, expect, test } from "bun:test";
import { isValidPrice, parseIso, isEnvelope } from "../src/validate.ts";

describe("timestamps (§3.6)", () => {
  test("accepts the exact canonical form", () => {
    expect(parseIso("2026-06-04T08:00:00.000Z")).toBe(Date.parse("2026-06-04T08:00:00.000Z"));
  });
  test("rejects near-misses", () => {
    for (const bad of [
      "2026-06-04T08:00:00Z", // no millis
      "2026-06-04T08:00:00.0Z", // 1 fractional digit
      "2026-06-04T08:00:00.000+00:00", // offset instead of Z
      "2026-02-31T08:00:00.000Z", // impossible date
      "2026-06-04 08:00:00.000Z",
      1780560000000,
      null,
    ]) {
      expect(parseIso(bad as never)).toBeNull();
    }
  });
});

describe("minPricePerHour (§6.3)", () => {
  test("accepts spec examples", () => {
    for (const ok of ["0", "0.000123", "12345.67", "0.05", "999", "1.5"]) {
      expect(isValidPrice(ok)).toBe(true);
    }
  });
  test("rejects malformed or too long", () => {
    for (const bad of ["", "-1", "+1", "1e3", ".5", "01", "0.0000001" /* 9 chars */, "1,5", "0x1", 5]) {
      expect(isValidPrice(bad as never)).toBe(false);
    }
  });
});

describe("envelope shape (§3.4)", () => {
  test("accepts payload+signature", () => {
    expect(isEnvelope({ payload: { type: "x" }, signature: "0x" + "ab".repeat(65) })).toBe(true);
  });
  test("rejects everything else", () => {
    expect(isEnvelope({ payload: [], signature: "0x" + "ab".repeat(65) })).toBe(false);
    expect(isEnvelope({ payload: {}, signature: "0xab" })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });
});
