/** Operational endpoints (§8.7). */
import type { Server } from "bun";
import { sql } from "../db.ts";
import { redis } from "../redis.ts";
import { config } from "../config.ts";
import { err } from "../errors.ts";
import { addressFromPrivateKey } from "../crypto.ts";
import { json, clientIp } from "../http.ts";
import packageJson from "../../package.json" with { type: "json" };

export async function getHealth(): Promise<Response> {
  let pg = "ok";
  try {
    await sql`select 1`;
  } catch {
    pg = "down";
  }
  const r = (await redis.available()) ? "ok" : "absent";
  // `epoch` field is added once §11 ships (deferred)
  return json({ version: packageJson.version, postgres: pg, redis: r }, pg === "ok" ? 200 : 500);
}

/** GET /v1/stats — unsigned market aggregates for dashboards; cached like the liveness blob (§8.7). */
export async function getStats(req: Request, server: Server<unknown>): Promise<Response> {
  const ip = clientIp(req, server);
  const [maxQ, winQ] = config.rl.queryPerIp;
  const retry = await redis.rateLimit("query", ip, maxQ, winQ);
  if (retry > 0) throw err("RATE_LIMITED", "query rate exceeded", { retryAfterMs: retry });

  let blob = await redis.getCachedStats();
  if (!blob) {
    const now = Date.now();
    const live = await redis.liveOffers(now);

    let liveProviders = 0;
    let liveCores = 0;
    let liveRamGib = 0;
    if (live.length > 0) {
      // bytea[] params aren't serializable by Bun SQL — ship hex and decode in SQL
      const hexList = live.map(([id]) => id.slice(2)).join(",");
      const [agg] = await sql`
        select count(distinct provider_id)::int as providers,
               coalesce(sum(core_count), 0)::int as cores,
               coalesce(sum(ram_gib), 0) as ram
        from offers
        where offer_id in (select decode(h, 'hex') from unnest(string_to_array(${hexList}, ',')) h)`;
      liveProviders = agg.providers as number;
      liveCores = agg.cores as number;
      liveRamGib = Number(agg.ram);
    }

    const [totals] = await sql`
      select (select count(*) from providers)::int as providers,
             (select count(*) from offers where revoked_at is null and expires_at > now())::int as active_offers,
             (select count(*) from attestations where expires_at > now())::int as attestations`;

    // busy = live offers a provider has flagged taken (avail/v1, §6.5);
    // a provider counts as busy when ≥ 1 of its live offers is flagged
    const busySet = live.length === 0 ? new Set<string>() : await redis.busyBatch(live.map(([id]) => id));
    const busyOffers = busySet.size;
    let busyProviders = 0;
    if (busyOffers > 0) {
      const busyHex = [...busySet].map((id) => id.slice(2)).join(",");
      const [b] = await sql`
        select count(distinct provider_id)::int as n from offers
        where offer_id in (select decode(h, 'hex') from unnest(string_to_array(${busyHex}, ',')) h)`;
      busyProviders = b.n as number;
    }

    const prices = live.map(([, p]) => Number(p)).sort((a, b) => a - b);
    const median =
      prices.length === 0
        ? null
        : prices.length % 2
          ? prices[(prices.length - 1) / 2]!
          : (prices[prices.length / 2 - 1]! + prices[prices.length / 2]!) / 2;

    // dev-only simulated demand (ATLAS_DEV_REQUESTORS) — absent in production
    let demandSim: Record<string, unknown> | undefined;
    if (config.devRequestors > 0) {
      const { devRequestorSnapshot, devSimEarnings, devSimTotals } = await import("../dev-requestors.ts");
      demandSim = {
        requestors: devRequestorSnapshot(),
        earnings: devSimEarnings(),
        // ledger-backed (survives restarts); Σ spent === Σ earned by construction
        totals: devSimTotals(),
      };
    }

    blob = JSON.stringify({
      at: Math.floor(now / 1000),
      unit: config.unit,
      providers: {
        total: totals.providers,
        active: liveProviders,
        busy: busyProviders,
        free: Math.max(0, liveProviders - busyProviders),
      },
      offers: { active: totals.active_offers, live: live.length, busy: busyOffers },
      attestations: { valid: totals.attestations },
      capacity: { liveCores, liveRamGib },
      price: prices.length === 0 ? null : { min: prices[0]!, median, max: prices[prices.length - 1]! },
      ...(demandSim ? { demandSim } : {}),
    });
    await redis.setCachedStats(blob, config.statsTtlMs);
  }
  return new Response(blob, { headers: { "content-type": "application/json" } });
}

export async function getSpec(): Promise<Response> {
  return json({
    version: config.specVersion,
    models: ["cpu/v1"],
    unit: config.unit,
    serviceKey: addressFromPrivateKey(config.servicePrivKey),
    bench: {
      chainLen: config.chainLen,
      checkpoints: config.checkpoints,
      samples: config.samples,
      maxLaneMs: config.maxLaneMs,
    },
  });
}
