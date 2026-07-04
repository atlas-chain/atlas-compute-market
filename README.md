# Atlas Compute Market

A centralized registry service for a Golem-style compute market, designed to migrate to blockchain anchoring with no change to client protocols.

The service stores provider identities and offers, serves them to requestors, and tracks provider liveness. Negotiation and agreement between requestor and provider remain peer-to-peer.

## Design principles

1. **The service stores and serves, but never vouches.** All trust-relevant data is signed by the provider's key and stored/returned verbatim.
2. **Identity is a keypair, not an account.** No passwords or server-issued sessions; authentication is a signature.
3. **Offers are content-addressed.** Object IDs are hashes of their signed payloads — the same hashes later committed to a chain in merkle batches.

## Stack

- **Bun** — HTTP / WebSocket
- **PostgreSQL** — the only durable store
- **Redis** — ephemeral state (heartbeats, rate limits, pub/sub)

## Specification

See [`docs/registry-spec.md`](docs/registry-spec.md) for the full service specification (v0.1-draft).

## Status

Pre-implementation. The specification is under review; test vectors and the canonicalization + signature module are the next deliverable.
