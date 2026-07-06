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
 * Live state is in-memory (the simulator lives in the service process) and
 * surfaces through GET /v1/stats as `demandSim` when the flag is set. Every
 * COMPLETED job is additionally settled into the `dev_sim_jobs` Postgres
 * ledger, so spending/earnings/job statistics survive restarts and are
 * queryable (GET /v1/sim/jobs) — the seed of a future stats service.
 */
import { config } from "./config.ts";
import { sql } from "./db.ts";
import { keccak256, addressFromPrivateKey, recoverSigner, signPayload } from "./crypto.ts";
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
  /** Simulated GLM spent on COMPLETED jobs, all time (price/h × run time; ledger-backed). */
  spent: number;
  /** Completed jobs, all time (ledger-backed; unlike `counters`, survives restarts). */
  jobs: number;
  updatedAt: string;
}

/** What one dummy provider has earned from completed simulated jobs (mirror of `spent`). */
export interface DevProviderEarnings {
  providerId: string;
  displayName: string;
  earned: number;
  jobs: number;
  lastJobAt: string;
}

const states = new Map<string, DevRequestorState>();
const earnings = new Map<string, DevProviderEarnings>();
const totals = { spent: 0, jobs: 0 };

export function devRequestorSnapshot(): DevRequestorState[] {
  return [...states.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function devSimEarnings(): DevProviderEarnings[] {
  return [...earnings.values()].sort((a, b) => b.earned - a.earned);
}

/** Market-wide sim totals, seeded from the ledger so they cover ALL settled jobs ever. */
export function devSimTotals(): { spent: number; jobs: number } {
  return { ...totals };
}

// ---- the job ledger (Postgres) ---------------------------------------------

/**
 * Durable record of every completed simulated job — the one piece of sim
 * state that cannot be reconstructed, so it lives in Postgres (§14), unlike
 * the rest of the simulator (in-memory) and liveness (Redis). Dev-only: the
 * table exists only on deployments running the simulator, and is the raw
 * data a future stats service would aggregate.
 */
export async function ensureSimLedger(): Promise<void> {
  await sql`
    create table if not exists dev_sim_jobs (
      id bigint generated always as identity primary key,
      requestor_id text not null,
      requestor_name text not null,
      shape text not null,
      provider_id text not null,
      provider_name text not null,
      offer_id text not null,
      price_per_hour numeric not null,
      run_ms integer not null,
      cost numeric not null,
      started_at timestamptz not null,
      settled_at timestamptz not null default now()
    )`;
  await sql`create index if not exists dev_sim_jobs_requestor on dev_sim_jobs (requestor_id, settled_at desc)`;
  await sql`create index if not exists dev_sim_jobs_provider on dev_sim_jobs (provider_id, settled_at desc)`;
  await sql`create index if not exists dev_sim_jobs_settled on dev_sim_jobs (settled_at desc)`;
}

/** One settled job as served by GET /v1/sim/jobs. */
export interface DevSimJob {
  id: number;
  requestorId: string;
  requestorName: string;
  shape: string;
  providerId: string;
  providerName: string;
  offerId: string;
  pricePerHour: string;
  runMs: number;
  cost: number;
  startedAt: string;
  settledAt: string;
}

/** Recent settled jobs, newest first, optionally filtered to one party. */
export async function devSimJobs(
  limit: number,
  requestorId: string | null,
  providerId: string | null,
): Promise<{ jobs: DevSimJob[]; total: number }> {
  const wheres: string[] = ["true"];
  const params: unknown[] = [];
  if (requestorId) {
    params.push(requestorId);
    wheres.push(`requestor_id = $${params.length}`);
  }
  if (providerId) {
    params.push(providerId);
    wheres.push(`provider_id = $${params.length}`);
  }
  const where = wheres.join(" and ");
  const [{ total }] = (await sql.unsafe(`select count(*)::int as total from dev_sim_jobs where ${where}`, params)) as [
    { total: number },
  ];
  const rows = (await sql.unsafe(
    `select * from dev_sim_jobs where ${where} order by settled_at desc, id desc limit ${Math.floor(limit)}`,
    params,
  )) as Record<string, unknown>[];
  return {
    total,
    jobs: rows.map((r) => ({
      id: Number(r.id),
      requestorId: r.requestor_id as string,
      requestorName: r.requestor_name as string,
      shape: r.shape as string,
      providerId: r.provider_id as string,
      providerName: r.provider_name as string,
      offerId: r.offer_id as string,
      pricePerHour: String(r.price_per_hour),
      runMs: r.run_ms as number,
      cost: Number(r.cost),
      startedAt: (r.started_at as Date).toISOString(),
      settledAt: (r.settled_at as Date).toISOString(),
    })),
  };
}

/** Rebuild the in-memory aggregates from the ledger (called once at start). */
async function loadFromLedger(): Promise<void> {
  const [t] = await sql`select coalesce(sum(cost), 0) as spent, count(*)::int as jobs from dev_sim_jobs`;
  totals.spent = Number(t.spent);
  totals.jobs = t.jobs as number;

  const byProvider = await sql`
    select provider_id, max(provider_name) as name, sum(cost) as earned, count(*)::int as jobs, max(settled_at) as last
    from dev_sim_jobs group by provider_id`;
  for (const r of byProvider) {
    earnings.set(r.provider_id as string, {
      providerId: r.provider_id as string,
      displayName: r.name as string,
      earned: Number(r.earned),
      jobs: r.jobs as number,
      lastJobAt: (r.last as Date).toISOString(),
    });
  }

  const byRequestor = await sql`
    select requestor_id, sum(cost) as spent, count(*)::int as jobs from dev_sim_jobs group by requestor_id`;
  for (const r of byRequestor) {
    const st = states.get(r.requestor_id as string);
    if (st) {
      st.spent = Number(r.spent);
      st.jobs = r.jobs as number;
    }
  }
}

/**
 * Settle a completed simulated job: the requestor's spend and the provider's
 * earnings are two views of the same event, so `Σ spent === Σ earned` holds by
 * construction. Simulated money only. The in-memory aggregates update
 * synchronously; the ledger row is written fire-and-forget (a lost row costs
 * one job of sim money, never correctness of the market itself).
 */
function settleJob(
  st: DevRequestorState,
  providerId: string,
  providerName: string,
  offerId: string,
  pricePerHour: string,
  runMs: number,
  startedIso: string,
): void {
  const cost = (Number(pricePerHour) * runMs) / 3_600_000;
  st.spent += cost;
  st.jobs += 1;
  totals.spent += cost;
  totals.jobs += 1;
  const e = earnings.get(providerId) ?? { providerId, displayName: providerName, earned: 0, jobs: 0, lastJobAt: "" };
  e.earned += cost;
  e.jobs += 1;
  e.lastJobAt = toIso(Date.now());
  earnings.set(providerId, e);
  sql`
    insert into dev_sim_jobs (requestor_id, requestor_name, shape, provider_id, provider_name, offer_id,
                              price_per_hour, run_ms, cost, started_at)
    values (${st.requestorId}, ${st.displayName}, ${st.shape}, ${providerId}, ${providerName}, ${offerId},
            ${pricePerHour}, ${Math.round(runMs)}, ${cost}, ${new Date(startedIso)})
  `.catch((err: unknown) => console.error("[dev-requestors] ledger insert failed:", err));
}

// ---- the loop ---------------------------------------------------------------

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const randIn = ([lo, hi]: [number, number]) => rand(lo, hi);

/**
 * Post the provider-side busy signal (avail/v1, §6.5) for an offer the sim just
 * hired/released. In a real market the PROVIDER posts this on accepting a job;
 * here the sim signs with the dummy persona's key (a dev-only shortcut) so the
 * feature is exercised end-to-end and other requestors skip the taken machine.
 * Fire-and-forget — a failure just means the offer isn't hidden this round.
 */
async function postAvailability(
  baseUrl: string,
  offerId: string,
  priv: Uint8Array,
  available: boolean,
  busyForMs: number,
): Promise<void> {
  const now = Date.now();
  const payload = {
    type: "avail/v1",
    providerId: addressFromPrivateKey(priv),
    offerId,
    seq: now,
    available,
    signedAt: toIso(now),
    validUntil: toIso(now + Math.min(Math.max(busyForMs, 1000), config.availMaxValidityMs)),
  };
  await fetch(`${baseUrl}/v1/offers/${offerId}/availability`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature: signPayload(payload, priv) }),
  }).catch(() => {});
}

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

/**
 * Start N simulated requestors against baseUrl. Returns a stopper (for tests).
 * Spending/earnings aggregates are reloaded from the dev_sim_jobs ledger
 * first, so simulated money survives restarts; activity counters do not.
 */
export async function startDevRequestors(n: number, baseUrl: string): Promise<() => void> {
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
    const providerId = hired.item.template.envelope.payload.providerId as string;
    const pricePerHour = (hired.item.terms!.envelope.payload as { minPricePerHour: string }).minPricePerHour;
    const startedIso = toIso(now);
    st.match = {
      providerId,
      providerName: hired.info.displayName,
      offerId: hired.item.offerId,
      pricePerHour,
      sinceIso: startedIso,
      untilIso: toIso(now + runMs),
    };
    touch("running");
    // machine is taken now — flag it busy so peers skip it (auto-clears if we die)
    void postAvailability(baseUrl, hired.item.offerId, hired.info.priv, false, runMs + 30_000);
    schedule(() => {
      void postAvailability(baseUrl, hired.item.offerId, hired.info.priv, true, 0); // job done — release
      settleJob(st, providerId, hired.info.displayName, hired.item.offerId, pricePerHour, runMs, startedIso);
      st.match = null;
      touch("idle");
      schedule(() => step(p, st), randIn(p.shape.idleMs));
    }, runMs);
  };

  const personas: Array<[RequestorPersona, DevRequestorState]> = [];
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
      spent: 0,
      jobs: 0,
      updatedAt: toIso(Date.now()),
    };
    states.set(p.requestorId, st);
    personas.push([p, st]);
  }

  // rebuild money/jobs aggregates from the durable ledger before going live,
  // so the dashboard never shows zeros that later jump on the first settle
  try {
    await loadFromLedger();
  } catch (e) {
    console.error("[dev-requestors] ledger load failed — starting with fresh aggregates:", e);
  }

  for (const [p, st] of personas) schedule(() => step(p, st), rand(500, 20_000));

  return () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    states.clear();
    earnings.clear();
    totals.spent = 0;
    totals.jobs = 0;
  };
}
