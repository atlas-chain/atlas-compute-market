/** Service configuration from environment. Limits are config, not protocol (§12). */
import { hexToBytes } from "./crypto.ts";

function num(name: string, def: number): number {
  const v = process.env[name];
  return v ? Number(v) : def;
}

// Well-known dev key (priv=0x…01). NEVER use in production.
const DEV_SERVICE_KEY = "0000000000000000000000000000000000000000000000000000000000000001";

export const config = {
  port: num("PORT", 8080),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://atlas:atlas@localhost:5432/atlas",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  servicePrivKey: hexToBytes(
    (process.env.ATLAS_SERVICE_PRIVKEY ?? DEV_SERVICE_KEY).replace(/^0x/, ""),
  ),
  serviceKeyIsDev: !process.env.ATLAS_SERVICE_PRIVKEY,

  specVersion: "0.2-draft",
  unit: "GLM", // single-currency market (§6.3)

  // benchmark parameters (§5; tunable, pinned by reference vectors later)
  chainLen: num("ATLAS_CHAIN_LEN", 1_000_000),
  checkpoints: num("ATLAS_CHECKPOINTS", 1024),
  samples: num("ATLAS_SAMPLES", 16),
  challengeTtlMs: num("ATLAS_CHALLENGE_TTL_MS", 5 * 60_000),
  maxLaneMs: num("ATLAS_MAX_LANE_MS", 120_000),
  maxWorkers: 256,

  attestationTtlMs: num("ATLAS_ATTESTATION_TTL_DAYS", 30) * 86_400_000,
  templateMaxAheadMs: 180 * 86_400_000, // §6.2
  termsMaxValidityMs: 3_600_000, // §6.3
  signedAtMaxFutureMs: 120_000, // §3.6
  offerCapPerProvider: num("ATLAS_OFFER_CAP", 50),
  heartbeatMin: 15,
  heartbeatMax: 900,

  livenessTtlMs: num("ATLAS_LIVENESS_TTL_MS", 1000),
  queryMaxCandidates: 1000,
  queryDefaultLimit: 20,
  queryMaxLimit: 100,

  // rate limits (§12): [max, windowMs]
  rl: {
    templatePerProvider: [20, 3_600_000] as const,
    profilePerProvider: [6, 3_600_000] as const,
    challengePerProvider: [4, 86_400_000] as const,
    challengePerIp: [20, 86_400_000] as const,
    registrationPerIp: [30, 3_600_000] as const,
    queryPerIp: [600, 60_000] as const,
    livenessPerIp: [60, 60_000] as const,
  },
};

export type Config = typeof config;
