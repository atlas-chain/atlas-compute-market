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

## Golem VM (ya-runtime-vm) — no yagna needed

`vm-driver/` registers the provider from inside a Golem VM instead of docker:
it drives [ya-runtime-vm](https://github.com/golemfactory/ya-runtime-vm)
v0.5.3 standalone over its runtime API (deploy → start → run), runs the agent
with `--exchange /exchange`, and relays the exchange files itself (same file
protocol as `manager.py`). The VM has **no network interface at all** — the
image must declare `VOLUME /exchange` (this Dockerfile does), which the
runtime 9p-mounts from the host.

The easiest way to run all of this is the market's one-line join, which
downloads a prebuilt static `atlas-vm-driver` and runs it (see the site's
**Join** page):

```sh
curl -fsSL https://compute-market.arkiv-global.net/join.sh | sh
```

The rest of this section covers building/running the driver yourself.

The driver is **self-contained**: with no `--runtime`/`--image` it downloads
the pinned ya-runtime-vm release and the published provider image (verified by
its SHA3-224 content hash) into a cache dir, then registers. All you need is
the binary and `/dev/kvm` access:

```sh
# once: build the driver (protoc required: apt install protobuf-compiler)
cargo build --release --manifest-path agent/vm-driver/Cargo.toml

# register — downloads runtime + image on first run, caches them after
agent/vm-driver/target/release/atlas-vm-driver \
  --cpu-cores 4 --mem-gib 8 \
  --env DISPLAY_NAME=my-vm-node -- --once
```

`--cpu-cores` / `--mem-gib` size the VM and thereby the declared/benchmarked
capability. Downloads and identity live under `~/.cache/atlas-vm-driver`
(`--cache-dir` to change): the runtime tarball, the `<hash>.gvmi`, and a
`workdir/` holding the deployment and exchange volume (with `provider.key`).
The driver reuses the workdir, so restarts keep the same identity and live
attestation; delete `<cache-dir>/workdir` for a fresh identity. It pins the
exact `ya-runtime-api` revision used by ya-runtime-vm v0.5.3, so the stdio
protocol matches the release binary.

Overrides: `--image-hash HASH` (a different published image), `--image PATH`
(a local `.gvmi`, e.g. from `docker build -t atlas-agent agent/ && gvmkit-build
atlas-agent:latest`), `--runtime PATH` (a local ya-runtime-vm binary), or
`--runtime-url URL`. `/dev/kvm` must be accessible (e.g. membership in the
`kvm` group).

## GVMI image (Golem registry)

The manually triggered **Build provider GVMI image** GitHub action
(`.github/workflows/build-gvmi.yml`) builds the docker image, converts it
with [gvmkit-build](https://github.com/golemfactory/gvmkit-build-rs)
v0.3.19 and pushes it anonymously to https://registry.golem.network. The
run's job summary shows the SDK image hash and the registry download link;
the raw `.gvmi` is also attached as a workflow artifact.
