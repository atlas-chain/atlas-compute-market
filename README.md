# Atlas Compute Market

A centralized registry service for a compute market, designed to migrate to blockchain anchoring with no change to client protocols.

The service stores provider identities and offers, **proves provider hardware capability with a server-issued benchmark**, serves offers to requestors, and tracks provider liveness. Negotiation and agreement between requestor and provider remain peer-to-peer.

Offers are organized by **compute model** (`cpu/v1` today, `gpu/v1` reserved) so new hardware classes are additive. To advertise, a provider must pass a time-bounded CPU benchmark whose result is recorded in a re-verifiable, service-signed capability attestation.

## Design principles

1. **The service stores and serves, but never vouches on trust.** All trust-relevant claims are signed by the provider's key and stored/returned verbatim.
2. **Identity is a keypair, not an account.** No passwords or server-issued sessions; authentication is a signature.
3. **Objects are content-addressed.** Object IDs are hashes of their signed payloads — the same hashes later committed to a chain in merkle batches.
4. **Capability is measured, not claimed.** Advertised performance comes from a server-issued, time-bounded benchmark, recorded in a service-signed attestation anyone can re-verify from the retained challenge and proof.

## Stack

- **Bun** — HTTP / WebSocket
- **PostgreSQL** — the only durable store
- **Redis** — ephemeral state (heartbeats, rate limits, pub/sub)

## Specification

See [`docs/registry-spec.md`](docs/registry-spec.md) for the full service specification (v0.2-draft).

## Running

Local development — Postgres + Redis in containers, the registry on the host:

```sh
bun install
docker compose -f compose.dev.yaml up -d   # postgres + redis on host ports
bun start                                  # registry on :8080 (dev service key unless ATLAS_SERVICE_PRIVKEY is set)
bun test                                   # unit tests; plus dockerized end-to-end when docker is available
```

Full stack — registry + Postgres + Redis, all in containers (this is how the
service runs at `https://compute-market.arkiv-global.net`):

```sh
cp .env.example .env      # then set ATLAS_SERVICE_PRIVKEY and POSTGRES_PASSWORD
docker compose up -d --build
```

The default `compose.yaml` publishes only the registry, on `127.0.0.1:28886`, for a
reverse proxy to terminate TLS in front of it.

Exercise the full provider flow (register → benchmark → attestation → offer → heartbeat) with the reference client:

```sh
PROVIDER_PRIVKEY=0x<32-byte-hex> bun run scripts/bench-client.ts
```

Key environment variables: `PORT`, `DATABASE_URL`, `REDIS_URL`, `ATLAS_SERVICE_PRIVKEY`, benchmark tuning `ATLAS_CHAIN_LEN` / `ATLAS_CHECKPOINTS` / `ATLAS_SAMPLES`, and the market-history sampler `ATLAS_STATS_SAMPLE_MS` / `ATLAS_STATS_RETENTION_DAYS` (see `src/config.ts`).

The registry continuously samples its market aggregates into a durable Postgres time-series (`market_snapshots`, spec §8.7/§14) served by `GET /v1/stats/history?range=1h|6h|24h|7d|30d`; the dashboard's **Stats** page charts it (providers online/busy, offers, cores, RAM, price, and — on sim deployments — settled volume and jobs/hour).

## Dashboard

`web/` is a Vite + React market dashboard (stats tiles + a network-statistics chart page, provider directory with per-provider cards, offer browser) that the registry serves on all non-`/v1` paths when `web/dist` exists; the Docker image builds it in. For frontend development:

```sh
cd web && bun install
bun run dev        # Vite dev server on :5173, proxies /v1 to localhost:8080 (override: ATLAS_API_TARGET)
bun run build      # emits web/dist for the registry to serve
```

With no real providers around, seed dummy ones (fake attestations + heartbeats — dev only): `ATLAS_DEV_SEED=10 bun start`.

To also simulate demand, add `ATLAS_DEV_REQUESTORS=6`: N simulated requestors run the spec §9 flow against the real API (query with their job shape's filters, verify all envelope signatures client-side, simulate the P2P hire probe) and only ever "hire" the dev dummies — real matching stays peer-to-peer and off-registry. Their state shows up as a **Demand (sim)** page in the dashboard — including each requestor's simulated spending and each dummy provider's mirrored earnings, with per-requestor and per-provider card pages and a job-history view linked throughout — and any signature/filter/liveness violation they observe is logged as a `BUG` (they double as a continuous end-to-end check of the read path). When a simulated requestor hires a dummy it posts that provider's optional **busy** signal (`avail/v1`, §6.5), so those offers show `status: "busy"` and drop out of default (`availability=free`) queries until the job ends.

Every completed sim job is settled into a durable Postgres ledger (`dev_sim_jobs`: parties, shape, price, run time, cost), so spending/earnings/job statistics survive restarts; sim-enabled deployments also expose `GET /v1/sim/jobs?limit&requestor&provider` (newest first — 404 in production, not part of the protocol). Live activity counters (queries, matches, bugs) remain in-memory by design.

### Optional busy signal

A provider that accepts a job off-registry can take itself out of default search results without revoking its offer, so requestors don't waste a P2P probe on a taken machine: `POST /v1/offers/{offerId}/availability` with a provider-signed `avail/v1` `{ available: false, validUntil }` (spec §6.5). It's advisory (the registry only relays the provider's signature), ephemeral (auto-clears at `validUntil`, so a crash can't strand the offer), and entirely optional — a provider that never calls it behaves exactly as before. `available: true` clears it early. Requestors pass `availability=any` to `GET /v1/offers` to see busy offers (marked `status: "busy"`) instead of having them hidden.

## Layout

| Path | What |
|---|---|
| `src/jcs.ts`, `src/crypto.ts` | RFC 8785 canonicalization; keccak/secp256k1 identity + signatures (§3) |
| `src/bench.ts` | Benchmark work function, merkle commitment, prover + verifier (§5) — the contract for the Rust provider agent |
| `src/handlers/` | Providers, attestation flow, offers/terms/revoke, query, liveness snapshot (§8) |
| `src/db.ts`, `src/redis.ts` | Postgres schema (§14) and degraded-mode-safe Redis wrapper |
| `scripts/bench-client.ts` | Reference provider agent |

## Status

First implementation pass: identity/signatures, the CPU benchmark attestation flow, offers, dynamic terms (heartbeat + price), query, and the compact liveness snapshot. Deferred by design: epochs/transparency feed (§11), the change feed, the RAM lane (§5.5), surprise re-challenges, and benchmark-proof hardening (interactive sampling).
