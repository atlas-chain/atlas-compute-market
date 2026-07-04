/**
 * RFC 8785 (JCS) canonical JSON serialization.
 *
 * Accepts only JSON-representable values: plain objects, arrays, strings,
 * finite numbers, booleans, null. Anything else (undefined, functions,
 * symbols, BigInt, NaN, ±Infinity, class instances with toJSON, Dates)
 * is rejected — signed payloads must be plain data.
 *
 * Key ordering is by UTF-16 code units, which is exactly the default
 * behavior of Array.prototype.sort() on strings. String escaping and
 * number formatting delegate to JSON.stringify, whose output for strings
 * and finite numbers is RFC 8785-compliant (shortest-form ES number
 * serialization, two-char escapes, lowercase \u00xx for control chars).
 */

export function jcs(value: unknown): string {
  return serialize(value);
}

export function jcsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(serialize(value));
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new JcsError("non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new JcsError(`unsupported type: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(serialize).join(",") + "]";
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new JcsError("only plain objects are allowed");
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) throw new JcsError(`undefined value at key "${k}"`);
    parts.push(JSON.stringify(k) + ":" + serialize(v));
  }
  return "{" + parts.join(",") + "}";
}

export class JcsError extends Error {}
