/** Atlas Compute Market registry service — first pass (spec v0.2-draft). */
import type { Server } from "bun";
import { config } from "./config.ts";
import { migrate } from "./db.ts";
import { ApiError } from "./errors.ts";
import { addressFromPrivateKey } from "./crypto.ts";
import type { RouteReq } from "./http.ts";
import { postProvider, getProvider } from "./handlers/providers.ts";
import { postChallenge, postLaneStart, postLaneSubmit, getAttestation } from "./handlers/attest.ts";
import { postOffer, getOffer, postTerms, postRevoke } from "./handlers/offers.ts";
import { getOffers, getLiveness } from "./handlers/query.ts";
import { getHealth, getSpec } from "./handlers/ops.ts";

type Handler = (req: RouteReq, server: Server<unknown>) => Promise<Response>;

function wrap(h: Handler): (req: Request, server: Server<unknown>) => Promise<Response> {
  return async (req, server) => {
    try {
      return await h(req as RouteReq, server);
    } catch (e) {
      if (e instanceof ApiError) return e.toResponse();
      console.error(`[internal] ${req.method} ${new URL(req.url).pathname}:`, e);
      return new ApiError("INTERNAL", "internal error").toResponse();
    }
  };
}

export async function startServer(port = config.port): Promise<Server<unknown>> {
  await migrate();
  if (config.serviceKeyIsDev) {
    console.warn("⚠ ATLAS_SERVICE_PRIVKEY not set — using the well-known DEV key. Do not run in production.");
  }

  const server = Bun.serve({
    port,
    routes: {
      "/v1/providers": { POST: wrap(postProvider as Handler) },
      "/v1/providers/:providerId": { GET: wrap(getProvider as Handler) },

      "/v1/attest/challenge": { POST: wrap(postChallenge as Handler) },
      "/v1/attest/:challengeId/lane/:laneId/start": { POST: wrap(postLaneStart as Handler) },
      "/v1/attest/:challengeId/lane/:laneId": { POST: wrap(postLaneSubmit as Handler) },
      "/v1/attestations/:id": { GET: wrap(getAttestation as Handler) },

      "/v1/offers": { POST: wrap(postOffer as Handler), GET: wrap(getOffers as Handler) },
      "/v1/offers/:offerId": { GET: wrap(getOffer as Handler) },
      "/v1/offers/:offerId/terms": { POST: wrap(postTerms as Handler) },
      "/v1/offers/:offerId/revoke": { POST: wrap(postRevoke as Handler) },

      "/v1/liveness": { GET: wrap(getLiveness as Handler) },
      "/v1/health": { GET: wrap(getHealth as Handler) },
      "/v1/spec": { GET: wrap(getSpec as Handler) },
    },
    fetch() {
      return Response.json({ error: { code: "VALIDATION", message: "unknown route" } }, { status: 404 });
    },
  });

  console.log(
    `atlas registry listening on :${server.port} — service key ${addressFromPrivateKey(config.servicePrivKey)}`,
  );
  return server;
}

if (import.meta.main) {
  startServer();
}
