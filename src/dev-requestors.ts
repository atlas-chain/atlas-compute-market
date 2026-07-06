/**
 * Dev-only simulated requestors (ATLAS_DEV_REQUESTORS=N, default 0 = off).
 *
 * Each persona is an executable reference client for the requestor flow (§9),
 * run against the service's own HTTP API: query offers with its job shape's
 * filters, verify template/terms provider-signatures and the attestation
 * service-signature client-side, select candidates within its price ceiling,
 * then simulate the P2P hire-time probe. Matching stays client-side — the
 * registry never learns about agreements — mirroring the real market design.
 *
 * The dummies' endpoints are `.invalid`, so no connection is dialed; the
 * probe outcome is derived from the target provider persona's liveness
 * behavior (steady accepts, flaky ~half, offline never). Because personas
 * exercise the read path continuously, they double as an end-to-end check:
 * any of the following is a registry bug and is logged as `BUG`:
 *   - an envelope whose signature does not verify (§8.4 says clients drop it),
 *   - a result violating the requested filters or price ceiling,
 *   - an offline provider appearing under freshness=normal (§10).
 *
 * Rules every persona obeys:
 *   - only ever selects dev-seed dummy providers, never a real one;
 *   - never selects above its shape's maxPricePerHour ceiling;
 *   - verifies all three signatures before considering a candidate;
 *   - respects rate limits (honors retryAfterMs on 429);
 *   - staggered, jittered scheduling — no synchronized query bursts.
 *
 * State is in-memory only (the simulator lives in the service process) and
 * surfaces through GET /v1/stats as `demandSim` when the flag is set.
 */
import { config } from "./config.ts";
import { keccak256, addressFromPrivateKey, recoverSigner } from "./crypto.ts";
import { toIso } from "./validate.ts";
import { devProviderDirectory, type DevProviderInfo } from "./dev-seed.ts";

export interface JobShape {
  shape: string;
  filters: { "cores.min"?: number; "ram.gib.min"?: number; "score.full.min"?: number };
  /** Ceiling sent as price.perHour.max and enforced again client-side. */
  maxPricePerHour: string;
  sort: "price" | "score.full";
  runMs: [number, number];
  idleMs: [number, number];
  retryMs: [number, number];
}

// Ceilings are tuned against the dev-seed price formula so the market shows
// both outcomes: most shapes overlap some dummy floors, tiny-cron only
// clears the very cheapest on a lucky jitter (exercises the no-match path).
export const SHAPES: JobShape[] = [
  { shape: "ci-runner", filters: { "cores.min": 8, "ram.gib.min": 16 }, maxPricePerHour: "0.25", sort: "price", runMs: [45_000, 120_000], idleMs: [10_000, 30_000], retryMs: [15_000, 30_000] },
  { shape: "render-batch", filters: { "cores.min": 32, "score.full.min": 8000 }, maxPricePerHour: "1.5", sort: "score.full", runMs: [120_000, 300_000], idleMs: [30_000, 90_000], retryMs: [20_000, 40_000] },
  { shape: "tiny-cron", filters: { "cores.min": 2 }, maxPricePerHour: "0.03", sort: "price", runMs: [10_000, 30_000], idleMs: [20_000, 60_000], retryMs: [30_000, 60_000] },
  { shape: "mem-heavy", filters: { "ram.gib.min": 128 }, maxPricePerHour: "0.25", sort: "price", runMs: [60_000, 180_000], idleMs: [20_000, 60_000], retryMs: [20_000, 40_000] },
  { shape: "bulk-sweep", filters: {}, maxPricePerHour: "0.10", sort: "price", runMs: [30_000, 90_000], idleMs: [10_000, 30_000], retryMs: [15_000, 30_000] },
];

export interface RequestorPersona {
  requestorId: string;
  displayName: string;
  shape: JobShape;
}

export function requestorPersona(i: number): RequestorPersona {
  // The key reserves a deterministic, restart-stable identity per index. The
  // read path is anonymous in v0.2, so nothing is signed yet — the id keys
  // dashboard state and becomes a real signer if a demand side ever ships.
  const priv = keccak256(new TextEncoder().encode(`atlas-dev-requestor:${i}`));
  return {
    requestorId: addressFromPrivateKey(priv),
    displayName: `dev-requestor-${String(i + 1).padStart(2, "0")}`,
    shape: SHAPES[i % SHAPES.length]!,
  };
}

// ---- wire shapes (subset of the §8.4 response we consume) -----------------

interface WireEnvelope {
  envelope: { payload: Record<string, unknown>; signature: string };
}

export interface WireOfferItem {
  offerId: string;
  template: WireEnvelope;
  attestation: WireEnvelope;
  terms: WireEnvelope | null;
  status: string;
}

/**
 * The §9 step-2 client-side verification. Returns a defect description, or
 * null when the item is sound. Any defect here is a registry bug — the query
 * endpoint must only return verifiable, live envelopes under freshness=normal.
 */
export function verifyOfferItem(item: WireOfferItem, serviceAddr: string, nowMs: number): string | null {
  const tpl = item.template.envelope;
  const providerId = tpl.payload.providerId as string;
  if (recoverSigner(tpl.payload, tpl.signature) !== providerId) return "template signature does not verify";
  const att = item.attestation.envelope;
  if (recoverSigner(att.payload, att.signature) !== serviceAddr) return "attestation not signed by the service key";
  if (att.payload.providerId !== providerId) return "attestation providerId does not match template";
  if (!item.terms) return "no dynamic terms on a freshness-filtered result";
  const t = item.terms.envelope;
  if (recoverSigner(t.payload, t.signature) !== providerId) return "terms signature does not verify";
  if (t.payload.offerId !== item.offerId) return "terms offerId does not match item";
  if (Date.parse(t.payload.validUntil as string) <= nowMs) return "terms already expired";
  return null;
}

/** Cross-check that the registry honored the requested filters and ceiling. */
export function checkRegistryFilters(item: WireOfferItem, shape: JobShape): string | null {
  const att = item.attestation.envelope.payload as { coreCount: number; ramGib: number; scores: { full: number } };
  const f = shape.filters;
  if (f["cores.min"] !== undefined && att.coreCount < f["cores.min"]) return `coreCount ${att.coreCount} below cores.min=${f["cores.min"]}`;
  if (f["ram.gib.min"] !== undefined && att.ramGib < f["ram.gib.min"]) return `ramGib ${att.ramGib} below ram.gib.min=${f["ram.gib.min"]}`;
  if (f["score.full.min"] !== undefined && att.scores.full < f["score.full.min"]) return `score.full ${att.scores.full} below score.full.min=${f["score.full.min"]}`;
  const price = (item.terms?.envelope.payload as { minPricePerHour?: string } | undefined)?.minPricePerHour;
  if (price !== undefined && Number(price) > Number(shape.maxPricePerHour)) return `price ${price} above requested ceiling ${shape.maxPricePerHour}`;
  return null;
}

// ---- dashboard state -------------------------------------------------------

export interface DevRequestorState {
  requestorId: string;
  displayName: string;
  shape: string;
  wants: { coresMin: number | null; ramGibMin: number | null; scoreFullMin: number | null };
  maxPricePerHour: string;
  status: "searching" | "probing" | "running" | "idle";
  match: {
    providerId: string;
    providerName: string;
    offerId: string;
    pricePerHour: string;
    sinceIso: string;
    untilIso: string;
  } | null;
  counters: { queries: number; matches: number; noMatch: number; probeRejected: number; bugs: number };
  updatedAt: string;
}

const states = new Map<string, DevRequestorState>();

export function devRequestorSnapshot(): DevRequestorState[] {
  return [...states.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ---- the loop ---------------------------------------------------------------

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const randIn = ([lo, hi]: [number, number]) => rand(lo, hi);

type QueryResult = { items: WireOfferItem[] } | { retryAfterMs: number } | { error: string };

async function queryOffers(baseUrl: string, shape: JobShape): Promise<QueryResult> {
  const q = new URLSearchParams({
    model: "cpu/v1",
    freshness: "normal",
    sort: shape.sort,
    limit: "20",
    "price.perHour.max": shape.maxPricePerHour,
  });
  for (const [k, v] of Object.entries(shape.filters)) q.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/offers?${q}`);
  } catch (e) {
    return { error: `GET /v1/offers failed: ${(e as Error).message}` };
  }
  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as { error?: { details?: { retryAfterMs?: number } } } | null;
    return { retryAfterMs: Number(body?.error?.details?.retryAfterMs) || 5000 };
  }
  if (!res.ok) return { error: `GET /v1/offers → ${res.status}` };
  return (await res.json()) as { items: WireOfferItem[] };
}

/** Start N simulated requestors against baseUrl. Returns a stopper (for tests). */
export function startDevRequestors(n: number, baseUrl: string): () => void {
  console.warn(`⚠ ATLAS_DEV_REQUESTORS=${n} — starting ${n} SIMULATED requestors (§9 reference flow). Dev/testing only.`);
  if (config.devSeed === 0) {
    console.warn("[dev-requestors] ATLAS_DEV_SEED=0 — no dummy providers to match against; every search will come up empty.");
  }
  const directory = devProviderDirectory(config.devSeed);
  const serviceAddr = addressFromPrivateKey(config.servicePrivKey);

  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const schedule = (fn: () => void, ms: number) => {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) fn();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  };

  const bug = (st: DevRequestorState, what: string, offerId: string) => {
    st.counters.bugs += 1;
    console.error(`[dev-requestors] BUG (${st.displayName}): ${what} — offer ${offerId}`);
  };

  const probe = (info: DevProviderInfo): boolean => {
    // Simulated hire-time probe (§9.4): outcome from the dummy's behavior.
    if (info.behavior === "steady") return true;
    if (info.behavior === "flaky") return Math.random() < 0.5;
    return false; // offline — and it should never get this far, see step()
  };

  const step = async (p: RequestorPersona, st: DevRequestorState) => {
    const touch = (status: DevRequestorState["status"]) => {
      st.status = status;
      st.updatedAt = toIso(Date.now());
    };
    touch("searching");
    st.counters.queries += 1;

    const r = await queryOffers(baseUrl, p.shape);
    if (stopped) return;
    if ("retryAfterMs" in r) {
      schedule(() => step(p, st), r.retryAfterMs + rand(500, 2000));
      return;
    }
    if ("error" in r) {
      console.error(`[dev-requestors] ${st.displayName}: ${r.error}`);
      schedule(() => step(p, st), randIn(p.shape.retryMs));
      return;
    }

    const now = Date.now();
    const candidates: Array<{ item: WireOfferItem; info: DevProviderInfo }> = [];
    for (const item of r.items) {
      const defect = verifyOfferItem(item, serviceAddr, now) ?? checkRegistryFilters(item, p.shape);
      if (defect) {
        bug(st, defect, item.offerId);
        continue;
      }
      const info = directory.get(item.template.envelope.payload.providerId as string);
      if (!info) continue; // rule: a simulated requestor never touches a real provider
      candidates.push({ item, info });
    }

    touch("probing");
    let hired: { item: WireOfferItem; info: DevProviderInfo } | null = null;
    for (const c of candidates.slice(0, 3)) {
      if (c.info.behavior === "offline") {
        // freshness=normal must have excluded it (§10) — reaching a probe means the liveness pipeline broke
        bug(st, `offline provider ${c.info.displayName} in freshness=normal results`, c.item.offerId);
        continue;
      }
      if (probe(c.info)) {
        hired = c;
        break;
      }
      st.counters.probeRejected += 1;
    }

    if (!hired) {
      st.counters.noMatch += 1;
      st.match = null;
      touch("searching");
      schedule(() => step(p, st), randIn(p.shape.retryMs));
      return;
    }

    st.counters.matches += 1;
    const runMs = randIn(p.shape.runMs);
    st.match = {
      providerId: hired.item.template.envelope.payload.providerId as string,
      providerName: hired.info.displayName,
      offerId: hired.item.offerId,
      pricePerHour: (hired.item.terms!.envelope.payload as { minPricePerHour: string }).minPricePerHour,
      sinceIso: toIso(now),
      untilIso: toIso(now + runMs),
    };
    touch("running");
    schedule(() => {
      st.match = null;
      touch("idle");
      schedule(() => step(p, st), randIn(p.shape.idleMs));
    }, runMs);
  };

  for (let i = 0; i < n; i++) {
    const p = requestorPersona(i);
    const st: DevRequestorState = {
      requestorId: p.requestorId,
      displayName: p.displayName,
      shape: p.shape.shape,
      wants: {
        coresMin: p.shape.filters["cores.min"] ?? null,
        ramGibMin: p.shape.filters["ram.gib.min"] ?? null,
        scoreFullMin: p.shape.filters["score.full.min"] ?? null,
      },
      maxPricePerHour: p.shape.maxPricePerHour,
      status: "idle",
      match: null,
      counters: { queries: 0, matches: 0, noMatch: 0, probeRejected: 0, bugs: 0 },
      updatedAt: toIso(Date.now()),
    };
    states.set(p.requestorId, st);
    schedule(() => step(p, st), rand(500, 20_000));
  }

  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    states.clear();
  };
}
