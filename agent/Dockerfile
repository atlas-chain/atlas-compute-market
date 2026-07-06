# Static provider-agent image. The runtime container needs no network
# beyond the registry endpoint (BASE_URL): dependencies are baked at build
# time and TLS roots ship inside the binary (rustls + webpki).
#
#   docker build -t atlas-agent agent/
#   docker run -e BASE_URL=… -e PROVIDER_PRIVKEY=… atlas-agent

FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
# dependency layer cache: build once with empty sources
RUN mkdir src \
    && echo 'fn main() {}' > src/main.rs \
    && touch src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src
COPY src ./src
RUN touch src/main.rs src/lib.rs && cargo build --release --locked

FROM alpine:3
COPY --from=build /build/target/release/atlas-agent /usr/local/bin/atlas-agent
# exchange dir for the file transport (--exchange): a bind mount under docker,
# a 9p-mounted host volume under ya-runtime-vm (which needs it declared here)
VOLUME /exchange
# no USER: manager.py drops privileges with --user; under ya-runtime-vm the
# guest must run as root to write the 9p exchange volume (security_model=none)
ENTRYPOINT ["atlas-agent"]
