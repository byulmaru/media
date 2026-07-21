import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          API_KEY: "test-api-key",
          UPLOAD_SIGNING_SECRET: "test-signing-secret-at-least-32-bytes",
          ALLOWED_ORIGINS: "https://app.example.com",
        },
      },
    }),
  ],
});
