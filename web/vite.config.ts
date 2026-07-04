import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /v1 to a locally running registry (bun start).
// Override the target with ATLAS_API_TARGET when it runs elsewhere.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": {
        target: process.env.ATLAS_API_TARGET ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
