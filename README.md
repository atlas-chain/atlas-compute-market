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

Key environment variables: `PORT`, `DATABASE_URL`, `REDIS_URL`, `ATLAS_SERVICE_PRIVKEY`, and benchmark tuning `ATLAS_CHAIN_LEN` / `ATLAS_CHECKPOINTS` / `ATLAS_SAMPLES` (see `src/config.ts`).

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
