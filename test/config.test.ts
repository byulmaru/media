import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { app } from "../src/app";
import type { Env } from "../src/types";

const completeEnv: Env = {
  MEDIA: env.MEDIA,
  API_KEY: "test-api-key",
  UPLOAD_SIGNING_SECRET: "test-signing-secret-at-least-32-bytes",
  ALLOWED_ORIGINS: "https://app.example.com",
  PUBLIC_BASE_URL: "https://media.example.com",
};

describe("Worker configuration", () => {
  it.each([
    ["API_KEY", { API_KEY: "" }],
    ["UPLOAD_SIGNING_SECRET", { UPLOAD_SIGNING_SECRET: "short" }],
    ["ALLOWED_ORIGINS", { ALLOWED_ORIGINS: "" }],
    ["invalid ALLOWED_ORIGINS", { ALLOWED_ORIGINS: "https://kos.moe/path" }],
    ["PUBLIC_BASE_URL", { PUBLIC_BASE_URL: "" }],
    ["invalid PUBLIC_BASE_URL", { PUBLIC_BASE_URL: "https://media.example.com/path" }],
    ["MEDIA", { MEDIA: undefined as unknown as Env["MEDIA"] }],
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
    const media = env.MEDIA as unknown as R2Bucket;
    await media.put(key, "marker");
    expect(await media.head(key)).not.toBeNull();
    await media.delete(key);
  });
});
