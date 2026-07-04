/** Operational endpoints (§8.7). */
import { sql } from "../db.ts";
import { redis } from "../redis.ts";
import { config } from "../config.ts";
import { addressFromPrivateKey } from "../crypto.ts";
import { json } from "../http.ts";

export async function getHealth(): Promise<Response> {
  let pg = "ok";
  try {
    await sql`select 1`;
  } catch {
    pg = "down";
  }
  const r = (await redis.available()) ? "ok" : "absent";
  // `epoch` field is added once §11 ships (deferred)
  return json({ postgres: pg, redis: r }, pg === "ok" ? 200 : 500);
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
