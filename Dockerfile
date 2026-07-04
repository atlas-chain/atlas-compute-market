# syntax=docker/dockerfile:1

# Atlas Compute Market registry — Bun HTTP service (spec v0.2-draft).
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# dashboard bundle (served by the registry on non-/v1 paths)
FROM oven/bun:1.3.14-alpine AS web
WORKDIR /web
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

EXPOSE 8080
CMD ["bun", "run", "src/server.ts"]
