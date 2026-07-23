import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { inspectImage } from "../src/image-info";
import { authHeaders, createUpload, PNG_1X1 } from "./helpers";

describe("media API", () => {
  const worker = (exports as unknown as { default: Fetcher }).default;

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
      url: `https://media.kos.moe/original/${ticket.id}.webp`,
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
