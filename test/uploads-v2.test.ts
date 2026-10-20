import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { HttpError } from "../src/errors";
import type { Env } from "../src/types";
import type { UploadInput } from "../src/upload-processing";
import { authHeaders, PNG_1X1 } from "./helpers";

class MemoryMediaStorage {
  objects = new Map<string, { httpMetadata: { contentType: string } }>();

  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { httpMetadata: object.httpMetadata } : null;
  }

  async put(key: string, _bytes: ArrayBuffer, options: { httpMetadata: { contentType?: string } }) {
    this.objects.set(key, {
      httpMetadata: { contentType: options.httpMetadata.contentType ?? "" },
    });
    return {};
  }
}

const createEnv = (media: MemoryMediaStorage): Env => ({
  MEDIA: media,
  API_KEY: "test-api-key",
  UPLOAD_SIGNING_SECRET: "test-signing-secret-at-least-32-bytes",
  ALLOWED_ORIGINS: "https://app.example.com",
  PUBLIC_BASE_URL: "https://media.byulma.run",
  PUBLIC_API_BASE_URL: "https://api.example.com",
});

async function request(
  app: ReturnType<typeof createApp>,
  env: Env,
  path: string,
  init?: RequestInit,
) {
  return app.fetch(new Request(`https://api.example.com${path}`, init), env);
}

async function createTicket(app: ReturnType<typeof createApp>, env: Env, limits = {}) {
  const response = await request(app, env, "/v2/uploads", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(limits),
  });
  expect(response.status).toBe(201);
  return await response.json() as { id: string; uploadUrl: string; expiresAt: string };
}

describe("v2 uploads", () => {
  it("issues v2 URLs, validates before processing, and reports final-object status", async () => {
    const media = new MemoryMediaStorage();
    const env = createEnv(media);
    const processed: UploadInput[] = [];
    const processor = vi.fn(async (input: UploadInput) => {
      processed.push(input);
    });
    const app = createApp(processor, true);
    const ticket = await createTicket(app, env);

    expect(new URL(ticket.uploadUrl).pathname).toMatch(/^\/v2\/uploads\//);
    expect(ticket.expiresAt).toBeTruthy();

    const rejected = await Promise.all([
      request(app, env, new URL(ticket.uploadUrl).pathname, {
        method: "PUT",
        headers: { Origin: "https://evil.example", "Content-Type": "image/png" },
        body: PNG_1X1.slice(),
      }),
      request(app, env, `${new URL(ticket.uploadUrl).pathname}x`, {
        method: "PUT",
        headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
        body: PNG_1X1.slice(),
      }),
      request(app, env, new URL(ticket.uploadUrl).pathname, {
        method: "PUT",
        headers: { Origin: "https://app.example.com", "Content-Type": "image/jpeg" },
        body: PNG_1X1.slice(),
      }),
    ]);
    expect(rejected.map((response) => response.status)).toEqual([403, 401, 415]);
    expect(processor).not.toHaveBeenCalled();

    const smallTicket = await createTicket(app, env, { maxBytes: 1 });
    const oversized = await request(app, env, new URL(smallTicket.uploadUrl).pathname, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1.slice(),
    });
    expect(oversized.status).toBe(413);
    expect(processor).not.toHaveBeenCalled();

    const uploaded = await request(app, env, new URL(ticket.uploadUrl).pathname, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1.slice(),
    });
    expect(uploaded.status).toBe(201);
    expect(uploaded.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    await expect(uploaded.json()).resolves.toEqual({
      id: ticket.id,
      url: `https://media.byulma.run/original/${ticket.id}.webp`,
    });
    expect(processed).toHaveLength(1);
    expect(processed[0]).toEqual({
      id: ticket.id,
      bytes: expect.any(ArrayBuffer),
      contentType: "image/png",
      limits: { maxBytes: 16 * 1024 * 1024, maxDimension: 8192 },
    });
    expect([...new Uint8Array(processed[0]!.bytes)]).toEqual([...PNG_1X1]);

    const pending = await request(app, env, `/v2/uploads/${ticket.id}`, {
      headers: authHeaders,
    });
    expect(pending.status).toBe(404);
    const pendingHead = await request(app, env, `/v2/uploads/${ticket.id}`, {
      method: "HEAD",
      headers: authHeaders,
    });
    expect(pendingHead.status).toBe(404);

    media.objects.set(`original/${ticket.id}.webp`, {
      httpMetadata: { contentType: "image/webp" },
    });
    const completed = await request(app, env, `/v2/uploads/${ticket.id}`, {
      headers: authHeaders,
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({
      url: `https://media.byulma.run/original/${ticket.id}.webp`,
      mediaType: "image/webp",
    });
    const completedHead = await request(app, env, `/v2/uploads/${ticket.id}`, {
      method: "HEAD",
      headers: authHeaders,
    });
    expect(completedHead.status).toBe(204);

    const duplicate = await request(app, env, new URL(ticket.uploadUrl).pathname, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1.slice(),
    });
    expect(duplicate.status).toBe(409);
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it("keeps v1 available without a processor and returns a generic v2 503", async () => {
    const env = createEnv(new MemoryMediaStorage());
    const app = createApp(undefined, true);

    const unavailable = await request(app, env, "/v2/uploads", {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      error: { code: "processing_unavailable", message: "upload processing is unavailable" },
    });

    const legacy = await request(app, env, "/v1/uploads", {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    expect(legacy.status).toBe(201);
    const legacyTicket = await legacy.json() as { uploadUrl: string };
    expect(new URL(legacyTicket.uploadUrl).pathname).toMatch(/^\/v1\/uploads\//);
  });

  it("preserves processor HTTP errors and v1 ticket creation", async () => {
    const env = createEnv(new MemoryMediaStorage());
    const processor = async () => {
      throw new HttpError(503, "processing_unavailable", "upload processing is unavailable");
    };
    const app = createApp(processor, true);
    const ticket = await createTicket(app, env);

    const failed = await request(app, env, new URL(ticket.uploadUrl).pathname, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1.slice(),
    });
    expect(failed.status).toBe(503);

    const legacy = await request(app, env, "/v1/uploads", {
      method: "POST",
      headers: authHeaders,
      body: "{}",
    });
    expect(legacy.status).toBe(201);
  });

  it("returns 409 when the processor reports an active upload", async () => {
    const env = createEnv(new MemoryMediaStorage());
    const processor = async () => {
      throw new HttpError(409, "already_uploaded", "upload URL has already been used");
    };
    const app = createApp(processor, true);
    const ticket = await createTicket(app, env);

    const response = await request(app, env, new URL(ticket.uploadUrl).pathname, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1.slice(),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "already_uploaded" },
    });
  });
});
