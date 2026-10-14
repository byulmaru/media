import { env, exports } from "cloudflare:workers";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import webpDecodeWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import webpEncodeWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";

import { inspectImage } from "../src/image-info";
import { DEFAULT_MAX_BYTES } from "../src/constants";
import {
  authHeaders,
  createUpload,
  JPEG_2X1,
  JPEG_ORIENTED_2X1,
  PNG_1X1,
  PNG_RGBA_2X1,
  WEBP_RGBA_2X1,
} from "./helpers";

function mockedRemoteResponse(
  status: number,
  bytes: Uint8Array | null,
  headers: Record<string, string> = {},
): Response {
  let read = false;
  return {
    status,
    headers: new Headers(headers),
    body: bytes
      ? {
          getReader: () => ({
            read: async () => {
              if (read) return { done: true, value: undefined };
              read = true;
              return { done: false, value: bytes };
            },
            releaseLock: () => {},
            cancel: async () => {},
          }),
          cancel: async () => {},
        }
      : null,
  } as unknown as Response;
}

const avatarEncodeReady = (
  initWebpEncode as unknown as (module: WebAssembly.Module) => Promise<void>
)(webpEncodeWasm);

async function createLargeAvatarFixture(): Promise<Uint8Array> {
  const width = 800;
  const height = 400;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 240;
      data[offset + 1] = 32;
      data[offset + 2] = 32;
      data[offset + 3] = x < width / 4 ? 0 : 255;
    }
  }
  await avatarEncodeReady;
  const bytes = await encodeWebp(new ImageData(data, width, height), {
    quality: 80,
    method: 4,
    alpha_quality: 100,
    thread_level: 0,
  });
  return new Uint8Array(bytes);
}

describe("media API", () => {
  const worker = (exports as unknown as { default: Fetcher }).default;
  const webpReady = (
    initWebpDecode as unknown as (module: WebAssembly.Module) => Promise<void>
  )(webpDecodeWasm);

  afterEach(() => vi.restoreAllMocks());

  it("requires authentication and rejects unsafe remote URLs before fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const unauthenticated = await worker.fetch("https://media.example.com/v1/remote-avatars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://avatars.example.com/a.png" }),
    });
    expect(unauthenticated.status).toBe(401);

    const unknownField = await worker.fetch("https://media.example.com/v1/remote-avatars", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: "https://avatars.example.com/a.png", extra: true }),
    });
    expect(unknownField.status).toBe(400);

    for (const url of [
      "http://avatars.example.com/a.png",
      "https://127.0.0.1/a.png",
      "https://[::1]/a.png",
      "https://user:password@avatars.example.com/a.png",
      "https://avatars.example.com:8443/a.png",
      "https://avatars.local/a.png",
      "https://avatars.localhost/a.png",
      "https://avatars.internal/a.png",
      "https://avatar/a.png",
    ]) {
      const response = await worker.fetch("https://media.example.com/v1/remote-avatars", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ url }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_url" } });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stores a normalized remote avatar once and reuses the daily cache key", async () => {
    const source = `https://avatars.example.com/${crypto.randomUUID()}.png?size=small#ignored`;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockedRemoteResponse(200, PNG_1X1));

    const first = await worker.fetch("https://media.example.com/v1/remote-avatars", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: source }),
    });
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ mediaType: "image/webp" });

    const second = await worker.fetch("https://media.example.com/v1/remote-avatars", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: source.replace("#ignored", "#different") }),
    });
    expect(second.status).toBe(200);
    const representation = await second.json() as { url: string; mediaType: string };
    expect(representation.mediaType).toBe("image/webp");
    expect(representation.url).not.toContain(source.split("#", 1)[0]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const objects = await env.MEDIA.list({ prefix: "remote-avatar/" });
    const stored = objects.objects.find((object) => object.key === new URL(representation.url).pathname.slice(1));
    expect(stored).toBeDefined();
    const body = await env.MEDIA.get(stored!.key);
    expect(body).not.toBeNull();
    expect(body!.size).toBeLessThanOrEqual(512 * 1024);
    expect(inspectImage(await body!.arrayBuffer())).toMatchObject({
      format: "webp",
      width: 1,
      height: 1,
    });
  });

  it("shrinks a non-square remote avatar without upscaling or losing alpha", async () => {
    const source = `https://avatars.example.com/${crypto.randomUUID()}.webp`;
    const input = await createLargeAvatarFixture();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockedRemoteResponse(200, input));

    const response = await worker.fetch("https://media.example.com/v1/remote-avatars", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: source }),
    });
    expect(response.status).toBe(201);
    const representation = await response.json() as { url: string };
    const stored = await env.MEDIA.get(new URL(representation.url).pathname.slice(1));
    expect(stored).not.toBeNull();
    expect(stored!.size).toBeLessThanOrEqual(512 * 1024);

    await webpReady;
    const decoded = await decodeWebp(await stored!.arrayBuffer());
    expect(decoded).toMatchObject({ width: 400, height: 200 });
    expect(decoded.data[3]).toBe(0);
    const opaquePixel = (199 * decoded.width + 399) * 4;
    expect(decoded.data[opaquePixel + 3]).toBe(255);
    expect(decoded.data[opaquePixel]).toBeGreaterThan(200);
  });

  it("sends only the minimal image request headers and never follows redirects", async () => {
    let outboundHeaders: Headers | undefined;
    let redirectMode: RequestRedirect | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/private.png") {
        outboundHeaders = request.headers;
        redirectMode = request.redirect;
        return mockedRemoteResponse(200, PNG_1X1);
      }
      return mockedRemoteResponse(302, null, {
        Location: "https://avatars.example.com/final.png",
      });
    });

    const response = await worker.fetch("https://media.example.com/v1/remote-avatars", {
      method: "POST",
      headers: {
        ...authHeaders,
        Cookie: "session=secret",
        Forwarded: "for=127.0.0.1",
      },
      body: JSON.stringify({ url: "https://avatars.example.com/private.png" }),
    });
    expect(response.status).toBe(201);
    expect(redirectMode).toBe("manual");
    expect(outboundHeaders?.get("accept")).toBe("image/jpeg,image/png,image/webp");
    expect(outboundHeaders?.get("authorization")).toBeNull();
    expect(outboundHeaders?.get("cookie")).toBeNull();
    expect(outboundHeaders?.get("forwarded")).toBeNull();

    const redirect = await worker.fetch("https://media.example.com/v1/remote-avatars", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: "https://avatars.example.com/redirect.png" }),
    });
    expect(redirect.status).toBe(502);
  });

  it("rejects oversized bodies and bounded fetch timeouts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/large.png") {
        return mockedRemoteResponse(200, new Uint8Array(DEFAULT_MAX_BYTES + 1));
      }
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const oversized = await worker.fetch("https://media.example.com/v1/remote-avatars", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: "https://avatars.example.com/large.png" }),
    });
    expect(oversized.status).toBe(413);

    const timeout = await worker.fetch("https://media.example.com/v1/remote-avatars", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: "https://avatars.example.com/slow.png" }),
    });
    expect(timeout.status).toBe(504);
  }, 10_000);

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

  it("authenticates and validates upload completion and representation lookups", async () => {
    const id = `u_${crypto.randomUUID()}`;
    const unauthorized = await worker.fetch(`https://media.example.com/v1/uploads/${id}`, {
      method: "HEAD",
    });
    const malformed = await worker.fetch("https://media.example.com/v1/uploads/not-an-id", {
      method: "HEAD",
      headers: authHeaders,
    });
    const unauthorizedGet = await worker.fetch(`https://media.example.com/v1/uploads/${id}`);

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Cache-Control")).toBe("no-store");
    expect(await unauthorized.text()).toBe("");
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("Cache-Control")).toBe("no-store");
    expect(await malformed.text()).toBe("");
    expect(unauthorizedGet.status).toBe(401);
    expect(unauthorizedGet.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports completion only after the immutable original is stored", async () => {
    const ticket = await createUpload(worker);
    const statusUrl = `https://media.example.com/v1/uploads/${ticket.id}`;

    const pending = await worker.fetch(statusUrl, { method: "HEAD", headers: authHeaders });
    expect(pending.status).toBe(404);
    expect(pending.headers.get("Cache-Control")).toBe("no-store");
    expect(await pending.text()).toBe("");

    const missingRepresentation = await worker.fetch(statusUrl, { headers: authHeaders });
    expect(missingRepresentation.status).toBe(404);
    expect(missingRepresentation.headers.get("Cache-Control")).toBe("no-store");
    expect(await missingRepresentation.text()).toBe("");

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

    const representation = await worker.fetch(statusUrl, { headers: authHeaders });
    expect(representation.status).toBe(200);
    expect(representation.headers.get("Cache-Control")).toBe("no-store");
    await expect(representation.json()).resolves.toEqual({
      url: `https://media.byulma.run/original/${ticket.id}.webp`,
      mediaType: "image/webp",
    });
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
