import { describe, expect, test } from "bun:test";
import { jcs, JcsError } from "../src/jcs.ts";

describe("RFC 8785 canonicalization", () => {
  test("sorts object keys by UTF-16 code units", () => {
    expect(jcs({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // RFC 8785 §3.2.3 ordering sample (subset): code-unit order, not codepoint order
    const input = { "€": "Euro Sign", "\r": "CR", "1": "One", "": "Control", "😂": "Smiley" };
    expect(jcs(input)).toBe(
      '{"\\r":"CR","1":"One","":"Control","€":"Euro Sign","😂":"Smiley"}',
    );
  });

  test("number serialization follows ES shortest form", () => {
    expect(jcs([1, 1.5, 1e21, 1e-7, 0.000001, 10000000000000000000])).toBe(
      "[1,1.5,1e+21,1e-7,0.000001,10000000000000000000]",
    );
    expect(jcs(-0)).toBe("0");
  });

  test("string escaping", () => {
    expect(jcs("ab\n\"\\")).toBe('"a\\u0001b\\n\\"\\\\"');
  });

  test("nested structures, stable output", () => {
    const v = { z: [{ b: null, a: true }], a: "x" };
    expect(jcs(v)).toBe('{"a":"x","z":[{"a":true,"b":null}]}');
  });

  test("rejects non-JSON values", () => {
    expect(() => jcs(NaN)).toThrow(JcsError);
    expect(() => jcs(Infinity)).toThrow(JcsError);
    expect(() => jcs({ a: undefined })).toThrow(JcsError);
    expect(() => jcs(new Date())).toThrow(JcsError);
    expect(() => jcs(10n as unknown)).toThrow(JcsError);
  });
});
