# Golem Market Registry — Service Specification

**Version:** 0.1-draft
**Status:** for implementation review
**Stack:** Bun (HTTP/WebSocket), PostgreSQL (durable store), Redis (ephemeral state)

---

## 1. Scope and design principles

This document specifies a centralized registry service for a Golem-style compute market. The service stores provider identities and offers, serves them to requestors, and tracks provider liveness. Negotiation and agreement between requestor and provider remain peer-to-peer and are out of scope.

The service is designed so that it can later be anchored to a blockchain without any change to client protocols. Three principles enforce this and are non-negotiable for every endpoint and schema in this document:

1. **The service stores and serves, but never vouches.** All trust-relevant data (profiles, offers, dynamic terms) is signed by the provider's key. The service persists signed payloads verbatim and returns them verbatim. It never mutates a signed body and never generates a field inside one. Server-side metadata (e.g. `receivedAt`) may wrap a payload but never lives inside it.

2. **Identity is a keypair, not an account.** There are no passwords, sessions, or server-issued API keys for providers. Authentication of a write is the signature on its payload. Provider identity is derived from the public key using the Ethereum address scheme, matching Golem node IDs.

3. **Offers are content-addressed.** The identifier of every immutable object is the hash of its canonical signed payload. These hashes are exactly what will later be committed to a chain in merkle batches; clients referencing objects by hash today will not notice the migration.

### Non-goals (v0.1)

Censorship resistance, stake-based spam control, and decentralized operation are explicitly deferred to the blockchain phase. Spam is handled by rate limiting (§10). The service operator is trusted not to censor; the transparency log (§9) makes history rewriting detectable but does not prevent omission.

---

## 2. Architecture and component roles

```
 Provider agent                      Requestor agent
      │  signed writes (HTTP)             │  queries (HTTP) / subscribe (WS)
      ▼                                   ▼
 ┌─────────────────────────────────────────────────┐
 │              Registry service (Bun)             │
 │   validation · canonicalization · sig check     │
 └───────────────┬─────────────────┬───────────────┘
                 │                 │
          PostgreSQL            Redis
          durable store         ephemeral state
```

Component roles are strict:

**PostgreSQL is the only durable store.** It holds provider profiles, offer templates, revocations, epoch roots, and an append-only log of accepted signed payloads. If Postgres is lost, the market history is lost. Nothing durable lives anywhere else.

**Redis holds only ephemeral, reconstructible state:** current dynamic terms / heartbeats (key TTL implements the freshness window directly), rate-limit counters, and pub/sub channels for offer subscriptions. Losing Redis loses at most a few minutes of liveness data, which providers repopulate with their next heartbeat. The service must start and serve reads with Redis absent (degraded: all offers report `stale`, subscriptions unavailable).

**Bun service is stateless.** Any number of instances may run behind a load balancer; all coordination goes through Postgres and Redis.

---

## 3. Identity, canonicalization, and the signed envelope

### 3.1 Keys and provider ID

Providers use secp256k1 keypairs. The provider ID is the Ethereum-style address: `0x` + last 20 bytes of `keccak256(uncompressedPubkey[1:])`, lowercase hex. This is deliberately identical to Golem node IDs so existing node identities can be reused.

### 3.2 Canonical JSON

All signed payloads are JSON objects canonicalized with **RFC 8785 (JCS)** before hashing or signing. Implementations must reject payloads whose transmitted form, after JCS canonicalization, does not hash to the value the signature verifies against — i.e. verification always operates on the canonical form, and the canonical bytes are what the service persists.

### 3.3 Signature scheme

```
digest    = keccak256("\x19Golem Market v1:\n" || jcs(payload))
signature = secp256k1_sign_recoverable(digest, privateKey)   // 65 bytes r‖s‖v
```

The domain-separation prefix prevents cross-protocol signature reuse. Verification recovers the public key from the signature and checks that the derived address equals `payload.providerId`. A payload whose recovered signer does not match its own `providerId` field is rejected with `SIG_MISMATCH`.

### 3.4 Envelope

Every write endpoint accepts the same envelope shape:

```json
{
  "payload": { "type": "...", "providerId": "0x…", "...": "..." },
  "signature": "0x…"   // 65-byte hex
}
```

Every read endpoint returns objects in the same envelope, wrapped with server metadata:

```json
{
  "envelope": { "payload": { ... }, "signature": "0x…" },
  "meta": { "hash": "0x…", "receivedAt": "2026-07-04T12:00:00Z" }
}
```

`meta` is unsigned server data. Clients must treat only `envelope` as authoritative and may independently verify `meta.hash == keccak256(prefix || jcs(payload))`.

### 3.5 Replay protection

Every payload carries `signedAt` (unix ms, provider clock) and, where the object type is mutable-by-succession (dynamic terms), a monotonically increasing `seq`. The service rejects payloads with `signedAt` more than 120 s in the future, and rejects a dynamic-terms payload whose `seq` is not strictly greater than the currently stored one for that offer.

---

## 4. Data objects

Four payload types exist. All are immutable once accepted; "updates" are new objects that supersede old ones by well-defined rules.

### 4.1 ProviderProfile (`type: "profile/v1"`)

Registered once; re-submission with newer `signedAt` supersedes.

```json
{
  "type": "profile/v1",
  "providerId": "0x…",
  "signedAt": 1780560000000,
  "displayName": "my-node-01",
  "netEndpoints": ["p2p://…", "relay://…"],
  "heartbeatIntervalSec": 60,
  "contact": "optional string"
}
```

`heartbeatIntervalSec` is the cadence the provider promises for dynamic-terms refresh; the freshness window for its offers is derived from it (§8). Allowed range: 15–900.

### 4.2 OfferTemplate (`type: "offer/v1"`)

The static, rarely-changing part of an offer. Its hash is the **offer ID** and is the unit of future on-chain commitment.

```json
{
  "type": "offer/v1",
  "providerId": "0x…",
  "signedAt": 1780560000000,
  "properties": {
    "golem.inf.cpu.cores": 16,
    "golem.inf.cpu.threads": 32,
    "golem.inf.mem.gib": 64,
    "golem.inf.storage.gib": 512,
    "golem.runtime.name": "vm",
    "golem.runtime.version": "0.4.0"
  },
  "pricingModel": {
    "kind": "linear/v1",
    "unit": "GLM",
    "bounds": {
      "envPerSec":  { "min": "0.000001", "max": "0.0001"  },
      "cpuPerSec":  { "min": "0.000005", "max": "0.0005"  },
      "start":      { "min": "0",        "max": "0.01"    }
    }
  },
  "constraintsHint": "optional free-form or Golem constraint expr",
  "expiresAt": 1788336000000
}
```

Design notes. `properties` uses the flat namespaced-key convention of the existing Golem market so provider agents can reuse their property emitters. Numeric prices are decimal strings to avoid float ambiguity in canonicalization. `bounds` declares the range within which all future dynamic terms must fall — this is the commitment that makes off-chain price updates verifiable and, later, slashable: two signed messages proving a violation are self-contained fraud evidence. `expiresAt` is a hard template expiry (max 180 days ahead); expiry requires no write.

**Offer ID** `= keccak256(prefix || jcs(offerTemplatePayload))`, hex with `0x` prefix.

### 4.3 DynamicTerms (`type: "terms/v1"`) — doubles as heartbeat

The frequently-changing part. Stored only in Redis (latest per offer), never in Postgres. Its arrival is the liveness signal.

```json
{
  "type": "terms/v1",
  "providerId": "0x…",
  "offerId": "0x…",
  "seq": 4711,
  "signedAt": 1780560060000,
  "validUntil": 1780560240000,
  "prices": {
    "envPerSec": "0.000002",
    "cpuPerSec": "0.00001",
    "start": "0.001"
  },
  "capacity": { "slotsFree": 3 }
}
```

Validation on write: signer matches template's provider; every price within the template's declared `bounds` (violation → `BOUNDS_VIOLATION`, payload still logged for evidence); `validUntil − signedAt ≤ 3600 s`; `seq` strictly increasing.

An offer with no unexpired DynamicTerms is **stale** and excluded from default query results. This is the entire liveness mechanism at the registry level; see §8.

### 4.4 Revocation (`type: "revoke/v1"`)

Optional explicit withdrawal (normally silence + TTL suffices, e.g. for graceful shutdown UX):

```json
{ "type": "revoke/v1", "providerId": "0x…", "offerId": "0x…", "signedAt": 1780560000000 }
```

A revoked offer is permanently excluded from results; revocation is durable (Postgres).

---

## 5. Content addressing summary

| Object | Identifier | Mutability |
|---|---|---|
| ProviderProfile | `providerId` (address) | superseded by newer `signedAt` |
| OfferTemplate | `offerId` = hash of payload | immutable; expires or is revoked |
| DynamicTerms | `(offerId, seq)` | superseded by higher `seq`; expires by `validUntil` |
| Revocation | hash of payload | immutable |

---

## 6. HTTP API

Base path `/v1`. All bodies are `application/json`. All write endpoints take the envelope of §3.4. Success responses use 200/201; errors use the format of §11.

### 6.1 Providers

`POST /v1/providers` — register or supersede a profile. Body: envelope of `profile/v1`. 201 on first registration, 200 on supersession. Errors: `SIG_MISMATCH`, `STALE_PAYLOAD` (older `signedAt` than stored), `VALIDATION`.

`GET /v1/providers/{providerId}` — returns the current profile envelope + meta, plus unsigned aggregates:

```json
{ "envelope": {…}, "meta": {…},
  "stats": { "activeOffers": 3, "lastSeenAt": "…", "firstSeenAt": "…" } }
```

### 6.2 Offers

`POST /v1/offers` — submit an OfferTemplate. Provider must be registered. Returns `{ "offerId": "0x…" }`. Idempotent: re-posting an identical payload returns 200 with the same ID. Errors: `SIG_MISMATCH`, `UNKNOWN_PROVIDER`, `VALIDATION`, `EXPIRED` (expiresAt in past), `LIMIT_EXCEEDED` (per-provider active-offer cap, default 50).

`GET /v1/offers/{offerId}` — full object: template envelope, latest terms envelope (or `null`), status.

```json
{
  "offerId": "0x…",
  "template": { "envelope": {…}, "meta": {…} },
  "terms":    { "envelope": {…}, "meta": {…} },
  "status": "active" | "stale" | "expired" | "revoked"
}
```

`POST /v1/offers/{offerId}/terms` — submit DynamicTerms (heartbeat). Hot path; target p99 < 15 ms. Writes only to Redis (`SET key value PX freshnessWindow`) and publishes to the offer's pub/sub channel. Errors: `SIG_MISMATCH`, `UNKNOWN_OFFER`, `BOUNDS_VIOLATION`, `SEQ_REGRESSION`, `TERMS_TOO_LONG`.

`POST /v1/offers/{offerId}/revoke` — submit Revocation. Durable.

### 6.3 Query

`GET /v1/offers` — the requestor search endpoint. Filters are query parameters compiled to a single indexed SQL query joined with a Redis liveness lookup:

```
GET /v1/offers?cpu.cores.min=8&mem.gib.min=32&runtime=vm
              &price.cpuPerSec.max=0.00002
              &freshness=strict|normal|any     (default: normal)
              &sort=price|random               (default: random)
              &limit=20&cursor=…
```

Semantics: numeric properties support `.min`/`.max` suffixes; string properties exact-match. `price.*` filters evaluate against **current DynamicTerms**, not template bounds. `freshness=strict` requires terms newer than 1× the provider's declared interval, `normal` allows 2× + 30 s grace (§8), `any` includes stale offers (template data only). Default sort is `random` within the result set to avoid herding all requestors onto the same cheapest provider; deterministic pagination uses a cursor over a per-query seed.

Response items are the same shape as `GET /v1/offers/{offerId}`. The requestor **must** verify both signatures client-side; the reference client library treats unverifiable items as absent.

Future compatibility note: the parameter filter set is intentionally a compilable subset of the Golem demand constraint language; a `constraints=` parameter accepting the full expression syntax may be added without breaking this endpoint.

### 6.4 Subscriptions

`WS /v1/subscribe` — requestor opens a WebSocket, sends one JSON frame with the same filter object as §6.3. Service replies with the current matching set, then pushes incremental events sourced from Redis pub/sub:

```json
{ "event": "offer.updated", "offer": { …full offer object… } }
{ "event": "offer.stale",   "offerId": "0x…" }
{ "event": "offer.revoked", "offerId": "0x…" }
```

Server pings every 30 s; connections idle > 90 s are closed. Per-IP concurrent subscription cap: 20.

### 6.5 Epochs and proofs (§9 machinery)

```
GET /v1/epochs/latest           → { "epoch": 421, "root": "0x…", "closedAt": "…", "count": 1893 }
GET /v1/epochs/{n}              → same shape
GET /v1/epochs/{n}/leaves       → paginated leaf hashes (audit)
GET /v1/offers/{offerId}/proof  → { "epoch": 421, "root": "0x…", "index": 17, "siblings": ["0x…", …] }
```

### 6.6 Operational

`GET /v1/health` → `{ "postgres": "ok", "redis": "ok|absent", "epoch": 421 }`. `GET /v1/spec` returns this document's version and the service's signing key for the transparency feed.

---

## 7. Requestor flow (normative summary)

1. Query `GET /v1/offers` or open a subscription with constraints.
2. Verify template and terms signatures locally; drop failures.
3. Optionally fetch and verify a merkle proof against the latest published root (mandatory once chain anchoring is live).
4. Select top-N candidates; initiate Golem P2P negotiation with a short timeout (2–5 s). A non-responsive candidate is dropped and the next is tried — this hire-time probe, not the registry, is the authoritative liveness check.
5. Agreement formation, activity, and payment proceed entirely off-registry.

---

## 8. Freshness and liveness rules

Let `I` = provider's declared `heartbeatIntervalSec` (15–900).

- Redis TTL on a terms record: `min(validUntil − now, 2·I + 30 s)`.
- An offer is **active** if an unexpired terms record exists; otherwise **stale**.
- `stale` offers are excluded from default queries and trigger `offer.stale` events on subscriptions (detected by Redis keyspace-expiry notifications; if unavailable, by a 10 s sweep).
- The registry never asserts liveness on its own authority: `active` means exactly "a provider-signed, unexpired terms message exists." The service cannot fabricate it (no key) — it can only withhold, which is the accepted censorship risk of v0.1.
- No server-initiated pinging of providers. Liveness truth at hire time is established by the requestor's own negotiation probe (§7.4).

---

## 9. Epochs and the commitment anchor

The batching machinery runs from day one, even though nothing is on a chain yet, so the mechanism is exercised and history is auditable.

**Epoch:** fixed 10-minute windows (epoch number = `floor(unixMinutes / 10)`). At close, the service collects the hashes of all payloads durably accepted in that window (profiles, templates, revocations — not dynamic terms, which are ephemeral by design), sorts them ascending, and builds a binary merkle tree (duplicate-last for odd counts; leaf = payload hash; node = `keccak256(left‖right)`). Empty epochs commit the zero root.

**Anchor interface:**

```ts
interface CommitmentAnchor {
  publishRoot(epoch: number, root: Hex): Promise<void>;
  getRoot(epoch: number): Promise<Hex | null>;
}
```

**Phase 1 implementation — transparency feed:** the service signs `{epoch, root, closedAt}` with its own service key and appends it to a public, append-only feed (served at `/v1/epochs/…` and mirrored to an external location the operator does not solely control, e.g. a public git repository). This makes retroactive history rewriting detectable by anyone mirroring the feed.

**Phase 2 implementation — chain:** a contract with `commitRoot(uint64 epoch, bytes32 root)` callable by the operator key, later by any staked aggregator. **Nothing above this interface changes**; clients that already verify inclusion proofs simply switch their root source from the feed to the chain.

---

## 10. Rate limiting and anti-spam

All counters in Redis, sliding window.

| Scope | Limit (default) |
|---|---|
| Terms submissions, per offer | 1 per `I/2` s, burst 3 |
| Template submissions, per provider | 20 / hour |
| Profile updates, per provider | 6 / hour |
| Registrations, per IP | 30 / hour |
| Queries, per IP | 600 / minute |
| WS subscriptions, per IP | 20 concurrent |

Violations return `429` with `RATE_LIMITED` and `retryAfterMs`. Limits are configuration, not protocol; they disappear in favor of stake-gating in the chain phase.

---

## 11. Error format

```json
{ "error": { "code": "BOUNDS_VIOLATION", "message": "cpuPerSec 0.002 exceeds template max 0.0005",
             "details": { "field": "prices.cpuPerSec" } } }
```

Codes: `VALIDATION`, `SIG_MISMATCH`, `STALE_PAYLOAD`, `SEQ_REGRESSION`, `UNKNOWN_PROVIDER`, `UNKNOWN_OFFER`, `BOUNDS_VIOLATION`, `EXPIRED`, `REVOKED`, `LIMIT_EXCEEDED`, `RATE_LIMITED`, `INTERNAL`. HTTP mapping: 400 validation/signature classes, 404 unknowns, 409 `SEQ_REGRESSION`/`STALE_PAYLOAD`, 429 rate limits, 500 internal.

---

## 12. Storage schema

### PostgreSQL

```sql
create table payload_log (              -- append-only, every accepted durable payload
  hash        bytea primary key,        -- keccak256(prefix || jcs(payload))
  type        text not null,
  provider_id bytea not null,
  payload     jsonb not null,           -- canonical form
  signature   bytea not null,
  received_at timestamptz not null default now(),
  epoch       bigint not null
);

create table providers (
  provider_id  bytea primary key,
  profile_hash bytea not null references payload_log(hash),
  signed_at    bigint not null,
  heartbeat_interval_sec int not null,
  first_seen_at timestamptz not null,
  updated_at    timestamptz not null
);

create table offers (
  offer_id    bytea primary key,        -- = template payload hash
  provider_id bytea not null references providers(provider_id),
  template    jsonb not null,
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null,
  -- denormalized indexed columns for query compilation:
  cpu_cores int, cpu_threads int, mem_gib numeric, storage_gib numeric,
  runtime_name text, runtime_version text
);
create index on offers (runtime_name, cpu_cores, mem_gib) where revoked_at is null;
create index on offers (provider_id);
create index on offers (expires_at);

create table epochs (
  epoch      bigint primary key,
  root       bytea not null,
  leaf_count int not null,
  closed_at  timestamptz not null,
  anchor_ref text                        -- feed URL now; tx hash later
);
```

Price filtering against current terms happens after the SQL candidate fetch, in-process against the Redis batch lookup (candidate sets are small once hardware filters apply).

### Redis keys

```
terms:{offerId}        → envelope JSON        PX = freshness window   (§8)
seq:{offerId}          → last accepted seq    no expiry, rebuilt lazily
rl:{scope}:{key}       → sliding-window counters
ch:offers              → pub/sub channel (all offer events; server-side filter per subscription)
```

---

## 13. Migration path to blockchain (informative)

| Concern | v0.1 (this spec) | Chain phase | Client change |
|---|---|---|---|
| Identity | secp256k1 address | same, + stake in registry contract | none |
| Offer commitment | hash in transparency feed epoch root | same hash in on-chain epoch root | root source URL → chain RPC |
| Liveness | signed terms TTL + hire-time probe | unchanged | none |
| Spam control | rate limits | stake + slashing on bounds violations | none |
| Censorship | trusted operator + auditable feed | multiple staked aggregators | query N indexers, union results |

The invariant making every row of this table work: clients never trusted the service in the first place — they verified signatures and (optionally) inclusion proofs from day one.

---

## 14. Implementation notes for the Bun service

Suggested layout: `bun serve` with a thin router; `viem` (or `@noble/curves` + `@noble/hashes`) for keccak/secp256k1 recovery — both run natively in Bun; a small JCS implementation (RFC 8785 is ~100 lines; test against the RFC vectors); `postgres` (porsager) driver with pipelining; `ioredis` or Bun's Redis client. Signature verification is the hot-path CPU cost (~0.1 ms/op with noble); at expected heartbeat volumes (thousands of providers × 1/min) a single instance is comfortably sufficient — design for correctness first, horizontal scale is already free given the stateless service tier.

Test vectors (canonical payload → hash → signature) should be committed to the repo before the first endpoint is written; they are the contract with future non-JS clients (the Golem provider agent is Rust).
