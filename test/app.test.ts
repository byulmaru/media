import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectImage } from "../src/image-info";
import { setRemoteRuntimeForTest } from "../src/remote";
import { authHeaders, createUpload, PNG_1X1 } from "./helpers";

describe("media API", () => {
  const worker = (exports as unknown as { default: Fetcher }).default;
  afterEach(() => {
    setRemoteRuntimeForTest();
    vi.restoreAllMocks();
  });

  it("requires authentication for write APIs", async () => {
    const upload = await worker.fetch("https://media.example.com/v1/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const remote = await worker.fetch("https://media.example.com/v1/remotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://images.example.com/avatar.png" }),
    });
    expect(upload.status).toBe(401);
    expect(remote.status).toBe(401);
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
    const unsafeRemote = await worker.fetch("https://media.example.com/v1/remotes", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: "https://127.0.0.1/avatar.png" }),
    });

    expect(malformed.status).toBe(400);
    expect(excessive.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(unsafeRemote.status).toBe(400);
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

    const duplicate = await worker.fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1,
    });
    expect(duplicate.status).toBe(409);

    const original = await worker.fetch(`https://media.example.com/images/${ticket.id}`);
    expect(original.status).toBe(200);
    expect(original.headers.get("Content-Type")).toBe("image/webp");
    expect(original.headers.get("Cache-Control")).toContain("immutable");
    expect(inspectImage(await original.arrayBuffer())).toMatchObject({
      format: "webp",
      width: 1,
      height: 1,
    });

    const thumbnail = await worker.fetch(
      `https://media.example.com/images/${ticket.id}/thumbnail`,
    );
    expect(thumbnail.status).toBe(200);
    expect(await env.MEDIA.head(`cache/upload/${ticket.id}/800.webp`)).not.toBeNull();
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

  it("stores only a cached thumbnail for remote images", async () => {
    setRemoteRuntimeForTest({
      resolve4: async () => ["93.184.216.34"],
      resolve6: async () => [],
      fetch: async () =>
        new Response(PNG_1X1.slice(), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
    });

    const registration = await worker.fetch("https://media.example.com/v1/remotes", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ url: "https://images.example.com/avatar.png" }),
    });
    expect(registration.status).toBe(201);
    const { id } = (await registration.json()) as { id: string };

    expect((await worker.fetch(`https://media.example.com/images/${id}`)).status).toBe(404);
    const thumbnail = await worker.fetch(`https://media.example.com/images/${id}/thumbnail`);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("Cache-Control")).not.toContain("immutable");
    expect(await env.MEDIA.head(`cache/remote/${id}/800.webp`)).not.toBeNull();
    expect(await env.MEDIA.head(`original/${id}.webp`)).toBeNull();
  });
});
