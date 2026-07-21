import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { app } from "../src/app";
import type { Env } from "../src/types";

const completeEnv: Env = {
  MEDIA: env.MEDIA,
  REMOTE_IMAGES: env.REMOTE_IMAGES,
  API_KEY: "test-api-key",
  UPLOAD_SIGNING_SECRET: "test-signing-secret-at-least-32-bytes",
  ALLOWED_ORIGINS: "https://app.example.com",
};

describe("Worker configuration", () => {
  it.each([
    ["API_KEY", { API_KEY: "" }],
    ["UPLOAD_SIGNING_SECRET", { UPLOAD_SIGNING_SECRET: "short" }],
    ["ALLOWED_ORIGINS", { ALLOWED_ORIGINS: "" }],
    ["invalid ALLOWED_ORIGINS", { ALLOWED_ORIGINS: "https://kos.moe/path" }],
    ["MEDIA", { MEDIA: undefined as unknown as R2Bucket }],
    ["REMOTE_IMAGES", { REMOTE_IMAGES: undefined as unknown as KVNamespace }],
  ] satisfies [string, Partial<Env>][])('fails closed when %s is missing', async (_name, patch) => {
    const response = await app.request(
      "https://media.example.com/images/u_00000000-0000-4000-8000-000000000000",
      undefined,
      { ...completeEnv, ...patch },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "configuration_error" },
    });
  });
});

describe("local R2 binding", () => {
  it("reads and writes through the isolated Miniflare binding", async () => {
    const key = `test/isolation-marker-${crypto.randomUUID()}`;
    await env.MEDIA.put(key, "marker");
    expect(await env.MEDIA.head(key)).not.toBeNull();
    await env.MEDIA.delete(key);
  });
});
