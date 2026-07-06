# syntax=docker/dockerfile:1

# Atlas Compute Market registry — Bun HTTP service (spec v0.2-draft).
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# provider "joiner": the self-contained VM driver, built as a static musl
# binary and served at /dl so `curl .../join.sh | sh` can fetch and run it.
FROM rust:1-alpine AS driver
RUN apk add --no-cache musl-dev protobuf protobuf-dev protoc
ENV PROTOC=/usr/bin/protoc
WORKDIR /driver
COPY agent/vm-driver/Cargo.toml agent/vm-driver/Cargo.lock ./
# dependency layer cache: compile deps once against empty sources
RUN mkdir src \
    && echo 'fn main() {}' > src/main.rs \
    && : > src/provision.rs \
    && cargo build --release --locked \
    && rm -rf src
COPY agent/vm-driver/src ./src
RUN touch src/main.rs src/provision.rs && cargo build --release --locked

# dashboard bundle (served by the registry on non-/v1 paths)
FROM oven/bun:1.3.14-alpine AS web
WORKDIR /web
ARG GIT_COMMIT=unknown
ARG GIT_COMMIT_DATE=unknown
ENV VITE_GIT_COMMIT=$GIT_COMMIT \
    VITE_GIT_COMMIT_DATE=$GIT_COMMIT_DATE
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web ./
RUN bun run build

FROM oven/bun:1.3.14-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY --from=web /web/dist ./web/dist
# publish the joiner binary + checksum alongside the dashboard, at /dl
COPY --from=driver /driver/target/release/atlas-vm-driver ./web/dist/dl/atlas-vm-driver-x86_64-linux
RUN cd web/dist/dl \
    && sha256sum atlas-vm-driver-x86_64-linux > atlas-vm-driver-x86_64-linux.sha256

EXPOSE 8080
CMD ["bun", "run", "src/server.ts"]
