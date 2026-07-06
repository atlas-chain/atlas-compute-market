export function shortHex(hex: string, head = 8, tail = 4): string {
  if (hex.length <= head + tail + 3) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function untilShort(iso: string): string {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (s <= 0) return "expired";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtGib(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} TiB` : `${fmtInt(Math.round(n))} GiB`;
}

export function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n < 0.01 ? n.toPrecision(2) : n.toFixed(n < 1 ? 3 : 2);
}

/** Accumulated GLM amounts (sim spend/earnings) — more precision than prices. */
export function fmtGlm(n: number): string {
  if (n === 0) return "0";
  if (n < 0.001) return n.toPrecision(2);
  return n.toFixed(n < 10 ? 4 : 2);
}

/** GLM accrued so far by a running job: price/h × elapsed time. */
export function accruing(pricePerHour: string, sinceIso: string): number {
  return (Number(pricePerHour) * Math.max(0, Date.now() - Date.parse(sinceIso))) / 3_600_000;
}

/**
 * A provider's market state, derived from its live/busy offer counts:
 * busy = ≥ 1 live offer flagged taken (avail/v1), free = live and unflagged.
 */
export function providerStatus(
  liveOffers: number,
  busyOffers: number,
  lastSeenAt: string | null,
): { label: string; cls: string } {
  if (busyOffers > 0) return { label: liveOffers > busyOffers ? "partly busy" : "busy", cls: "busy" };
  if (liveOffers > 0) return { label: "free", cls: "active" };
  if (lastSeenAt) return { label: "stale", cls: "stale" };
  return { label: "offline", cls: "" };
}
