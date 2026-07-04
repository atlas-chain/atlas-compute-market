/**
 * Redis — ephemeral, reconstructible state only (§2, §14).
 *
 * Keys:
 *   terms:{offerId}      JSON {envelope, receivedAt}   PX freshness window (§10)
 *   seq:{offerId}        last accepted seq             no expiry, rebuilt lazily
 *   bench:{challengeId}  JSON challenge state          PX challenge deadline
 *   rl:{scope}:{key}:{w} fixed-window counters
 *   live:offers          ZSET offerId → effective expiry (unix ms)
 *   live:prices          HASH offerId → minPricePerHour
 *   liveness:snapshot    cached snapshot blob          PX ttl
 *   seen:{providerId}    last terms receivedAt ISO     PX 7d
 *
 * Every operation is degraded-mode safe (§2): on connection failure the
 * wrapper reports Redis as absent and returns nulls — the service keeps
 * serving reads with all offers stale and the snapshot empty.
 */
import { RedisClient } from "bun";
import { config } from "./config.ts";

let client: RedisClient | null = null;
let lastFailure = 0;
const RETRY_MS = 3000;

function getClient(): RedisClient | null {
  if (client) return client;
  if (Date.now() - lastFailure < RETRY_MS) return null;
  try {
    client = new RedisClient(config.redisUrl, {
      connectionTimeout: 2000,
      autoReconnect: true,
      maxRetries: 3,
    });
    client.onclose = () => {
      client = null;
      lastFailure = Date.now();
    };
    return client;
  } catch {
    lastFailure = Date.now();
    return null;
  }
}

async function send(cmd: string, args: string[]): Promise<unknown> {
  const c = getClient();
  if (!c) return null;
  try {
    return await c.send(cmd, args);
  } catch (e) {
    // command-level errors (wrong type etc.) rethrow; connection errors degrade
    if (e instanceof Error && /connect|closed|timeout|refused/i.test(e.message)) {
      client = null;
      lastFailure = Date.now();
      return null;
    }
    throw e;
  }
}

export const redis = {
  async available(): Promise<boolean> {
    return (await send("PING", [])) === "PONG";
  },

  // ---- terms / liveness -------------------------------------------------

  async setTerms(
    offerId: string,
    value: { envelope: unknown; receivedAt: string },
    pxMs: number,
    price: string,
    effectiveExpiryMs: number,
  ): Promise<boolean> {
    const px = String(Math.max(1, Math.floor(pxMs)));
    const ok = await send("SET", [`terms:${offerId}`, JSON.stringify(value), "PX", px]);
    if (ok === null) return false;
    await send("ZADD", ["live:offers", String(effectiveExpiryMs), offerId]);
    await send("HSET", ["live:prices", offerId, price]);
    return true;
  },

  async getTerms(offerId: string): Promise<{ envelope: unknown; receivedAt: string } | null> {
    const raw = (await send("GET", [`terms:${offerId}`])) as string | null;
    return raw ? JSON.parse(raw) : null;
  },

  async getTermsBatch(offerIds: string[]): Promise<Map<string, { envelope: unknown; receivedAt: string }>> {
    const out = new Map<string, { envelope: unknown; receivedAt: string }>();
    if (offerIds.length === 0) return out;
    const raw = (await send("MGET", offerIds.map((id) => `terms:${id}`))) as (string | null)[] | null;
    if (!raw) return out;
    raw.forEach((v, i) => {
      if (v) out.set(offerIds[i]!, JSON.parse(v));
    });
    return out;
  },

  async dropOffer(offerId: string): Promise<void> {
    await send("DEL", [`terms:${offerId}`, `seq:${offerId}`]);
    await send("ZREM", ["live:offers", offerId]);
    await send("HDEL", ["live:prices", offerId]);
  },

  /** Current live set with prices; prunes expired members as it goes. */
  async liveOffers(nowMs: number): Promise<Array<[offerId: string, price: string]>> {
    await send("ZREMRANGEBYSCORE", ["live:offers", "-inf", `(${nowMs}`]);
    const ids = (await send("ZRANGE", ["live:offers", String(nowMs), "+inf", "BYSCORE"])) as
      | string[]
      | null;
    if (!ids || ids.length === 0) return [];
    const prices = (await send("HMGET", ["live:prices", ...ids])) as (string | null)[] | null;
    if (!prices) return [];
    const rows: Array<[string, string]> = [];
    ids.forEach((id, i) => {
      const p = prices[i];
      if (p != null) rows.push([id, p]);
    });
    return rows;
  },

  async getCachedSnapshot(): Promise<string | null> {
    return (await send("GET", ["liveness:snapshot"])) as string | null;
  },

  async setCachedSnapshot(blob: string, pxMs: number): Promise<void> {
    await send("SET", ["liveness:snapshot", blob, "PX", String(pxMs)]);
  },

  async getCachedStats(): Promise<string | null> {
    return (await send("GET", ["stats:snapshot"])) as string | null;
  },

  async setCachedStats(blob: string, pxMs: number): Promise<void> {
    await send("SET", ["stats:snapshot", blob, "PX", String(pxMs)]);
  },

  // ---- seq (replay protection, §3.6) ------------------------------------

  /** Returns stored seq or null (absent/degraded — caller rebuilds lazily). */
  async getSeq(offerId: string): Promise<number | null> {
    const v = (await send("GET", [`seq:${offerId}`])) as string | null;
    return v === null ? null : Number(v);
  },

  async setSeq(offerId: string, seq: number): Promise<void> {
    await send("SET", [`seq:${offerId}`, String(seq)]);
  },

  // ---- provider last-seen ------------------------------------------------

  async touchProvider(providerId: string, iso: string): Promise<void> {
    await send("SET", [`seen:${providerId}`, iso, "PX", String(7 * 86_400_000)]);
  },

  async lastSeen(providerId: string): Promise<string | null> {
    return (await send("GET", [`seen:${providerId}`])) as string | null;
  },

  async lastSeenBatch(providerIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (providerIds.length === 0) return out;
    const raw = (await send("MGET", providerIds.map((id) => `seen:${id}`))) as (string | null)[] | null;
    if (!raw) return out;
    raw.forEach((v, i) => {
      if (v) out.set(providerIds[i]!, v);
    });
    return out;
  },

  // ---- benchmark challenge state -----------------------------------------

  async setBench(challengeId: string, state: unknown, pxMs: number): Promise<boolean> {
    const ok = await send("SET", [
      `bench:${challengeId}`,
      JSON.stringify(state),
      "PX",
      String(Math.max(1, Math.floor(pxMs))),
    ]);
    return ok !== null;
  },

  async getBench<T>(challengeId: string): Promise<T | null> {
    const raw = (await send("GET", [`bench:${challengeId}`])) as string | null;
    return raw ? (JSON.parse(raw) as T) : null;
  },

  async dropBench(challengeId: string): Promise<void> {
    await send("DEL", [`bench:${challengeId}`]);
  },

  // ---- rate limiting (fixed window approximation of §12) ------------------

  /**
   * Returns retry-after ms when limited, 0 when allowed.
   * Degraded mode allows everything (liveness of the service wins).
   */
  async rateLimit(scope: string, key: string, max: number, windowMs: number): Promise<number> {
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const rk = `rl:${scope}:${key}:${windowStart}`;
    const n = (await send("INCR", [rk])) as number | null;
    if (n === null) return 0;
    if (n === 1) await send("PEXPIRE", [rk, String(windowMs)]);
    return n > max ? windowStart + windowMs - Date.now() : 0;
  },
};
