/**
 * Market history (§8.7) — a durable time-series of the market aggregates.
 *
 * A sampler writes one `market_snapshots` row per tick (default 60 s,
 * ATLAS_STATS_SAMPLE_MS) with exactly the numbers GET /v1/stats serves, plus
 * the sim ledger totals when the demand simulator runs. Rows are pruned past
 * ATLAS_STATS_RETENTION_DAYS. GET /v1/stats/history serves the series
 * bucket-averaged to a bounded number of points per range, so response size
 * is independent of the sampling rate.
 */
import type { Server } from "bun";
import { sql } from "./db.ts";
import { redis } from "./redis.ts";
import { config } from "./config.ts";
import { err } from "./errors.ts";
import { json, clientIp } from "./http.ts";
import { computeMarketAggregates } from "./handlers/ops.ts";

/** Take and persist one snapshot; idempotent per timestamp. */
export async function takeMarketSnapshot(): Promise<void> {
  const now = Date.now();
  const a = await computeMarketAggregates(now);

  let simSpent: number | null = null;
  let simJobs: number | null = null;
  if (config.devRequestors > 0) {
    const { devSimTotals } = await import("./dev-requestors.ts");
    const t = devSimTotals();
    simSpent = t.spent;
    simJobs = t.jobs;
  }

  await sql`
    insert into market_snapshots (at, providers_total, providers_active, providers_busy,
                                  offers_active, offers_live, offers_busy, attestations_valid,
                                  live_cores, live_ram_gib, price_min, price_median, price_max,
                                  sim_spent, sim_jobs)
    values (${new Date(now)}, ${a.providers.total}, ${a.providers.active}, ${a.providers.busy},
            ${a.offers.active}, ${a.offers.live}, ${a.offers.busy}, ${a.attestations.valid},
            ${a.capacity.liveCores}, ${a.capacity.liveRamGib},
            ${a.price?.min ?? null}, ${a.price?.median ?? null}, ${a.price?.max ?? null},
            ${simSpent}, ${simJobs})
    on conflict (at) do nothing`;
  await sql`delete from market_snapshots where at < now() - make_interval(days => ${config.statsRetentionDays})`;
}

/** Start the periodic sampler (first sample immediately). Returns a stopper. */
export function startStatsSampler(): () => void {
  const tick = () =>
    takeMarketSnapshot().catch((e) => console.error("[stats-history] snapshot failed:", e));
  void tick();
  const timer = setInterval(tick, config.statsSampleMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ------------------------------------------------------------------ serving

/** range → [window seconds, bucket seconds]; buckets keep every response ≤ ~360 points. */
const RANGES: Record<string, [number, number]> = {
  "1h": [3_600, 60],
  "6h": [21_600, 300],
  "24h": [86_400, 600],
  "7d": [604_800, 3_600],
  "30d": [2_592_000, 14_400],
};

/** GET /v1/stats/history?range=1h|6h|24h|7d|30d — bucket-averaged market time-series. */
export async function getStatsHistory(req: Request, server: Server<unknown>): Promise<Response> {
  const ip = clientIp(req, server);
  const [maxQ, winQ] = config.rl.queryPerIp;
  const retry = await redis.rateLimit("query", ip, maxQ, winQ);
  if (retry > 0) throw err("RATE_LIMITED", "query rate exceeded", { retryAfterMs: retry });

  const range = new URL(req.url).searchParams.get("range") ?? "24h";
  const spec = RANGES[range];
  if (!spec) throw err("VALIDATION", `range must be one of ${Object.keys(RANGES).join("|")}`, { field: "range" });
  const [windowSec, stepSec] = spec;

  const rows = await sql`
    select floor(extract(epoch from at) / ${stepSec})::bigint * ${stepSec} as bucket,
           round(avg(providers_total))::int  as providers_total,
           round(avg(providers_active))::int as providers_active,
           round(avg(providers_busy))::int   as providers_busy,
           round(avg(offers_active))::int    as offers_active,
           round(avg(offers_live))::int      as offers_live,
           round(avg(offers_busy))::int      as offers_busy,
           round(avg(attestations_valid))::int as attestations_valid,
           round(avg(live_cores))::int       as live_cores,
           avg(live_ram_gib)                 as live_ram_gib,
           avg(price_min) as price_min, avg(price_median) as price_median, avg(price_max) as price_max,
           max(sim_spent) as sim_spent, max(sim_jobs) as sim_jobs
    from market_snapshots
    where at > now() - make_interval(secs => ${windowSec})
    group by bucket
    order by bucket`;

  const points = rows.map((r: Record<string, unknown>) => ({
    at: Number(r.bucket),
    providers: {
      total: r.providers_total as number,
      active: r.providers_active as number,
      busy: r.providers_busy as number,
    },
    offers: { active: r.offers_active as number, live: r.offers_live as number, busy: r.offers_busy as number },
    attestations: { valid: r.attestations_valid as number },
    capacity: { liveCores: r.live_cores as number, liveRamGib: Number(r.live_ram_gib) },
    price:
      r.price_median === null
        ? null
        : { min: Number(r.price_min), median: Number(r.price_median), max: Number(r.price_max) },
    // cumulative ledger totals (max within bucket); clients diff for rates
    sim: r.sim_jobs === null ? null : { spent: Number(r.sim_spent), jobs: Number(r.sim_jobs) },
  }));

  return json({ range, stepSec, unit: config.unit, points });
}
