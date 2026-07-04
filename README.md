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

## Status

Pre-implementation. The specification is under review; the benchmark reference vectors and the canonicalization + signature module are the next deliverable.
