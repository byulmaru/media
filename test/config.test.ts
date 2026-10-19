import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { app } from "../src/app";
import type { Env } from "../src/types";
import { authHeaders } from "./helpers";

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
    ["external HTTP PUBLIC_API_BASE_URL", { PUBLIC_API_BASE_URL: "http://api.example.com" }],
    ["private network HTTP PUBLIC_API_BASE_URL", { PUBLIC_API_BASE_URL: "http://10.0.0.8" }],
    ["non-loopback localhost PUBLIC_API_BASE_URL", { PUBLIC_API_BASE_URL: "http://service.localhost" }],
    ["invalid PUBLIC_API_BASE_URL", { PUBLIC_API_BASE_URL: "https://api.example.com/path" }],
    ["whitespace PUBLIC_API_BASE_URL", { PUBLIC_API_BASE_URL: " https://api.example.com " }],
    ["MEDIA", { MEDIA: undefined as unknown as Env["MEDIA"] }],
  ] satisfies [string, Partial<Env>][])('fails closed when %s is missing or invalid', async (_name, patch) => {
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

  it.each([
    ["HTTPS", "https://api.example.com"],
    ["localhost HTTP", "http://localhost:8787"],
    ["IPv4 loopback HTTP", "http://127.0.0.1:8787"],
    ["IPv6 loopback HTTP", "http://[::1]:8787"],
  ])("accepts %s PUBLIC_API_BASE_URL", async (_name, PUBLIC_API_BASE_URL) => {
    const response = await app.request(
      "https://media.example.com/v1/uploads",
      { method: "POST", headers: authHeaders, body: "{}" },
      { ...completeEnv, PUBLIC_API_BASE_URL },
    );

    expect(response.status).toBe(201);
    const ticket = await response.json() as { uploadUrl: string };
    expect(new URL(ticket.uploadUrl).origin).toBe(PUBLIC_API_BASE_URL);
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
