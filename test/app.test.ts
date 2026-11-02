import { env, exports } from "cloudflare:workers";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import { describe, expect, it } from "vitest";

import webpDecodeWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";

import { app } from "../src/app";
import type { MediaObject, MediaStorage } from "../src/storage";
import { inspectImage } from "../src/image-info";
import type { Env } from "../src/types";
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
  const media = env.MEDIA as unknown as R2Bucket;
  const staging = env.STAGING as unknown as R2Bucket;
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
    const stagingWithByteLimit = await worker.fetch("https://media.example.com/v1/uploads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ staging: true, maxBytes: 1024 }),
    });
    const stagingWithDimensionLimit = await worker.fetch("https://media.example.com/v1/uploads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ staging: true, maxDimension: 1024 }),
    });
    const unknown = await worker.fetch("https://media.example.com/v1/uploads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ futureOption: true }),
    });

    expect(malformed.status).toBe(400);
    expect(excessive.status).toBe(400);
    expect(stagingWithByteLimit.status).toBe(400);
    expect(stagingWithDimensionLimit.status).toBe(400);
    expect(unknown.status).toBe(400);
  });

  it("stages raw uploads privately for the existing Nexus workflow", async () => {
    const ticket = await createUpload(worker, { staging: true });
    expect(Object.keys(ticket).sort()).toEqual(["expiresAt", "id", "uploadUrl"]);
    const sourceKey = `uploads/${ticket.id}/${ticket.id.slice(2)}`;
    const rawBytes = new TextEncoder().encode("not an image");
    const pending = await worker.fetch(
      `https://media.example.com/v1/uploads/${ticket.id}?staging=true`,
      { method: "HEAD", headers: authHeaders },
    );
    expect(pending.status).toBe(404);
    expect(pending.headers.get("Cache-Control")).toBe("no-store");
    expect(await pending.text()).toBe("");

    const upload = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: rawBytes,
    });

    try {
      expect(upload.status).toBe(201);
      expect(upload.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
      await expect(upload.json()).resolves.toEqual({ id: ticket.id });

      const source = await staging.get(sourceKey);
      expect(source).not.toBeNull();
      expect(source?.httpMetadata?.contentType).toBe("image/png");
      expect(new Uint8Array(await source!.arrayBuffer())).toEqual(rawBytes);

      const stagedStatus = await worker.fetch(
        `https://media.example.com/v1/uploads/${ticket.id}?staging=true`,
        { method: "HEAD", headers: authHeaders },
      );
      expect(stagedStatus.status).toBe(200);
      expect(stagedStatus.headers.get("Cache-Control")).toBe("no-store");
      expect(stagedStatus.headers.get("Content-Length")).toBe(String(source!.size));
      expect(stagedStatus.headers.get("Content-Type")).toBe("image/png");
      expect(stagedStatus.headers.get("Last-Modified")).toBe(source!.uploaded.toUTCString());
      expect(await stagedStatus.text()).toBe("");

      const stagedGet = await worker.fetch(
        `https://media.example.com/v1/uploads/${ticket.id}?staging=true`,
        { headers: authHeaders },
      );
      expect(stagedGet.status).toBe(405);
      expect(stagedGet.headers.get("Allow")).toBe("HEAD");
      expect(await stagedGet.text()).toBe("");

      expect(await staging.head(sourceKey)).not.toBeNull();
      expect(await media.get(`original/${ticket.id}.webp`)).toBeNull();
      expect((await worker.fetch(`https://media.example.com/v1/uploads/${ticket.id}`, {
        method: "HEAD",
        headers: authHeaders,
      })).status).toBe(404);
      expect((await worker.fetch(`https://media.example.com/v1/uploads/${ticket.id}`, {
        headers: authHeaders,
      })).status).toBe(404);

      const duplicate = await worker.fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
        body: rawBytes,
      });
      expect(duplicate.status).toBe(409);
    } finally {
      await staging.delete(sourceKey);
    }
  });

  it("rejects invalid staged requests without writing and accepts the byte limit", async () => {
    const ticket = await createUpload(worker, { staging: true });
    const sourceKey = `uploads/${ticket.id}/${ticket.id.slice(2)}`;
    const publicKey = `original/${ticket.id}.webp`;
    const expectNoWrites = async () => {
      expect(await staging.head(sourceKey)).toBeNull();
      expect(await media.head(publicKey)).toBeNull();
    };
    const uploadToken = new URL(ticket.uploadUrl).pathname.split("/").at(-1)!;
    const signatureStart = uploadToken.indexOf(".") + 1;
    const tamperedToken = `${uploadToken.slice(0, signatureStart)}${
      uploadToken[signatureStart] === "A" ? "B" : "A"
    }${uploadToken.slice(signatureStart + 1)}`;

    try {
      const invalidToken = await worker.fetch(
        `https://media.example.com/v1/uploads/${tamperedToken}`,
        {
          method: "PUT",
          headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
          body: PNG_1X1,
        },
      );
      expect(invalidToken.status).toBe(401);
      await expectNoWrites();

      const unsupportedType = await worker.fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: {
          Origin: "https://app.example.com",
          "Content-Type": "application/octet-stream",
        },
        body: PNG_1X1,
      });
      expect(unsupportedType.status).toBe(415);
      await expectNoWrites();

      const maxBytes = 16 * 1024 * 1024;
      const tooLarge = new Uint8Array(maxBytes + 1);
      const oversized = await worker.fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
        body: tooLarge,
      });
      expect(oversized.status).toBe(413);
      await expectNoWrites();

      const boundary = await worker.fetch(ticket.uploadUrl, {
        method: "PUT",
        headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
        body: tooLarge.subarray(0, maxBytes),
      });
      expect(boundary.status).toBe(201);
      await expect(boundary.json()).resolves.toEqual({ id: ticket.id });
      expect((await staging.head(sourceKey))?.size).toBe(maxBytes);
      expect(await media.head(publicKey)).toBeNull();
    } finally {
      await staging.delete(sourceKey);
    }
  });

  it("authenticates staging metadata reads and omits unusable stored metadata", async () => {
    const id = "u_00000000-0000-4000-8000-000000000000";
    const lookups: string[] = [];
    let stored: MediaObject | null = { httpMetadata: { contentType: "image/png" } };
    let storageFailure: Error | null = null;
    const storage: MediaStorage = {
      async head(key) {
        lookups.push(key);
        if (storageFailure) throw storageFailure;
        return stored;
      },
      async put() {
        throw new Error("staging metadata reads do not write");
      },
    };
    const bindings: Env = {
      MEDIA: env.MEDIA,
      STAGING: storage,
      API_KEY: "test-api-key",
      UPLOAD_SIGNING_SECRET: "test-signing-secret-at-least-32-bytes",
      ALLOWED_ORIGINS: "https://app.example.com",
      PUBLIC_BASE_URL: "https://media.byulma.run",
    };
    const url = `https://media.example.com/v1/uploads/${id}?staging=true`;
    const unauthorized = await app.request(url, { method: "HEAD" }, bindings);
    const invalidId = await app.request("https://media.example.com/v1/uploads/not-an-id?staging=true", {
      method: "HEAD",
      headers: authHeaders,
    }, bindings);

    expect(unauthorized.status).toBe(401);
    expect(invalidId.status).toBe(400);
    expect(lookups).toEqual([]);

    const incomplete = await app.request(url, { method: "HEAD", headers: authHeaders }, bindings);
    expect(incomplete.status).toBe(200);
    expect(incomplete.headers.get("Content-Type")).toBe("image/png");
    expect(incomplete.headers.get("Content-Length")).toBeNull();
    expect(incomplete.headers.get("Last-Modified")).toBeNull();
    expect(await incomplete.text()).toBe("");

    stored = {
      size: -1,
      uploaded: new Date(Number.NaN),
      httpMetadata: { contentType: "image/png\r\nX-Leak: true" },
    };
    const unusable = await app.request(url, { method: "HEAD", headers: authHeaders }, bindings);
    expect(unusable.status).toBe(200);
    expect(unusable.headers.get("Content-Length")).toBeNull();
    expect(unusable.headers.get("Last-Modified")).toBeNull();
    expect(unusable.headers.get("Content-Type")).toBeNull();
    expect(await unusable.text()).toBe("");

    const get = await app.request(url, { headers: authHeaders }, bindings);
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("HEAD");
    expect(await get.text()).toBe("");

    storageFailure = new Error("R2 unavailable");
    const failed = await app.request(url, { method: "HEAD", headers: authHeaders }, bindings);
    expect(failed.status).toBe(500);
    expect(failed.headers.get("Cache-Control")).toBe("no-store");
    expect(await failed.text()).toBe("");
    expect(lookups).toEqual([
      `uploads/${id}/${id.slice(2)}`,
      `uploads/${id}/${id.slice(2)}`,
      `uploads/${id}/${id.slice(2)}`,
    ]);
  });

  it("allows only one winner for concurrent staged uploads", async () => {
    const ticket = await createUpload(worker, { staging: true });
    const upload = () => worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1.slice(),
    });
    const responses = await Promise.all([upload(), upload()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it("fails closed instead of writing a staging ticket to public storage", async () => {
    const ticket = await createUpload(worker, { staging: true });
    const bindings: Env = {
      MEDIA: env.MEDIA,
      API_KEY: "test-api-key",
      UPLOAD_SIGNING_SECRET: "test-signing-secret-at-least-32-bytes",
      ALLOWED_ORIGINS: "https://app.example.com",
      PUBLIC_BASE_URL: "https://media.byulma.run",
    };
    const unavailable = await app.request("https://media.example.com/v1/uploads", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ staging: true }),
    }, bindings);
    const upload = await app.request(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1,
    }, bindings);

    const status = await app.request(
      `https://media.example.com/v1/uploads/${ticket.id}?staging=true`,
      { method: "HEAD", headers: authHeaders },
      bindings,
    );

    expect(unavailable.status).toBe(503);
    expect(upload.status).toBe(503);
    expect(status.status).toBe(503);
    expect(await media.get(`original/${ticket.id}.webp`)).toBeNull();
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

    const original = await media.get(`original/${ticket.id}.webp`);
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
    const original = await media.get(`original/${ticket.id}.webp`);
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
    const original = await media.get(`original/${ticket.id}.webp`);
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
    const original = await media.get(`original/${ticket.id}.webp`);
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
