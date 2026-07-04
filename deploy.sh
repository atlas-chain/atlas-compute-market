#!/usr/bin/env bash
# Simple deploy script for atlas-compute-market.
# Pulls latest main, rebuilds the production stack, and verifies health.
# Run this on the production host (compute-market.arkiv-global.net).
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Pulling latest main"
git pull --ff-only origin main

echo "==> Building and starting the stack"
docker compose up -d --build --wait --wait-timeout 180

echo "==> Public health check"
curl -fsS https://compute-market.arkiv-global.net/v1/health && echo

echo "==> Deploy complete"
