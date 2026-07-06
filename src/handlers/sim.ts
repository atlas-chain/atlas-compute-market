/**
 * Dev-only simulator endpoints — registered ONLY when ATLAS_DEV_REQUESTORS is
 * set (server.ts), so production deployments 404 here. Unsigned server-derived
 * data, not part of the protocol (like the dashboard itself).
 */
import type { Server } from "bun";
import { redis } from "../redis.ts";
import { config } from "../config.ts";
import { err } from "../errors.ts";
import { json, clientIp } from "../http.ts";
import { devSimJobs } from "../dev-requestors.ts";

/** GET /v1/sim/jobs?limit&requestor=0x…&provider=0x… — settled sim jobs, newest first. */
export async function getSimJobs(req: Request, server: Server<unknown>): Promise<Response> {
  const ip = clientIp(req, server);
  const [maxQ, winQ] = config.rl.queryPerIp;
  const retry = await redis.rateLimit("query", ip, maxQ, winQ);
  if (retry > 0) throw err("RATE_LIMITED", "query rate exceeded", { retryAfterMs: retry });

  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw err("VALIDATION", "limit must be an integer in [1, 200]", { field: "limit" });
  }
  const party = (name: string): string | null => {
    const v = url.searchParams.get(name);
    if (v === null) return null;
    const id = v.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(id)) throw err("VALIDATION", `${name} must be a 0x address`, { field: name });
    return id;
  };

  return json(await devSimJobs(limit, party("requestor"), party("provider")));
}
