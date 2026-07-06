/** Typed fetchers for the registry's read API (spec §8). */

export interface Scores {
  singleCore: number;
  quadCore: number;
  eightCore: number;
  full: number;
  ramBandwidth: number | null;
  dagHash: number | null;
}

/** One simulated dev requestor (ATLAS_DEV_REQUESTORS); present in dev deployments only. */
export interface DemandSimRequestor {
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
  /** Simulated GLM spent on completed jobs, all time (ledger-backed, survives restarts). */
  spent: number;
  /** Completed jobs, all time (ledger-backed; `counters` are since service start). */
  jobs: number;
  updatedAt: string;
}

/** One settled simulated job from the durable ledger (GET /v1/sim/jobs, dev only). */
export interface SimJob {
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

export interface SimJobList {
  jobs: SimJob[];
  total: number;
}

/** Per-provider earnings from completed simulated jobs (mirror of requestor `spent`). */
export interface SimEarnings {
  providerId: string;
  displayName: string;
  earned: number;
  jobs: number;
  lastJobAt: string;
}

export interface DemandSim {
  requestors: DemandSimRequestor[];
  earnings: SimEarnings[];
  totals: { spent: number; jobs: number };
}

export interface Stats {
  at: number;
  unit: string;
  providers: { total: number; active: number; busy?: number; free?: number };
  offers: { active: number; live: number; busy?: number };
  attestations: { valid: number };
  capacity: { liveCores: number; liveRamGib: number };
  price: { min: number; median: number; max: number } | null;
  demandSim?: DemandSim;
}

export interface ProviderItem {
  providerId: string;
  displayName: string;
  heartbeatIntervalSec: number;
  activeOffers: number;
  liveOffers: number;
  busyOffers: number;
  attestation: {
    coreCount: number;
    ramGib: number;
    cpuModel: string | null;
    scores: Scores;
    expiresAt: string;
  } | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
}

export interface ProviderList {
  items: ProviderItem[];
  total: number;
  limit: number;
  offset: number;
}

/** One of a provider's active offers with its current live/busy state (§8.1). */
export interface ProviderOffer {
  offerId: string;
  status: "active" | "busy" | "stale";
  minPricePerHour: string | null;
  coresFree: number | null;
  expiresAt: string;
}

export interface ProviderDetail {
  envelope: { payload: Record<string, unknown>; signature: string };
  meta: { hash: string; receivedAt: string };
  attestation: {
    id: string;
    model: string;
    coreCount: number;
    ramGib: number;
    cpuModel: string | null;
    scores: Scores;
    expiresAt: string;
  } | null;
  offers: ProviderOffer[];
  stats: {
    activeOffers: number;
    liveOffers: number;
    busyOffers: number;
    lastSeenAt: string | null;
    firstSeenAt: string;
  };
}

export interface Envelope<P = Record<string, unknown>> {
  envelope: { payload: P; signature: string };
  meta: { hash: string | null; receivedAt: string };
}

export type OfferStatus = "active" | "busy" | "stale" | "expired" | "revoked";

export interface OfferItem {
  offerId: string;
  template: Envelope<{ providerId: string; expiresAt: string; constraintsHint?: string }>;
  attestation: Envelope<{ coreCount: number; ramGib: number; cpuModel?: string; scores: Scores }>;
  terms: Envelope<{
    minPricePerHour: string;
    unit: string;
    validUntil: string;
    capacity?: { coresFree?: number };
  }> | null;
  status: OfferStatus;
}

export interface OfferList {
  items: OfferItem[];
  nextCursor: string | null;
}

export interface Spec {
  version: string;
  models: string[];
  unit: string;
  serviceKey: string;
}

export interface Health {
  postgres: string;
  redis: string;
}

export interface OfferFilters {
  "cores.min"?: string;
  "ram.gib.min"?: string;
  "score.full.min"?: string;
  "price.perHour.max"?: string;
  freshness?: string;
  availability?: string;
  sort?: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `${res.status} on ${path}`);
  }
  return res.json();
}

export const api = {
  stats: () => get<Stats>("/v1/stats"),
  spec: () => get<Spec>("/v1/spec"),
  health: () => get<Health>("/v1/health"),
  providers: (limit: number, offset: number) => get<ProviderList>(`/v1/providers?limit=${limit}&offset=${offset}`),
  simJobs: (limit: number, party?: { requestor?: string; provider?: string }) => {
    const q = new URLSearchParams({ limit: String(limit) });
    if (party?.requestor) q.set("requestor", party.requestor);
    if (party?.provider) q.set("provider", party.provider);
    return get<SimJobList>(`/v1/sim/jobs?${q}`);
  },
  provider: (id: string) => get<ProviderDetail>(`/v1/providers/${id}`),
  offers: (filters: OfferFilters, limit: number, cursor?: string | null) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
    q.set("limit", String(limit));
    if (cursor) q.set("cursor", cursor);
    return get<OfferList>(`/v1/offers?${q}`);
  },
};
