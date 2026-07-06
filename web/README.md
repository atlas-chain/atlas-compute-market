# Atlas Compute Market — dashboard

Read-only market view (stats tiles, provider directory, offer browser) for the
registry, in the shared Atlas provider-page design language. Vite + React +
TypeScript, no UI framework; data comes from the registry's unsigned read
endpoints (`/v1/stats`, `/v1/providers`, `/v1/offers`, `/v1/spec`, `/v1/health`)
by polling — the registry is polling-only by design (spec §8.5).

```sh
bun install
bun run dev     # :5173, proxies /v1 to http://localhost:8080 (override: ATLAS_API_TARGET)
bun run build   # emits dist/ — the registry serves it on non-/v1 paths
```

No data locally? Seed dummy providers: `ATLAS_DEV_SEED=10 bun start` in the repo root. Add `ATLAS_DEV_REQUESTORS=6` to also get simulated demand (the **Demand (sim)** page).
