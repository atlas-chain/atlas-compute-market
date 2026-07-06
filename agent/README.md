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

## Offline container + manager (no network in docker)

For deployments where the container must not touch the network at all, the
agent supports a file-based transport (`--exchange DIR`): every registry
round-trip is written as `req-*.json` into the exchange directory and the
answer is read back from `resp-*.json` (protocol: `src/file_transport.rs`).
`manager.py` is the host-side counterpart — it spawns the container with
`--network none` and hard CPU/RAM limits, and relays the request files to the
registry over HTTPS:

```sh
python3 agent/manager.py --cpus 4 --memory-gib 8        # registers to
                                                        # compute-market.arkiv-global.net
python3 agent/manager.py --base-url http://localhost:8080 --once
```

Needs only `python3` (stdlib) and `docker`; it builds the image on first run
(`--build` to force a rebuild). `--cpus` / `--memory-gib` become both the
docker limits and the declared `CORE_COUNT` / `RAM_GIB`, so the benchmarked
capability matches what the container is actually allowed to use. The
provider key is generated *inside* the container on first run and persisted
as `provider.key` in `--state-dir` (default `~/.atlas-provider`), so identity
and attestation reuse survive restarts. `--once` / `--force-bench` /
`--price` / `--display-name` / `--heartbeat-sec` pass through to the agent;
without `--once` the manager keeps relaying heartbeats until Ctrl-C.

Trust model: the relay is as trusted as the network path in HTTP mode —
every payload is signed inside the container, so a hostile relay can at
worst deny service or slow the (server-timed) benchmark, never forge
provider messages.
