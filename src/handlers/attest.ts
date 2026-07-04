/** Benchmark challenge → lanes → capability attestation (§5, §8.2). */
import type { Server } from "bun";
import { sql, logPayload } from "../db.ts";
import { redis } from "../redis.ts";
import { config } from "../config.ts";
import { err } from "../errors.ts";
import { parseIso, toIso, isPosInt } from "../validate.ts";
import {
  addressFromPrivateKey,
  bytesToHex,
  hexToBytes,
  payloadHash,
  randomBytes,
  signPayload,
} from "../crypto.ts";
import { laneScore, verifyLane, type LaneParams } from "../bench.ts";
import { envelopeOut, fromJsonb, json, readEnvelope, clientIp, hexToBuf, bufToHex, type RouteReq } from "../http.ts";

const LANE_ORDER = ["single", "quad", "eight", "full"] as const;
type LaneId = (typeof LANE_ORDER)[number];

interface LaneState {
  workers: number;
  status: "pending" | "started" | "done";
  laneIssuedAt?: number; // unix ms, service clock
  nonce?: string; // hex, no 0x
  elapsedMs?: number;
}

interface BenchState {
  providerId: string;
  seed: string; // hex, no 0x
  chainLen: number;
  checkpoints: number;
  samples: number;
  deadlineMs: number;
  declared: { arch: string; coreCount: number; ramGib: number; cpuModel?: string };
  lanes: Record<LaneId, LaneState>;
}

function laneWorkers(coreCount: number): Record<LaneId, number> {
  return { single: 1, quad: 4, eight: 8, full: coreCount };
}

export async function postChallenge(req: Request, server: Server<unknown>): Promise<Response> {
  const w = await readEnvelope(req, "attest-request/v1");
  const p = w.payload;

  const provider = await sql`select 1 from providers where provider_id = ${hexToBuf(w.signer)}`;
  if (provider.length === 0) throw err("UNKNOWN_PROVIDER", "register a profile first");

  if (p.model !== "cpu/v1") throw err("VALIDATION", "unsupported compute model", { field: "model" });
  if (p.arch !== "x64") throw err("ARCH_UNSUPPORTED", 'v0.2 accepts only arch "x64"', { field: "arch" });
  if (!isPosInt(p.coreCount) || (p.coreCount as number) > config.maxWorkers) {
    throw err("VALIDATION", `coreCount must be an integer in [1, ${config.maxWorkers}]`, { field: "coreCount" });
  }
  if (typeof p.ramGib !== "number" || !(p.ramGib > 0)) {
    throw err("VALIDATION", "ramGib must be a positive number", { field: "ramGib" });
  }
  if (p.cpuModel !== undefined && (typeof p.cpuModel !== "string" || p.cpuModel.length > 128)) {
    throw err("VALIDATION", "cpuModel must be a string ≤ 128 chars", { field: "cpuModel" });
  }
  if (parseIso(p.signedAt) === null) throw err("VALIDATION", "signedAt must be ISO 8601", { field: "signedAt" });

  const ip = clientIp(req, server);
  const [maxP, winP] = config.rl.challengePerProvider;
  const [maxI, winI] = config.rl.challengePerIp;
  const r1 = await redis.rateLimit("chal-p", w.signer, maxP, winP);
  const r2 = await redis.rateLimit("chal-ip", ip, maxI, winI);
  const retry = Math.max(r1, r2);
  if (retry > 0) throw err("RATE_LIMITED", "too many benchmark challenges", { retryAfterMs: retry });

  const now = Date.now();
  const challengeId = "0x" + bytesToHex(randomBytes(32));
  const seed = bytesToHex(randomBytes(32));
  const coreCount = p.coreCount as number;
  const workers = laneWorkers(coreCount);

  const challenge = {
    type: "bench-challenge/v1",
    challengeId,
    model: "cpu/v1",
    providerId: w.signer,
    seed: "0x" + seed,
    chainLen: config.chainLen,
    lanes: LANE_ORDER.map((laneId) => ({ laneId, workers: workers[laneId] })),
    checkpoints: config.checkpoints,
    samples: config.samples,
    issuedAt: toIso(now),
    deadline: toIso(now + config.challengeTtlMs),
    attesterKey: addressFromPrivateKey(config.servicePrivKey),
  };
  const signature = signPayload(challenge, config.servicePrivKey);

  const state: BenchState = {
    providerId: w.signer,
    seed,
    chainLen: config.chainLen,
    checkpoints: config.checkpoints,
    samples: config.samples,
    deadlineMs: now + config.challengeTtlMs,
    declared: {
      arch: "x64",
      coreCount,
      ramGib: p.ramGib as number,
      ...(p.cpuModel !== undefined ? { cpuModel: p.cpuModel as string } : {}),
    },
    lanes: Object.fromEntries(
      LANE_ORDER.map((l) => [l, { workers: workers[l], status: "pending" }]),
    ) as Record<LaneId, LaneState>,
  };
  const stored = await redis.setBench(challengeId, state, config.challengeTtlMs);
  if (!stored) throw err("INTERNAL", "benchmark state store unavailable (Redis absent, §2 degraded mode)");

  return json({ payload: challenge, signature }, 201);
}

async function loadState(challengeId: string): Promise<BenchState> {
  if (!/^0x[0-9a-f]{64}$/.test(challengeId)) throw err("VALIDATION", "invalid challengeId");
  const state = await redis.getBench<BenchState>(challengeId);
  if (!state) throw err("UNKNOWN_CHALLENGE", "challenge not found or expired");
  return state;
}

function laneOrThrow(state: BenchState, laneId: string): LaneState {
  if (!(LANE_ORDER as readonly string[]).includes(laneId)) {
    throw err("VALIDATION", `unknown lane "${laneId}"`);
  }
  return state.lanes[laneId as LaneId];
}

export async function postLaneStart(req: RouteReq): Promise<Response> {
  const { challengeId, laneId } = req.params as { challengeId: string; laneId: string };
  const state = await loadState(challengeId);
  const now = Date.now();
  if (now > state.deadlineMs) throw err("EXPIRED", "challenge deadline passed");

  const lane = laneOrThrow(state, laneId);
  if (lane.status !== "pending") throw err("VALIDATION", `lane "${laneId}" already started`);
  for (const prev of LANE_ORDER) {
    if (prev === laneId) break;
    if (state.lanes[prev].status !== "done") {
      throw err("VALIDATION", `lane "${prev}" must complete before "${laneId}" (§5.3: lanes run in order)`);
    }
  }

  lane.status = "started";
  lane.laneIssuedAt = now;
  lane.nonce = bytesToHex(randomBytes(16));
  await redis.setBench(challengeId, state, state.deadlineMs - now);

  return json({ ok: true, laneNonce: "0x" + lane.nonce });
}

export async function postLaneSubmit(req: RouteReq): Promise<Response> {
  const { challengeId, laneId } = req.params as { challengeId: string; laneId: string };
  const w = await readEnvelope(req, "lane-proof/v1");
  const receivedAt = Date.now(); // laneReceivedAt: after body read + sig check, before verify

  const state = await loadState(challengeId);
  if (w.signer !== state.providerId) throw err("SIG_MISMATCH", "signer is not the challenge's provider");
  if (w.payload.challengeId !== challengeId || w.payload.laneId !== laneId) {
    throw err("VALIDATION", "payload challengeId/laneId must match the URL");
  }
  if (receivedAt > state.deadlineMs) throw err("EXPIRED", "challenge deadline passed");

  const lane = laneOrThrow(state, laneId);
  if (lane.status !== "started") throw err("VALIDATION", `lane "${laneId}" is not started`);

  const elapsedMs = receivedAt - lane.laneIssuedAt!;
  if (elapsedMs > config.maxLaneMs) {
    await redis.dropBench(challengeId);
    throw err("BENCH_FAILED", `lane "${laneId}" exceeded max lane time`, {
      lane: laneId,
      elapsedMs,
      maxLaneMs: config.maxLaneMs,
    });
  }

  const params: LaneParams = {
    seed: hexToBytes(state.seed),
    laneNonce: hexToBytes(lane.nonce!),
    providerId: state.providerId,
    laneId,
    chainLen: state.chainLen,
    checkpoints: state.checkpoints,
    samples: state.samples,
  };
  const result = verifyLane(params, lane.workers, challengeId, w.payload.workers);
  if (!result.ok) {
    await redis.dropBench(challengeId);
    throw err("BENCH_FAILED", `lane "${laneId}" verification failed: ${result.reason}`, { lane: laneId });
  }

  lane.status = "done";
  lane.elapsedMs = elapsedMs;
  const allDone = LANE_ORDER.every((l) => state.lanes[l].status === "done");

  if (!allDone) {
    await redis.setBench(challengeId, state, state.deadlineMs - receivedAt);
    return json({ verified: true, elapsedMs, workers: lane.workers });
  }

  // Close (§5.3 step 3): build, sign and persist the attestation.
  // elapsed clamped to ≥1 ms so a (test-sized) instant lane cannot produce a non-finite score
  const score = (l: LaneId) =>
    laneScore(state.lanes[l].workers, state.chainLen, Math.max(1, state.lanes[l].elapsedMs!));
  const attestation = {
    type: "attest/cpu/v1",
    model: "cpu/v1",
    providerId: state.providerId,
    challengeId,
    arch: state.declared.arch,
    coreCount: state.declared.coreCount,
    ramGib: state.declared.ramGib,
    ...(state.declared.cpuModel !== undefined ? { cpuModel: state.declared.cpuModel } : {}),
    scores: {
      singleCore: score("single"),
      quadCore: score("quad"),
      eightCore: score("eight"),
      full: score("full"),
      ramBandwidth: null, // reserved (§5.5)
      dagHash: null, // reserved (§5.5)
    },
    measuredAt: toIso(receivedAt),
    expiresAt: toIso(receivedAt + config.attestationTtlMs),
    attesterKey: addressFromPrivateKey(config.servicePrivKey),
    specVersion: config.specVersion,
  };
  const signature = signPayload(attestation, config.servicePrivKey);
  const attestationId = payloadHash(attestation);

  const providerBytes = hexToBuf(state.providerId);
  await logPayload(hexToBuf(attestationId), "attest/cpu/v1", providerBytes, attestation, hexToBuf(signature));
  await sql`
    insert into attestations (attestation_id, provider_id, model, arch, core_count, ram_gib, cpu_model,
                              score_single, score_quad, score_eight, score_full,
                              measured_at, expires_at, signature)
    values (${hexToBuf(attestationId)}, ${providerBytes}, 'cpu/v1', ${attestation.arch},
            ${attestation.coreCount}, ${attestation.ramGib}, ${attestation.cpuModel ?? null},
            ${attestation.scores.singleCore}, ${attestation.scores.quadCore},
            ${attestation.scores.eightCore}, ${attestation.scores.full},
            ${new Date(receivedAt)}, ${new Date(receivedAt + config.attestationTtlMs)},
            ${hexToBuf(signature)})
    on conflict (attestation_id) do nothing`;
  await redis.dropBench(challengeId);

  return json({
    verified: true,
    elapsedMs,
    workers: lane.workers,
    attestation: { attestationId, ...envelopeOut(attestation, signature, toIso(receivedAt)) },
  });
}

export async function getAttestation(req: RouteReq): Promise<Response> {
  const id = req.params.id?.toLowerCase() ?? "";
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw err("VALIDATION", "invalid attestation id");
  const rows = await sql`
    select payload, signature, received_at from payload_log
    where hash = ${hexToBuf(id)} and type = 'attest/cpu/v1'`;
  if (rows.length === 0) throw err("UNKNOWN_ATTESTATION", "attestation not found");
  return json(envelopeOut(fromJsonb(rows[0].payload), bufToHex(rows[0].signature), rows[0].received_at));
}
