# Atlas Compute Market — Registry Service Specification

**Version:** 0.2-draft
**Status:** for implementation review
**Stack:** Bun (HTTP), PostgreSQL (durable store), Redis (ephemeral state)

---

## 1. Scope and design principles

This document specifies a centralized registry service for a compute market. The service stores provider identities and offers, proves and serves provider hardware capability, serves offers to requestors, and tracks provider liveness. Negotiation and agreement between requestor and provider remain peer-to-peer and are out of scope.

The service is designed so that it can later be anchored to a blockchain without any change to client protocols. Four principles enforce this and are non-negotiable for every endpoint and schema in this document:

1. **The service stores and serves, but never vouches on trust.** All trust-relevant *claims* (profiles, offers, dynamic terms) are signed by the provider's key. The service persists signed payloads verbatim and returns them verbatim. It never mutates a signed body and never generates a field inside one. Server-side metadata (e.g. `receivedAt`) may wrap a payload but never lives inside it.

2. **Identity is a keypair, not an account.** There are no passwords, sessions, or server-issued API keys for providers. Authentication of a write is the signature on its payload. Provider identity is derived from the public key using the Ethereum address scheme, so existing node identities can be reused.

3. **Objects are content-addressed.** The identifier of every immutable object is the hash of its canonical signed payload. These hashes are exactly what will later be committed to a chain in merkle batches; clients referencing objects by hash today will not notice the migration.

4. **Capability is measured, not claimed.** A provider's advertised compute performance is not self-reported. It is the output of a server-issued, time-bounded benchmark, recorded in a **service-signed capability attestation** that any party can independently re-verify from the retained challenge and proof (§4, §5). The service signs a *re-verifiable fact* ("this challenge was answered, proving this throughput"), which is distinct from vouching for a provider's honesty about price or availability — those remain the requestor's problem, checked by signature and by the hire-time probe (§9).

### Non-goals (v0.2)

Censorship resistance, stake-based spam control, and decentralized operation are deferred to the blockchain phase. Spam is handled by rate limiting (§12). The service operator is trusted not to censor; the transparency log (§11) makes history rewriting detectable but does not prevent omission. The benchmark proves *hardware throughput at attestation time*; it does not prove the provider will serve requestors on the same hardware — that gap is narrowed by expiry and surprise re-challenge (§5.6) and closed only in the chain phase by stake and slashing (§15).

---

## 2. Architecture and component roles

```
 Provider agent                      Requestor agent
      │  signed writes (HTTP)             │  queries + change-feed polls (HTTP)
      │  benchmark round-trips (HTTP)     │
      ▼                                   ▼
 ┌─────────────────────────────────────────────────┐
 │              Registry service (Bun)             │
 │  validation · canonicalization · sig check      │
 │  challenge issue · proof verify · attest sign   │
 └───────────────┬─────────────────┬───────────────┘
                 │                 │
          PostgreSQL            Redis
          durable store         ephemeral state
```

Component roles are strict:

**PostgreSQL is the only durable store.** It holds provider profiles, capability attestations, offer templates, revocations, epoch roots, and an append-only log of accepted durable payloads. If Postgres is lost, market history is lost. Nothing durable lives anywhere else.

**Redis holds only ephemeral, reconstructible state:** current dynamic terms / heartbeats (key TTL implements the freshness window directly), in-flight benchmark challenge state, rate-limit counters, and a capped change-feed stream for offer polling. Losing Redis loses at most a few minutes of liveness data (which providers repopulate with their next heartbeat) and any in-flight benchmark runs (which providers restart). The service must start and serve reads with Redis absent (degraded: all offers report `stale`, the change feed and new attestations unavailable).

**Bun service is stateless.** Any number of instances may run behind a load balancer; all coordination goes through Postgres and Redis.

---

## 3. Identity, canonicalization, and the signed envelope

### 3.1 Keys and provider ID

Providers use secp256k1 keypairs. The provider ID is the Ethereum-style address: `0x` + last 20 bytes of `keccak256(uncompressedPubkey[1:])`, lowercase hex.

### 3.2 Canonical JSON

All signed payloads are JSON objects canonicalized with **RFC 8785 (JCS)** before hashing or signing. Implementations must reject payloads whose transmitted form, after JCS canonicalization, does not hash to the value the signature verifies against — verification always operates on the canonical form, and the canonical bytes are what the service persists.

### 3.3 Signature scheme

```
digest    = keccak256("\x19Atlas Compute v1:\n" || jcs(payload))
signature = secp256k1_sign_recoverable(digest, privateKey)   // 65 bytes r‖s‖v
```

The domain-separation prefix prevents cross-protocol signature reuse. Verification recovers the public key from the signature and checks that the derived address equals `payload.providerId`. A payload whose recovered signer does not match its own `providerId` is rejected with `SIG_MISMATCH`.

### 3.4 Envelope

Every provider write endpoint accepts the same envelope shape:

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
  "meta": { "hash": "0x…", "receivedAt": "2026-07-04T12:00:00.000Z" }
}
```

`meta` is unsigned server data. Clients must treat only `envelope` as authoritative and may independently verify `meta.hash == keccak256(prefix || jcs(payload))`.

### 3.5 Service-signed objects

Two object classes are signed by the **service key**, not a provider key: capability attestations (§4.3) and epoch commitments (§11). They carry `attesterKey` and use the same digest scheme with prefix `"\x19Atlas Compute v1:\n"`. They are always independently re-verifiable from data the service retains and serves, so a service signature is a convenience, never a trust root.

### 3.6 Replay protection

Every provider payload carries `signedAt` (provider clock) and, where the type is mutable-by-succession (dynamic terms), a monotonically increasing `seq`. The service rejects payloads with `signedAt` more than 120 s in the future, and rejects a dynamic-terms payload whose `seq` is not strictly greater than the currently stored one for that offer. Benchmark challenge/response has its own freshness rules (§5).

**Timestamp convention.** Every timestamp field in a signed payload, challenge, or attestation is an **ISO 8601 UTC string with millisecond precision**, e.g. `2026-06-04T08:00:00.000Z`. Comparisons ("older `signedAt`", "more than 120 s in the future", `validUntil − signedAt ≤ 3600 s`) operate on the parsed instants. The canonical (JCS) form is the string exactly as transmitted, so implementations must emit the fixed `YYYY-MM-DDThh:mm:ss.sssZ` form (UTC `Z`, always three fractional digits) to keep signatures stable.

---

## 4. Compute models and capability

### 4.1 The compute-model discriminator

Every offer, attestation, and pricing block carries a `model` field naming a **compute model**: a versioned schema describing what a machine offers and how its capability is measured. v0.2 defines exactly one:

| Model | Meaning | Status |
|---|---|---|
| `cpu/v1` | General-purpose CPU compute, x86-64 | **defined** |
| `gpu/v1` | GPU compute | reserved |
| `cpu+gpu/v1` | Combined | reserved |

All model-specific fields (declared descriptors, benchmark lanes, score keys, price bases) live under the model, so a new model is purely additive: it defines its own attestation type, benchmark, and query filters without touching existing ones. Requestors filter by `model` first; an unknown model is simply not matched.

### 4.2 `cpu/v1` capability

A CPU capability has two parts.

**Declared descriptors** — self-reported, and either uncheatable-upward by the benchmark or informational only:

```json
{
  "arch": "x64",          // enum. v0.2 accepts only "x64"; "arm64" reserved, rejected with ARCH_UNSUPPORTED
  "coreCount": 16,        // logical execution units the provider commits to the full lane (§5.2)
  "ramGib": 64,           // usable RAM in GiB
  "cpuModel": "…"         // optional, informational free-form (e.g. "AMD EPYC 9354")
}
```

**Proven scores** — the output of the benchmark (§5), never declared by the provider, expressed in **CU/s** (Compute Units per second; one CU = one reference chain step, §5.1):

```json
{
  "singleCore": 812,      // 1-worker lane
  "quadCore":   3180,     // 4-worker lane
  "eightCore":  6100,     // 8-worker lane
  "full":       11800,    // coreCount-worker lane
  "ram":        null      // memory-hard lane; reserved, populated once the DAG test is defined (§5.5)
}
```

The CPU scores are market signals, not physical units: they are meaningful for comparing providers of the same `arch`. When further models/arches are added, scores are only ever compared within an `(model, arch)` class. The single-core score is the sequentially-proven ceiling on per-thread throughput; the full score is the whole-machine throughput; quad and eight are the scaling points at 4 and 8 parallel workers (§5.2 explains why each is faithful). The `ram` score is the output of the memory-hard lane; its unit and work function are pinned when that lane is specified (§5.5), and it is `null` on attestations produced before then.

### 4.3 CapabilityAttestation (`type: "attest/cpu/v1"`) — service-signed

Produced by the service at the end of a successful benchmark run (§5). It is the authoritative record of a provider's proven capability and is referenced by every offer.

```json
{
  "type": "attest/cpu/v1",
  "model": "cpu/v1",
  "providerId": "0x…",
  "challengeId": "0x…",          // the challenge this proves (§5.1)
  "arch": "x64",
  "coreCount": 16,
  "ramGib": 64,
  "cpuModel": "AMD EPYC 9354",
  "scores": { "singleCore": 812, "quadCore": 3180, "eightCore": 6100, "full": 11800, "ram": null },
  "measuredAt": "2026-06-04T08:00:12.345Z",   // service clock
  "expiresAt":  "2026-07-04T08:00:12.345Z",   // measuredAt + attestation TTL (default 30 days)
  "attesterKey": "0x…",          // service signing address
  "specVersion": "0.2-draft"
}
```

- **Attestation ID** `= keccak256(prefix || jcs(payload))`, hex with `0x`.
- Signed by the service key. `providerId` is proven because the underlying benchmark proof was signed by that provider (§5.3).
- Fully re-verifiable: the challenge and the provider's proof are retained and served at `GET /v1/attestations/{id}/proof`. A requestor who does not trust the service can re-run the checkpoint verification (§5.4) and confirm the scores itself.
- **Expiry**: after `expiresAt` the attestation is invalid; offers referencing it become `expired` (§6.2). Default TTL 30 days; the service may also revoke an attestation early by surprise re-challenge failure (§5.6).

---

## 5. The benchmark attestation protocol

The goal: turn "how fast is this machine" into a number the provider cannot inflate and any third party can re-check, using only commodity hardware and no trusted execution environment.

### 5.1 Primitive: the sequential chain and the Compute Unit

The reference work function is a **sequential hash chain**. For a worker in a lane:

```
s_0     = keccak256( seed ‖ providerId ‖ laneId ‖ uint32(workerIndex) )
s_{k+1} = keccak256( s_k )                        for k in [0, L)
```

- `seed` is 32 random bytes chosen by the service per challenge (precomputation-resistant).
- `L` (`chainLen`) is fixed per challenge, chosen so the single lane takes ≈ 3 s on the service's reference core.
- **One CU = one chain step (one keccak256).** A chain of length `L` is `L` CU of work.

The chain is **strictly sequential**: `s_{k+1}` depends on `s_k`, so a single chain cannot be accelerated by adding cores. This is the property that makes single-thread measurement honest and, extended across workers, makes per-lane core counts faithful (§5.2).

### 5.2 Lanes and why each score is faithful

A **lane** runs `workers` independent chains in parallel (different `workerIndex`, all length `L`). The service defines four lanes per `cpu/v1` challenge:

| Lane | workers | measures |
|---|---|---|
| `single` | 1 | single-thread throughput |
| `quad` | 4 | throughput at 4 parallel workers |
| `eight` | 8 | throughput at 8 parallel workers |
| `full` | `coreCount` (declared, capped at 256) | whole-machine throughput |
| `ram` | (memory-hard) | usable-RAM-bound throughput — **reserved**, work function deferred to §5.5 |

The service **issues each lane separately and times it itself** (§5.3); provider-reported timing is never trusted. Lane score:

```
score(lane) = (workers × L) / elapsedSeconds(lane)      // CU/s
```

Faithfulness, both directions, follows from chain sequentiality:

- **Extra cores can't inflate a lane.** A lane has exactly `workers` chains; cores beyond `workers` have no chain to run and sit idle. Running the `quad` lane on a 64-core box still finishes only when its 4 chains finish — quad score reflects 4 workers, not 64.
- **Missing cores can't be hidden.** If a machine has fewer real cores than `workers`, its chains must time-share, so `elapsedSeconds` rises and the score falls to the machine's true parallel throughput. A 4-core box running `eight` measures ~4-core throughput, honestly.
- **`full` pins `coreCount`.** The full lane runs `coreCount` chains. Over-declaring `coreCount` forces time-sharing and *lowers* the full score; under-declaring leaves cores idle and also lowers it. The score is maximized only when `coreCount` equals the machine's true parallel width. Honest declaration is the provider's own best strategy — which is exactly why the market can ignore the cores-vs-threads distinction and trust the numbers.

### 5.3 Round-trip flow (server-timed)

Because per-lane wall-clock must be authoritative, lanes are issued one at a time and timed by the service.

1. **Open.** `POST /v1/attest/challenge` with a signed request `{ type: "attest-request/v1", providerId, model: "cpu/v1", arch, coreCount, ramGib, cpuModel?, signedAt }`. The service validates the signature, `arch == "x64"` (else `ARCH_UNSUPPORTED`), rate limits (§12), picks `seed`, `chainLen`, checkpoint params `(C, K)` (§5.4), and returns a **service-signed challenge**:

   ```json
   {
     "type": "bench-challenge/v1", "challengeId": "0x…", "model": "cpu/v1",
     "providerId": "0x…", "seed": "0x…", "chainLen": 15000000,
     "lanes": [
       { "laneId": "single", "workers": 1 },
       { "laneId": "quad",   "workers": 4 },
       { "laneId": "eight",  "workers": 8 },
       { "laneId": "full",   "workers": 16 }
     ],
     "checkpoints": 1024, "samples": 24,
     "issuedAt": "2026-06-04T08:00:00.000Z", "deadline": "2026-06-04T08:05:00.000Z", "attesterKey": "0x…"
   }
   ```

2. **Per lane, in order:** the provider calls `POST /v1/attest/{challengeId}/lane/{laneId}/start`. The service records `laneIssuedAt` (its own clock) and returns `{ ok: true }`. The provider computes the lane's chains and builds, per worker, a Merkle commitment over `C` checkpoints (checkpoint `j` = state after `j·(L/C)` steps). The provider then submits `POST /v1/attest/{challengeId}/lane/{laneId}` with a signed body carrying, per worker, the Merkle root and the final state `s_L`, plus the Fiat–Shamir openings (§5.4). The service records `laneReceivedAt`, verifies (§5.4), and computes `elapsedSeconds` as the difference of the two instants `laneReceivedAt − laneIssuedAt`, minus a one-way network-latency estimate from the preceding round-trip (bounded below by 0).

3. **Close.** After all four lanes verify before `deadline`, the service computes the scores, writes and signs the `CapabilityAttestation`, persists it durably, and returns it. Any lane that fails verification, misses the deadline, or exceeds the max per-lane time aborts the whole challenge with `BENCH_FAILED` (details name the lane).

Timing noise: `chainLen` is sized so each lane runs for seconds, making sub-100 ms network jitter <2 % of the measurement; the latency subtraction handles the systematic component. Scores are rounded to integer CU/s.

### 5.4 Cheap verification: checkpoint sampling

Full recomputation of every chain would cost the service as much CPU as the provider spent. Instead, verification is a non-interactive proof of sequential work:

- The provider commits to each chain via a Merkle tree over its `C` checkpoint states (root submitted with the lane).
- Sampled segment indices are derived by Fiat–Shamir: `indices = expand( keccak256( challengeId ‖ laneId ‖ allWorkerRoots ) )` → `K` distinct segments per worker. The provider cannot bias them because they are fixed by its own committed roots.
- For each sampled segment `[j, j+1)`, the provider reveals checkpoint states `c_j` and `c_{j+1}` with their Merkle paths. The service recomputes the `L/C` steps from `c_j` and checks it equals `c_{j+1}`, and checks both paths against the committed root. It also checks the final revealed checkpoint chains to the submitted `s_L`.
- **Service cost per lane** ≈ `workers × K × (L/C)` hashes — a few million, i.e. milliseconds — versus the provider's `workers × L`.

Soundness: a provider that skips a fraction `f` of a chain's steps corrupts at least `f·C` segments and is caught with probability `≈ 1 − (1−f)^K`. Parameters MUST be chosen so that skipping ≥1 % of any chain is detected with probability ≥ `1 − 2⁻⁴⁰` (e.g. `C = 1024`, `K = 24` gives ample margin; these are tunable and pinned by the reference vectors, §16).

### 5.5 RAM (declared in v0.2)

`ramGib` is a declared descriptor in v0.2; the benchmark proves CPU throughput only. The `ram` lane and its `scores.ram` slot are **reserved** now (so the attestation, query, and storage schemas are stable) but produce `null` until the work function is defined.

That work function — a memory-hardness proof: a large seeded DAG built and traversed at the start of the CPU test, in the spirit of Ethash — is planned for a later revision to bind `ramGib` to a floor and yield the `ram` score. It is deliberately unspecified here; when it lands it will extend the existing challenge/attestation flow rather than change it, and it will pin the `ram` score's unit.

### 5.6 Expiry and re-attestation

- An attestation is valid until `expiresAt` (default `measuredAt + 30 days`). Providers re-run the benchmark before expiry to keep offers live; a fresh attestation supersedes the old one for that provider.
- The service MAY issue a **surprise re-challenge** to a provider with live offers at any time (`POST`-initiated via a control channel or piggybacked on the heartbeat response). Failure to complete a re-challenge within its deadline invalidates the current attestation early, moving the provider's offers to `expired`. This narrows (but does not close) the "benchmarked on a strong box, serving on a weak box" gap; the full remedy is chain-phase stake and slashing (§15).

### 5.7 Residual risks (informative)

- **Hardware swap after attestation.** Mitigated by expiry + surprise re-challenge + the requestor's hire-time probe (§9.4); fully addressed only by stake/slashing.
- **Outsourced benchmark.** A provider could pay a faster machine to pass. Same mitigations apply; the economic cost of continually outsourcing under random re-challenge is the deterrent until stake exists.
- **Cross-provider attestation reuse.** Prevented: an attestation binds one `providerId`, and offers must originate from that same provider (§6.2).

---

## 6. Data objects

Four provider payload types exist, plus the service-signed attestation of §4.3. All provider objects are immutable once accepted; "updates" are new objects that supersede old ones by well-defined rules.

### 6.1 ProviderProfile (`type: "profile/v1"`)

Registered once; re-submission with newer `signedAt` supersedes.

```json
{
  "type": "profile/v1",
  "providerId": "0x…",
  "signedAt": "2026-06-04T08:00:00.000Z",
  "displayName": "my-node-01",
  "netEndpoints": ["p2p://…", "relay://…"],
  "heartbeatIntervalSec": 60,
  "contact": "optional string"
}
```

`heartbeatIntervalSec` is the cadence the provider promises for dynamic-terms refresh; the freshness window for its offers is derived from it (§10). Allowed range: 15–900.

### 6.2 OfferTemplate (`type: "offer/v1"`)

The static, rarely-changing part of an offer. Its hash is the **offer ID** and the unit of future on-chain commitment. It advertises a compute model and references a capability attestation instead of self-declaring hardware.

```json
{
  "type": "offer/v1",
  "providerId": "0x…",
  "signedAt": "2026-06-04T08:00:00.000Z",
  "compute": {
    "model": "cpu/v1",
    "attestationId": "0x…",     // references a CapabilityAttestation (§4.3)
    "declared": {
      "arch": "x64",
      "coreCount": 16,
      "ramGib": 64,
      "cpuModel": "AMD EPYC 9354"
    }
  },
  "pricing": {
    "model": "cpu/v1",
    "kind": "linear/v1",
    "unit": "GLM",
    "bounds": {
      "perCoreSec": { "min": "0.0000005", "max": "0.00005" },
      "perCuSec":   { "min": "0",         "max": "0.000002" },
      "start":      { "min": "0",         "max": "0.01"     }
    }
  },
  "constraintsHint": "optional free-form",
  "expiresAt": "2026-09-02T08:00:00.000Z"
}
```

Design notes.

- `compute.declared` MUST be consistent with the referenced attestation: `arch`, `coreCount`, `ramGib`, `cpuModel` must match the attestation's fields exactly, else `VALIDATION`. The declared block is duplicated into the offer only so the offer is self-describing without a second fetch; the attestation is authoritative and carries the proven `scores`.
- **Pricing** is compute-model-scoped. For `cpu/v1`: `perCoreSec` is the price per committed core-second, `perCuSec` is an optional performance-normalized price per CU-second (lets requestors compare price-per-work across heterogeneous CPUs), `start` is the per-agreement setup price. Prices are decimal strings to avoid float ambiguity in canonicalization. `bounds` declares the range within which all future dynamic terms must fall — the commitment that makes off-chain price updates verifiable and, later, slashable: two signed messages proving a violation are self-contained fraud evidence.
- `expiresAt` is a hard template expiry (max 180 days ahead); expiry requires no write. An offer is also `expired` when its referenced attestation expires (§5.6), whichever comes first.

**Validation on submit:** provider registered; `compute.model` supported; attestation exists, belongs to this `providerId`, model matches, and is unexpired (`UNKNOWN_ATTESTATION` / `ATTESTATION_EXPIRED`); declared block matches attestation; `arch == "x64"` (`ARCH_UNSUPPORTED`); active-offer cap not exceeded (`LIMIT_EXCEEDED`).

**Offer ID** `= keccak256(prefix || jcs(offerTemplatePayload))`.

### 6.3 DynamicTerms (`type: "terms/v1"`) — doubles as heartbeat

The frequently-changing part. Stored only in Redis (latest per offer), never in Postgres. Its arrival is the liveness signal.

```json
{
  "type": "terms/v1",
  "providerId": "0x…",
  "offerId": "0x…",
  "seq": 4711,
  "signedAt": "2026-06-04T08:01:00.000Z",
  "validUntil": "2026-06-04T08:04:00.000Z",
  "prices": {
    "perCoreSec": "0.000002",
    "perCuSec": "0.0000008",
    "start": "0.001"
  },
  "capacity": { "coresFree": 12 }
}
```

Validation on write: signer matches the offer's provider; every price within the template's declared `bounds` (violation → `BOUNDS_VIOLATION`, payload still logged for evidence); `validUntil − signedAt ≤ 3600 s`; `seq` strictly increasing. An offer with no unexpired DynamicTerms is **stale** and excluded from default query results (§10).

### 6.4 Revocation (`type: "revoke/v1"`)

Optional explicit withdrawal (normally silence + TTL suffices):

```json
{ "type": "revoke/v1", "providerId": "0x…", "offerId": "0x…", "signedAt": "2026-06-04T08:00:00.000Z" }
```

A revoked offer is permanently excluded from results; revocation is durable (Postgres).

---

## 7. Content addressing summary

| Object | Identifier | Signer | Mutability |
|---|---|---|---|
| ProviderProfile | `providerId` (address) | provider | superseded by newer `signedAt` |
| CapabilityAttestation | `attestationId` = hash of payload | **service** | immutable; expires or is invalidated by re-challenge |
| OfferTemplate | `offerId` = hash of payload | provider | immutable; expires (own or attestation) or is revoked |
| DynamicTerms | `(offerId, seq)` | provider | superseded by higher `seq`; expires by `validUntil` |
| Revocation | hash of payload | provider | immutable |

---

## 8. HTTP API

Base path `/v1`. All bodies are `application/json`. Provider write endpoints take the envelope of §3.4. Success responses use 200/201; errors use the format of §13.

### 8.1 Providers

`POST /v1/providers` — register or supersede a profile. 201 first time, 200 on supersession. Errors: `SIG_MISMATCH`, `STALE_PAYLOAD`, `VALIDATION`.

`GET /v1/providers/{providerId}` — current profile envelope + meta, plus unsigned aggregates and the current attestation summary:

```json
{ "envelope": {…}, "meta": {…},
  "attestation": { "id": "0x…", "model": "cpu/v1", "scores": {…}, "expiresAt": "…" } | null,
  "stats": { "activeOffers": 3, "lastSeenAt": "…", "firstSeenAt": "…" } }
```

### 8.2 Attestation (benchmark)

`POST /v1/attest/challenge` — open a benchmark run (§5.3 step 1). Body: envelope of `attest-request/v1`. Returns the service-signed `bench-challenge/v1`. Errors: `SIG_MISMATCH`, `UNKNOWN_PROVIDER`, `ARCH_UNSUPPORTED`, `RATE_LIMITED`.

`POST /v1/attest/{challengeId}/lane/{laneId}/start` — mark lane start; service records `laneIssuedAt`. Returns `{ ok: true }`. Errors: `UNKNOWN_CHALLENGE`, `VALIDATION` (wrong lane order / already started), `EXPIRED` (past deadline).

`POST /v1/attest/{challengeId}/lane/{laneId}` — submit lane proof (§5.3 step 2). Returns `{ verified: true, elapsedMs, workers }`. Errors: `UNKNOWN_CHALLENGE`, `BENCH_FAILED` (verification or timing), `EXPIRED`.

`GET /v1/attestations/{id}` — the signed attestation envelope + meta.
`GET /v1/attestations/{id}/proof` — the retained challenge + per-lane provider proofs, for independent re-verification.

### 8.3 Offers

`POST /v1/offers` — submit an OfferTemplate. Returns `{ "offerId": "0x…" }`. Idempotent for identical payloads. Errors: `SIG_MISMATCH`, `UNKNOWN_PROVIDER`, `UNKNOWN_ATTESTATION`, `ATTESTATION_EXPIRED`, `ARCH_UNSUPPORTED`, `VALIDATION`, `EXPIRED`, `LIMIT_EXCEEDED` (per-provider cap, default 50).

`GET /v1/offers/{offerId}` — full object:

```json
{
  "offerId": "0x…",
  "template":    { "envelope": {…}, "meta": {…} },
  "attestation": { "envelope": {…}, "meta": {…} },
  "terms":       { "envelope": {…}, "meta": {…} } ,
  "status": "active" | "stale" | "expired" | "revoked"
}
```

`POST /v1/offers/{offerId}/terms` — submit DynamicTerms (heartbeat). Hot path; target p99 < 15 ms. Writes only to Redis (`SET key value PX freshnessWindow`) and publishes to the offer's channel. Errors: `SIG_MISMATCH`, `UNKNOWN_OFFER`, `BOUNDS_VIOLATION`, `SEQ_REGRESSION`, `TERMS_TOO_LONG`.

`POST /v1/offers/{offerId}/revoke` — submit Revocation. Durable.

### 8.4 Query

`GET /v1/offers` — the requestor search endpoint. Filters compile to a single indexed SQL query joined with a Redis liveness lookup. Filters are model-scoped; `model` selects the schema.

```
GET /v1/offers?model=cpu/v1
              &arch=x64
              &cores.min=8
              &ram.gib.min=32
              &score.single.min=600
              &score.quad.min=2500
              &score.eight.min=5000
              &score.full.min=10000
              &score.ram.min=40000
              &price.perCoreSec.max=0.00002
              &freshness=strict|normal|any     (default: normal)
              &sort=price|score.full|score.single|score.ram|random   (default: random)
              &limit=20&cursor=…
```

Semantics: numeric fields support `.min`/`.max`; `score.*` filter against the referenced **attestation's proven scores** (a `score.ram` filter matches only attestations whose `ram` score is non-null, so until the memory-hard lane is defined it excludes everything — §5.5); `price.*` filter against **current DynamicTerms**, not template bounds; `arch` exact-match. `freshness=strict` requires terms newer than 1× the provider's interval, `normal` allows 2× + 30 s grace (§10), `any` includes stale offers (template + attestation only). Default sort is `random` within the result set to avoid herding requestors onto one provider; deterministic pagination uses a cursor over a per-query seed. `sort=score.*` ranks by proven capability.

Response is `{ "items": [ …offer objects… ], "cursor": "0x…", "nextCursor": "…" | null }`. Items match `GET /v1/offers/{offerId}`. `cursor` is the change-feed position corresponding to this snapshot — a client that wants to stay current polls §8.5 with it. `nextCursor` is the pagination cursor for the result set itself (null when exhausted). The requestor **must** verify the template and terms provider-signatures and SHOULD verify the attestation service-signature (and MAY re-verify the proof) client-side; the reference client treats unverifiable items as absent.

### 8.5 Change feed (polling)

There are no server-initiated connections. A requestor that wants to track a filter over time takes the `cursor` from its `GET /v1/offers` snapshot (§8.4) and polls:

```
GET /v1/offers/changes?<same filter object as §8.4>&since=<cursor>&wait=<0..25>&limit=<n>
```

Response:

```json
{
  "events": [
    { "event": "offer.updated", "offer": { …full offer object… } },
    { "event": "offer.stale",   "offerId": "0x…" },
    { "event": "offer.revoked", "offerId": "0x…" },
    { "event": "offer.expired", "offerId": "0x…" }
  ],
  "cursor": "0x…",     // advance your stored cursor to this
  "more": false        // true if events were truncated by limit; poll again immediately
}
```

Semantics:

- Events are the offer transitions since `since`, filtered server-side by the same criteria as the snapshot query. `offer.updated` carries the full object (new terms and/or template); the others carry only the `offerId`.
- **`wait`** is an optional long-poll hint (0–25 s, default 0). With `wait=0` the server returns immediately with whatever is pending (possibly an empty `events` array) — pure short polling. With `wait>0` the server MAY hold the request until at least one matching event is available or `wait` elapses, then return. Either way the transport is a plain HTTP request the client repeats at its own cadence; long-poll only trims latency and empty responses.
- **Cursors** are opaque, monotonic tokens over a capped feed. A `since` cursor that has aged out of the feed returns `EXPIRED_CURSOR` (409); the client recovers by re-fetching the `GET /v1/offers` snapshot and resuming from its fresh `cursor`. Clients therefore never miss state — a dropped or slow poller resyncs by snapshot, not by replaying unbounded history.
- Polling cadence is bounded only by the query rate limit (§12); a reasonable client polls every few seconds, or uses `wait` to approximate push latency without a standing connection.

### 8.6 Epochs and proofs (§11 machinery)

```
GET /v1/epochs/latest           → { "epoch": 421, "root": "0x…", "closedAt": "…", "count": 1893 }
GET /v1/epochs/{n}              → same shape
GET /v1/epochs/{n}/leaves       → paginated leaf hashes (audit)
GET /v1/offers/{offerId}/proof  → { "epoch": 421, "root": "0x…", "index": 17, "siblings": ["0x…", …] }
```

### 8.7 Operational

`GET /v1/health` → `{ "postgres": "ok", "redis": "ok|absent", "epoch": 421 }`. `GET /v1/spec` returns this document's version, the supported compute models, and the service's signing key for attestations and the transparency feed.

---

## 9. Requestor flow (normative summary)

1. Query `GET /v1/offers` with constraints (model, hardware floors, proven-score floors, price ceilings); to stay current, poll the change feed (§8.5) from the snapshot's `cursor`.
2. Verify template and terms provider-signatures locally; verify the attestation service-signature; drop failures. Optionally re-verify the benchmark proof for high-value rentals.
3. Optionally fetch and verify a merkle proof against the latest published root (mandatory once chain anchoring is live).
4. Select top-N candidates; initiate P2P negotiation with a short timeout (2–5 s). A non-responsive candidate is dropped and the next tried — this hire-time probe, not the registry, is the authoritative liveness and hardware-still-present check.
5. Agreement formation, activity, and payment proceed entirely off-registry.

---

## 10. Freshness and liveness rules

Let `I` = provider's declared `heartbeatIntervalSec` (15–900).

- Redis TTL on a terms record: `min(validUntil − now, 2·I + 30 s)`.
- An offer is **active** if an unexpired terms record exists **and** its attestation is unexpired; otherwise `stale` (no terms) or `expired` (template or attestation expired).
- `stale`/`expired` offers are excluded from default queries and emit `offer.stale` / `offer.expired` events to the change feed (§8.5), detected by Redis keyspace-expiry notifications; if unavailable, by a 10 s sweep.
- The registry never asserts liveness on its own authority: `active` means exactly "a provider-signed, unexpired terms message exists and a valid capability attestation backs it." The service cannot fabricate terms (no provider key); it signs attestations, but those are re-verifiable facts, not liveness claims.
- No server-initiated pinging of providers for liveness. Liveness truth at hire time is established by the requestor's own negotiation probe (§9.4).

---

## 11. Epochs and the commitment anchor

The batching machinery runs from day one, even though nothing is on a chain yet, so the mechanism is exercised and history is auditable.

**Epoch:** fixed 10-minute windows (epoch number = `floor(unixMinutes / 10)`). At close, the service collects the hashes of all durable objects accepted in that window — provider profiles, capability attestations, offer templates, revocations (not dynamic terms, which are ephemeral by design) — sorts them ascending, and builds a binary merkle tree (duplicate-last for odd counts; leaf = object hash; node = `keccak256(left‖right)`). Empty epochs commit the zero root.

Including attestation hashes lets a mirror detect a service that back-dates or fabricates capability scores, since the attestation is content-addressed over its scores and challenge.

**Anchor interface:**

```ts
interface CommitmentAnchor {
  publishRoot(epoch: number, root: Hex): Promise<void>;
  getRoot(epoch: number): Promise<Hex | null>;
}
```

**Phase 1 — transparency feed:** the service signs `{epoch, root, closedAt}` with its own service key and appends it to a public, append-only feed (served at `/v1/epochs/…` and mirrored to a location the operator does not solely control, e.g. a public git repository). Retroactive rewriting becomes detectable by anyone mirroring the feed.

**Phase 2 — chain:** a contract with `commitRoot(uint64 epoch, bytes32 root)` callable by the operator key, later by any staked aggregator. **Nothing above this interface changes**; clients that already verify inclusion proofs switch their root source from feed to chain.

---

## 12. Rate limiting and anti-spam

All counters in Redis, sliding window.

| Scope | Limit (default) |
|---|---|
| Terms submissions, per offer | 1 per `I/2` s, burst 3 |
| Template submissions, per provider | 20 / hour |
| Profile updates, per provider | 6 / hour |
| Benchmark challenges, per provider | 4 / day |
| Benchmark challenges, per IP | 20 / day |
| Registrations, per IP | 30 / hour |
| Queries, per IP | 600 / minute |
| Change-feed polls, per IP | shares the 600 / minute query budget |

Benchmark runs are deliberately expensive on the provider and cheap on the service (§5.4), so the abuse surface is bounded by the provider's own CPU cost; the daily caps prevent challenge-state churn. Violations return `429` with `RATE_LIMITED` and `retryAfterMs`. Limits are configuration, not protocol; they give way to stake-gating in the chain phase.

---

## 13. Error format

```json
{ "error": { "code": "BOUNDS_VIOLATION", "message": "perCuSec 0.002 exceeds template max 0.000002",
             "details": { "field": "prices.perCuSec" } } }
```

Codes: `VALIDATION`, `SIG_MISMATCH`, `STALE_PAYLOAD`, `SEQ_REGRESSION`, `UNKNOWN_PROVIDER`, `UNKNOWN_OFFER`, `UNKNOWN_ATTESTATION`, `UNKNOWN_CHALLENGE`, `ATTESTATION_EXPIRED`, `ARCH_UNSUPPORTED`, `BENCH_FAILED`, `BOUNDS_VIOLATION`, `EXPIRED`, `EXPIRED_CURSOR`, `REVOKED`, `LIMIT_EXCEEDED`, `TERMS_TOO_LONG`, `RATE_LIMITED`, `INTERNAL`. HTTP mapping: 400 validation/signature/arch/bench classes, 404 unknowns, 409 `SEQ_REGRESSION`/`STALE_PAYLOAD`/`EXPIRED_CURSOR`, 429 rate limits, 500 internal.

---

## 14. Storage schema

### PostgreSQL

```sql
create table payload_log (              -- append-only, every accepted durable object
  hash        bytea primary key,        -- keccak256(prefix || jcs(payload))
  type        text not null,
  provider_id bytea not null,
  payload     jsonb not null,           -- canonical form
  signature   bytea not null,           -- provider or service signature
  received_at timestamptz not null default now(),
  epoch       bigint not null
);

create table providers (
  provider_id  bytea primary key,
  profile_hash bytea not null references payload_log(hash),
  signed_at    timestamptz not null,     -- parsed from the payload's ISO signedAt
  heartbeat_interval_sec int not null,
  first_seen_at timestamptz not null,
  updated_at    timestamptz not null
);

create table attestations (
  attestation_id bytea primary key,      -- = attestation payload hash
  provider_id    bytea not null references providers(provider_id),
  model          text not null,          -- 'cpu/v1'
  arch           text not null,
  core_count     int  not null,
  ram_gib        numeric not null,
  cpu_model      text,
  score_single   bigint not null,        -- CU/s
  score_quad     bigint not null,
  score_eight    bigint not null,
  score_full     bigint not null,
  score_ram      bigint,                  -- memory-hard lane; null until the DAG test is defined (§5.5)
  challenge      jsonb not null,         -- retained challenge + proofs, for re-verification
  measured_at    timestamptz not null,
  expires_at     timestamptz not null,
  signature      bytea not null          -- service signature
);
create index on attestations (provider_id, expires_at);

create table offers (
  offer_id       bytea primary key,      -- = template payload hash
  provider_id    bytea not null references providers(provider_id),
  attestation_id bytea not null references attestations(attestation_id),
  template       jsonb not null,
  model          text not null,
  expires_at     timestamptz not null,   -- min(template expiry, attestation expiry)
  revoked_at     timestamptz,
  created_at     timestamptz not null,
  -- denormalized indexed columns for query compilation (from declared + attestation):
  arch text, core_count int, ram_gib numeric,
  score_single bigint, score_quad bigint, score_eight bigint, score_full bigint, score_ram bigint
);
create index on offers (model, arch, score_full, core_count) where revoked_at is null;
create index on offers (provider_id);
create index on offers (expires_at);

create table epochs (
  epoch      bigint primary key,
  root       bytea not null,
  leaf_count int not null,
  closed_at  timestamptz not null,
  anchor_ref text                         -- feed URL now; tx hash later
);
```

Price filtering against current terms happens after the SQL candidate fetch, in-process against the Redis batch lookup (candidate sets are small once hardware and score filters apply).

### Redis keys

```
terms:{offerId}        → envelope JSON        PX = freshness window   (§10)
seq:{offerId}          → last accepted seq    no expiry, rebuilt lazily
bench:{challengeId}    → challenge state + per-lane laneIssuedAt   PX = challenge deadline
rl:{scope}:{key}       → sliding-window counters
stream:offers          → capped change-feed stream (XADD MAXLEN ~; all offer events, server-side filtered per poll; cursor = stream ID)
```

---

## 15. Migration path to blockchain (informative)

| Concern | v0.2 (this spec) | Chain phase | Client change |
|---|---|---|---|
| Identity | secp256k1 address | same, + stake in registry contract | none |
| Capability | service-signed attestation over benchmark proof | attestation hash committed on-chain; challenge issuable by staked verifiers | verify attestation sig → verify on-chain commitment |
| Offer commitment | hash in transparency feed epoch root | same hash in on-chain epoch root | root source URL → chain RPC |
| Liveness | signed terms TTL + hire-time probe | unchanged | none |
| Spam control | rate limits | stake + slashing on bounds/benchmark fraud | none |
| Hardware-swap fraud | expiry + surprise re-challenge | stake slashed on failed re-challenge | none |
| Censorship | trusted operator + auditable feed | multiple staked aggregators | query N indexers, union results |

The invariant making every row work: clients never trusted the service — they verified signatures, capability proofs, and (optionally) inclusion proofs from day one.

---

## 16. Implementation notes for the Bun service

Suggested layout: `bun serve` with a thin router; `@noble/curves` + `@noble/hashes` (or `viem`) for keccak/secp256k1 recovery — native in Bun; a small JCS implementation (RFC 8785 is ~100 lines; test against the RFC vectors); `postgres` (porsager) driver with pipelining; `ioredis` or Bun's Redis client.

The benchmark is the one novel subsystem. Two artifacts must be committed to the repo before the first endpoint is written, because they are the contract with the non-JS provider agent (Rust) and with any third-party re-verifier:

1. **Reference work function + vectors:** the exact chain step (`keccak256` iteration), the checkpoint/Merkle construction, the Fiat–Shamir sampling derivation, and vectors mapping `(seed, providerId, laneId, workerIndex, chainLen)` → final state, checkpoint roots, and sampled openings. Pin `C` and `K` here.
2. **Signature/canonicalization vectors:** canonical payload → hash → signature, for every object type including the service-signed attestation and challenge.

Signature verification (~0.1 ms/op with noble) and the sampled benchmark verification (a few ms/attestation) are the only real CPU costs; heartbeats dominate volume and touch only Redis. Design for correctness first — the stateless tier makes horizontal scale free.
