import { env, exports } from "cloudflare:workers";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import { describe, expect, it } from "vitest";

import webpDecodeWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";

import { inspectImage } from "../src/image-info";
import {
  authHeaders,
  createUpload,
  JPEG_2X1,
  JPEG_ORIENTED_2X1,
  PNG_1X1,
  PNG_RGBA_2X1,
  WEBP_RGBA_2X1,
} from "./helpers";

describe("media API", () => {
  const worker = (exports as unknown as { default: Fetcher }).default;
  const webpReady = (
    initWebpDecode as unknown as (module: WebAssembly.Module) => Promise<void>
  )(webpDecodeWasm);

  it("requires authentication to create upload URLs", async () => {
    const upload = await worker.fetch("https://media.example.com/v1/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(upload.status).toBe(401);
  });

  it("validates JSON bodies with Zod", async () => {
    const malformed = await worker.fetch("https://media.example.com/v1/uploads", {
      method: "POST",
      headers: authHeaders,
      body: "{",
    });
    const excessive = await worker.fetch("https://media.example.com/v1/uploads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ maxBytes: 16 * 1024 * 1024 + 1 }),
    });
    const unknown = await worker.fetch("https://media.example.com/v1/uploads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ futureOption: true }),
    });

    expect(malformed.status).toBe(400);
    expect(excessive.status).toBe(400);
    expect(unknown.status).toBe(400);
  });

  it("authenticates and validates upload completion checks", async () => {
    const id = `u_${crypto.randomUUID()}`;
    const unauthorized = await worker.fetch(`https://media.example.com/v1/uploads/${id}`, {
      method: "HEAD",
    });
    const malformed = await worker.fetch("https://media.example.com/v1/uploads/not-an-id", {
      method: "HEAD",
      headers: authHeaders,
    });
    const get = await worker.fetch(`https://media.example.com/v1/uploads/${id}`, {
      headers: authHeaders,
    });

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Cache-Control")).toBe("no-store");
    expect(await unauthorized.text()).toBe("");
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("Cache-Control")).toBe("no-store");
    expect(await malformed.text()).toBe("");
    expect(get.status).toBe(405);
    expect(get.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports completion only after the immutable original is stored", async () => {
    const ticket = await createUpload(worker);
    const statusUrl = `https://media.example.com/v1/uploads/${ticket.id}`;

    const pending = await worker.fetch(statusUrl, { method: "HEAD", headers: authHeaders });
    expect(pending.status).toBe(404);
    expect(pending.headers.get("Cache-Control")).toBe("no-store");
    expect(await pending.text()).toBe("");

    const failed = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/jpeg" },
      body: PNG_1X1,
    });
    expect(failed.status).toBe(415);
    expect(
      (await worker.fetch(statusUrl, { method: "HEAD", headers: authHeaders })).status,
    ).toBe(404);

    const upload = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1,
    });
    expect(upload.status).toBe(201);

    const completed = await worker.fetch(statusUrl, { method: "HEAD", headers: authHeaders });
    expect(completed.status).toBe(204);
    expect(completed.headers.get("Cache-Control")).toBe("no-store");
    expect(await completed.text()).toBe("");
  });

  it("creates a browser upload URL and stores an immutable WebP", async () => {
    const ticket = await createUpload(worker);
    expect(ticket.id).toMatch(/^u_/);

    const upload = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: {
        Origin: "https://app.example.com",
        "Content-Type": "image/png",
      },
      body: PNG_1X1,
    });
    expect(upload.status).toBe(201);
    expect(upload.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    await expect(upload.json()).resolves.toEqual({
      id: ticket.id,
      url: `https://media.byulma.run/original/${ticket.id}.webp`,
    });

    const duplicate = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1,
    });
    expect(duplicate.status).toBe(409);

    const original = await env.MEDIA.get(`original/${ticket.id}.webp`);
    expect(original).not.toBeNull();
    expect(original?.httpMetadata?.contentType).toBe("image/webp");
    expect(original?.httpMetadata?.cacheControl).toContain("immutable");
    expect(inspectImage(await original!.arrayBuffer())).toMatchObject({
      format: "webp",
      width: 1,
      height: 1,
    });

    expect(
      (await worker.fetch(`https://media.example.com/images/${ticket.id}`)).status,
    ).toBe(404);
  });

  it.each([
    ["JPEG", "image/jpeg", JPEG_2X1],
    ["WebP", "image/webp", WEBP_RGBA_2X1],
  ] as const)("accepts and normalizes a valid %s upload", async (_name, contentType, body) => {
    const ticket = await createUpload(worker);
    const response = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": contentType },
      body,
    });

    expect(response.status).toBe(201);
    const original = await env.MEDIA.get(`original/${ticket.id}.webp`);
    expect(inspectImage(await original!.arrayBuffer())).toMatchObject({
      format: "webp",
      width: 2,
      height: 1,
    });
  });

  it("applies JPEG EXIF orientation before storing the WebP", async () => {
    const ticket = await createUpload(worker);
    const response = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/jpeg" },
      body: JPEG_ORIENTED_2X1,
    });

    expect(response.status).toBe(201);
    const original = await env.MEDIA.get(`original/${ticket.id}.webp`);
    expect(inspectImage(await original!.arrayBuffer())).toMatchObject({
      format: "webp",
      width: 1,
      height: 2,
    });
  });

  it("preserves transparent PNG alpha in the stored WebP", async () => {
    const ticket = await createUpload(worker);
    const response = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_RGBA_2X1,
    });

    expect(response.status).toBe(201);
    const original = await env.MEDIA.get(`original/${ticket.id}.webp`);
    await webpReady;
    const decoded = await decodeWebp(await original!.arrayBuffer());
    expect(decoded).toMatchObject({ width: 2, height: 1 });
    expect(decoded.data[7]).toBe(0);
  });

  it.each([
    ["PNG", "image/png", PNG_RGBA_2X1.slice(0, 30)],
    ["JPEG", "image/jpeg", JPEG_2X1.slice(0, 100)],
    ["WebP", "image/webp", WEBP_RGBA_2X1.slice(0, 25)],
  ] as const)("rejects a truncated %s upload", async (_name, contentType, body) => {
    const ticket = await createUpload(worker);
    const response = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": contentType },
      body,
    });

    expect(response.status).toBe(422);
    expect(await env.MEDIA.head(`original/${ticket.id}.webp`)).toBeNull();
  });

  it("enforces upload origin and content type", async () => {
    const ticket = await createUpload(worker);
    const blocked = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://evil.example", "Content-Type": "image/png" },
      body: PNG_1X1,
    });
    expect(blocked.status).toBe(403);

    const mismatch = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/jpeg" },
      body: PNG_1X1,
    });
    expect(mismatch.status).toBe(415);
    expect(mismatch.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );
  });

  it("allows a valid retry after a failed upload", async () => {
    const ticket = await createUpload(worker);
    const failed = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/jpeg" },
      body: PNG_1X1,
    });
    expect(failed.status).toBe(415);

    const retried = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1,
    });
    expect(retried.status).toBe(201);
    expect(await env.MEDIA.head(`original/${ticket.id}.webp`)).not.toBeNull();
  });

  it("allows only one winner for concurrent uploads", async () => {
    const ticket = await createUpload(worker);
    const upload = () =>
      worker.fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
        body: PNG_1X1.slice(),
      });
    const responses = await Promise.all([upload(), upload()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  });
});
