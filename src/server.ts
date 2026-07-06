/** Atlas Compute Market registry service — first pass (spec v0.2-draft). */
import type { Server } from "bun";
import { config } from "./config.ts";
import { migrate } from "./db.ts";
import { ApiError } from "./errors.ts";
import { addressFromPrivateKey } from "./crypto.ts";
import type { RouteReq } from "./http.ts";
import { postProvider, getProvider, listProviders } from "./handlers/providers.ts";
import { postChallenge, postLaneStart, postLaneSubmit, getAttestation } from "./handlers/attest.ts";
import { postOffer, getOffer, postTerms, postRevoke } from "./handlers/offers.ts";
import { getOffers, getLiveness } from "./handlers/query.ts";
import { getHealth, getSpec, getStats } from "./handlers/ops.ts";

type Handler = (req: RouteReq, server: Server<unknown>) => Promise<Response>;

/**
 * Serve the built frontend (web/dist) for non-/v1 GETs, with SPA fallback to
 * index.html. Returns null (→ 404 JSON) when the bundle isn't built.
 */
async function serveStatic(req: Request): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const path = decodeURIComponent(new URL(req.url).pathname);
  if (path.startsWith("/v1/") || path === "/v1" || path.includes("..")) return null;
  let f = Bun.file(config.webDistDir + (path === "/" ? "/index.html" : path));
  if (!(await f.exists())) f = Bun.file(config.webDistDir + "/index.html");
  if (!(await f.exists())) return null;
  return new Response(f);
}

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

  if (config.devSeed > 0) {
    const { seedDevMarket } = await import("./dev-seed.ts");
    await seedDevMarket(config.devSeed);
  }

  const server = Bun.serve({
    port,
    routes: {
      "/v1/providers": { POST: wrap(postProvider as Handler), GET: wrap(listProviders as Handler) },
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
      "/v1/stats": { GET: wrap(getStats as Handler) },
    },
    async fetch(req) {
      const ui = await serveStatic(req);
      if (ui) return ui;
      return Response.json({ error: { code: "VALIDATION", message: "unknown route" } }, { status: 404 });
    },
  });

  console.log(
    `atlas registry listening on :${server.port} — service key ${addressFromPrivateKey(config.servicePrivKey)}`,
  );

  // started after listen: the simulated requestors consume the real HTTP API
  if (config.devRequestors > 0) {
    const { startDevRequestors } = await import("./dev-requestors.ts");
    startDevRequestors(config.devRequestors, `http://localhost:${server.port}`);
  }
  return server;
}

if (import.meta.main) {
  startServer();
}
