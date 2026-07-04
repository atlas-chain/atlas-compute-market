/** Shared HTTP plumbing: envelope verification pipeline (§3), responses, IP. */
import type { Server } from "bun";
import { err } from "./errors.ts";
import { isEnvelope } from "./validate.ts";
import { payloadHash, recoverSigner } from "./crypto.ts";
import { jcs } from "./jcs.ts";

export type RouteReq = Request & { params: Record<string, string> };

export interface VerifiedWrite {
  payload: Record<string, unknown>;
  signature: string;
  hash: string; // 0x… content address of the canonical payload
  signer: string; // recovered 0x-address
}

/**
 * Parse + verify a provider write (§3.2–§3.4): envelope shape, JCS
 * canonicalization, signature recovery, signer == payload.providerId.
 */
export async function readEnvelope(req: Request, expectedType: string): Promise<VerifiedWrite> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw err("VALIDATION", "body must be JSON");
  }
  if (!isEnvelope(body)) throw err("VALIDATION", "body must be { payload, signature }");
  const { payload, signature } = body;

  if (payload.type !== expectedType) {
    throw err("VALIDATION", `payload.type must be "${expectedType}"`, { field: "type" });
  }
  try {
    jcs(payload); // reject non-canonicalizable payloads early
  } catch (e) {
    throw err("VALIDATION", `payload not canonicalizable: ${(e as Error).message}`);
  }
  const signer = recoverSigner(payload, signature);
  if (!signer) throw err("SIG_MISMATCH", "signature unrecoverable");
  if (typeof payload.providerId !== "string" || signer !== payload.providerId.toLowerCase()) {
    throw err("SIG_MISMATCH", "recovered signer does not match payload.providerId");
  }
  return { payload, signature, hash: payloadHash(payload), signer };
}

/** Read-side envelope wrapper (§3.4): { envelope, meta }. */
export function envelopeOut(payload: unknown, signature: string, receivedAt: string | Date) {
  return {
    envelope: { payload, signature },
    meta: {
      hash: payloadHash(payload),
      receivedAt: receivedAt instanceof Date ? receivedAt.toISOString() : receivedAt,
    },
  };
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function clientIp(req: Request, server: Server<unknown>): string {
  return server.requestIP(req)?.address ?? "unknown";
}

export function hexToBuf(hash0x: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hash0x.slice(2), "hex"));
}

export function bufToHex(b: Uint8Array): string {
  return "0x" + Buffer.from(b).toString("hex");
}
