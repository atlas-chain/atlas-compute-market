/** Field validators shared across endpoints (spec §3.6, §6). */

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// non-negative decimal: "0", "12", "0.05", "12345.67" — no leading zeros, no sign, no exponent
const PRICE_RE = /^(0|[1-9]\d*)(\.\d+)?$/;

export const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
export const HASH_RE = /^0x[0-9a-f]{64}$/;
export const OFFER_KEY_RE = /^[0-9a-f]{20}$/; // 80-bit truncated offerId (§8.5)

/** Parse a spec timestamp (strict YYYY-MM-DDThh:mm:ss.sssZ) to unix ms, or null. */
export function parseIso(s: unknown): number | null {
  if (typeof s !== "string" || !ISO_RE.test(s)) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  // round-trip to reject impossible dates like 2026-02-31
  if (new Date(ms).toISOString() !== s) return null;
  return ms;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** minPricePerHour: non-negative decimal string, at most 8 characters (§6.3). */
export function isValidPrice(s: unknown): s is string {
  return typeof s === "string" && s.length <= 8 && PRICE_RE.test(s);
}

export function isAddress(s: unknown): s is string {
  return typeof s === "string" && ADDRESS_RE.test(s);
}

export function isHash(s: unknown): s is string {
  return typeof s === "string" && HASH_RE.test(s);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Envelope shape check (§3.4). */
export function isEnvelope(v: unknown): v is { payload: Record<string, unknown>; signature: string } {
  return (
    isPlainObject(v) &&
    isPlainObject(v.payload) &&
    typeof v.signature === "string" &&
    /^0x[0-9a-fA-F]{130}$/.test(v.signature)
  );
}

export function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}
