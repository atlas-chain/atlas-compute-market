# atlas-agent

Rust provider agent for the Atlas Compute Market. Runs the reference provider
flow (`scripts/bench-client.ts`) natively: register → benchmark (§5 keccak
chain lanes, one thread per worker) → attestation → offer → heartbeat loop.

The solver is a byte-for-byte port of `src/bench.ts`; parity is enforced by
`tests/vectors.rs` against `test/vectors/agent-vectors.json` (regenerate with
`bun run scripts/gen-bench-vectors.ts` whenever the reference changes).

## Run

```sh
cargo run --release -- --gen-key       # one-time: mint a provider key
BASE_URL=https://compute-market.arkiv-global.net \
PROVIDER_PRIVKEY=0x… \
cargo run --release                    # full flow, then heartbeats forever
```

Flags: `--once` (single heartbeat then exit), `--force-bench` (ignore a live
attestation), `--gen-key`, `--help` (lists all env vars).

On restart the agent reuses its live attestation instead of re-benchmarking
(challenges are limited to 4/day per provider), so a crash-looping container
degrades gracefully.

## Docker

```sh
docker build -t atlas-agent agent/
docker run --rm -e BASE_URL=… -e PROVIDER_PRIVKEY=… atlas-agent
```

The image is self-contained (static musl binary, bundled TLS roots): the
container needs no network access beyond `BASE_URL`, no volumes, and detects
coreCount / RAM / CPU model from `/proc` (override via env).
