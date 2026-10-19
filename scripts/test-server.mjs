import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { test } from "node:test";

import { HeadObjectCommand, PutObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import { R2S3MediaStorage, startServer } from "../dist/server.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const appEnv = {
  API_KEY: "test-api-key",
  UPLOAD_SIGNING_SECRET: "test-signing-secret-at-least-32-bytes",
  ALLOWED_ORIGINS: "https://app.example.com",
  PUBLIC_BASE_URL: "https://media.byulma.run",
  PUBLIC_API_BASE_URL: "https://external-api.example.com",
  R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  R2_BUCKET_NAME: "byulmaru-media",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
};

const putOptions = {
  onlyIf: new Headers({ "If-None-Match": "*" }),
  httpMetadata: {
    contentType: "image/webp",
    cacheControl: "public, max-age=2592000, immutable",
  },
};

function s3Failure(status) {
  return new S3ServiceException({
    name: `S3 ${status}`,
    $fault: status < 500 ? "client" : "server",
    $metadata: { httpStatusCode: status },
  });
}

test("Node startup validates required config, port, and R2 endpoint", async () => {
  await assert.rejects(
    startServer({ ...appEnv, API_KEY: "" }),
    /API_KEY is required/,
  );
  const shortSigningSecret = "never-log-this-short-secret";
  await assert.rejects(
    startServer({ ...appEnv, UPLOAD_SIGNING_SECRET: shortSigningSecret }),
    (error) => error.message === "service configuration is incomplete" &&
      !error.message.includes(shortSigningSecret),
  );
  await assert.rejects(
    startServer({ ...appEnv, PORT: "0" }),
    /PORT must be an integer between 1 and 65535/,
  );
  await assert.rejects(
    startServer({ ...appEnv, PORT: "1e3" }),
    /PORT must be an integer between 1 and 65535/,
  );
  await assert.rejects(
    startServer({ ...appEnv, R2_ENDPOINT: "https://user:password@account.r2.example.com" }),
    /R2_ENDPOINT must be an HTTPS origin/,
  );
  await assert.rejects(
    startServer({ ...appEnv, PUBLIC_API_BASE_URL: "https://external-api.example.com/path" }),
    /service configuration is incomplete/,
  );
  for (const PUBLIC_API_BASE_URL of [
    "http://external-api.example.com",
    "http://10.0.0.8",
    "http://service.localhost",
    " https://external-api.example.com ",
  ]) {
    await assert.rejects(
      startServer({ ...appEnv, PUBLIC_API_BASE_URL }),
      /service configuration is incomplete/,
    );
  }
  await assert.rejects(
    startServer({ ...appEnv, ALLOWED_ORIGINS: "https://app.example.com/path" }),
    /service configuration is incomplete/,
  );
});

test("R2 S3 adapter maps metadata, missing objects, conditional conflicts, and failures", async () => {
  const headStorage = new R2S3MediaStorage(
    {
      async send(command) {
        assert(command instanceof HeadObjectCommand);
        assert.deepEqual(command.input, {
          Bucket: "byulmaru-media",
          Key: "original/u_existing.webp",
        });
        return { ContentType: "image/webp" };
      },
    },
    "byulmaru-media",
  );
  assert.deepEqual(await headStorage.head("original/u_existing.webp"), {
    httpMetadata: { contentType: "image/webp" },
  });

  const missingStorage = new R2S3MediaStorage(
    { async send() { throw s3Failure(404); } },
    "byulmaru-media",
  );
  assert.equal(await missingStorage.head("original/u_missing.webp"), null);

  for (const status of [403, 500]) {
    const failedStorage = new R2S3MediaStorage(
      { async send() { throw s3Failure(status); } },
      "byulmaru-media",
    );
    await assert.rejects(failedStorage.head("original/u_error.webp"), new RegExp(`${status}`));
  }
  const untypedHeadFailure = Object.assign(new Error("untyped S3 status 404"), {
    $metadata: { httpStatusCode: 404 },
  });
  const untypedHeadStorage = new R2S3MediaStorage(
    { async send() { throw untypedHeadFailure; } },
    "byulmaru-media",
  );
  await assert.rejects(
    untypedHeadStorage.head("original/u_untyped.webp"),
    (error) => error === untypedHeadFailure,
  );

  const commands = [];
  const putStorage = new R2S3MediaStorage(
    {
      async send(command) {
        assert(command instanceof PutObjectCommand);
        commands.push(command);
        return {};
      },
    },
    "byulmaru-media",
  );
  const bytes = Uint8Array.from([1, 2, 3]).buffer;
  assert.deepEqual(await putStorage.put("original/u_new.webp", bytes, putOptions), {});
  assert.equal(commands[0].input.Bucket, "byulmaru-media");
  assert.equal(commands[0].input.Key, "original/u_new.webp");
  assert.deepEqual(new Uint8Array(commands[0].input.Body), new Uint8Array(bytes));
  assert.equal(commands[0].input.IfNoneMatch, "*");
  assert.equal(commands[0].input.ContentType, "image/webp");
  assert.equal(commands[0].input.CacheControl, putOptions.httpMetadata.cacheControl);
  assert.equal(commands[0].input.Metadata, undefined);

  const conflictStorage = new R2S3MediaStorage(
    { async send() { throw s3Failure(412); } },
    "byulmaru-media",
  );
  assert.equal(await conflictStorage.put("original/u_conflict.webp", bytes, putOptions), null);
  const failedPutStorage = new R2S3MediaStorage(
    { async send() { throw s3Failure(500); } },
    "byulmaru-media",
  );
  await assert.rejects(
    failedPutStorage.put("original/u_error.webp", bytes, putOptions),
    (error) => error instanceof S3ServiceException && error.$metadata.httpStatusCode === 500,
  );
  const untypedPutFailure = Object.assign(new Error("untyped S3 status 412"), {
    $metadata: { httpStatusCode: 412 },
  });
  const untypedPutStorage = new R2S3MediaStorage(
    { async send() { throw untypedPutFailure; } },
    "byulmaru-media",
  );
  await assert.rejects(
    untypedPutStorage.put("original/u_untyped.webp", bytes, putOptions),
    (error) => error === untypedPutFailure,
  );

});

class MemoryMediaStorage {
  objects = new Map();

  async head(key) {
    const object = this.objects.get(key);
    return object ? { httpMetadata: object.httpMetadata } : null;
  }

  async put(key, value, options) {
    if (options.onlyIf.get("If-None-Match") !== "*") throw new Error("missing conditional create");
    if (this.objects.has(key)) return null;
    this.objects.set(key, {
      bytes: Buffer.from(value),
      httpMetadata: options.httpMetadata,
    });
    return {};
  }
}

async function findAvailablePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function sendHttp(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path, method, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("built Node server converts a PNG over HTTP and preserves upload semantics", async () => {
  const storage = new MemoryMediaStorage();

  const port = await findAvailablePort();
  const server = await startServer({ ...appEnv, PORT: String(port) }, storage);
  try {
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");

    const created = await sendHttp(address.port, "/v1/uploads", {
      method: "POST",
      headers: {
        Host: "internal.example",
        "x-forwarded-host": "spoofed.example",
        "x-forwarded-proto": "http",
        Authorization: "Bearer test-api-key",
        "Content-Type": "application/json",
      },
      body: Buffer.from("{}"),
    });
    assert.equal(created.statusCode, 201);
    const ticket = JSON.parse(created.body.toString("utf8"));
    assert.equal(new URL(ticket.uploadUrl).origin, appEnv.PUBLIC_API_BASE_URL);

    const uploadPath = new URL(ticket.uploadUrl).pathname;
    const blocked = await sendHttp(address.port, uploadPath, {
      method: "PUT",
      headers: {
        Host: "internal.example",
        Origin: "https://evil.example.com",
        "Content-Type": "image/png",
      },
      body: PNG_1X1,
    });
    assert.equal(blocked.statusCode, 403);

    const uploaded = await sendHttp(address.port, uploadPath, {
      method: "PUT",
      headers: {
        Host: "internal.example",
        Origin: "https://app.example.com",
        "Content-Type": "image/png",
      },
      body: PNG_1X1,
    });
    assert.equal(uploaded.statusCode, 201);
    assert.deepEqual(JSON.parse(uploaded.body.toString("utf8")), {
      id: ticket.id,
      url: `https://media.byulma.run/original/${ticket.id}.webp`,
    });

    const key = `original/${ticket.id}.webp`;
    const stored = storage.objects.get(key);
    assert(stored);
    assert.equal(stored.httpMetadata.contentType, "image/webp");
    assert.match(stored.httpMetadata.cacheControl, /immutable/);
    assert.equal(stored.bytes.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(stored.bytes.subarray(8, 12).toString("ascii"), "WEBP");

    const duplicate = await sendHttp(address.port, uploadPath, {
      method: "PUT",
      headers: { Host: "internal.example", Origin: "https://app.example.com", "Content-Type": "image/png" },
      body: PNG_1X1,
    });
    assert.equal(duplicate.statusCode, 409);

    const completed = await sendHttp(address.port, `/v1/uploads/${ticket.id}`, {
      method: "GET",
      headers: { Host: "internal.example", Authorization: "Bearer test-api-key" },
    });
    assert.equal(completed.statusCode, 200);
    assert.deepEqual(JSON.parse(completed.body.toString("utf8")), {
      url: `https://media.byulma.run/${key}`,
      mediaType: "image/webp",
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("built Node server accepts explicit loopback HTTP public API origins", async () => {
  for (const PUBLIC_API_BASE_URL of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ]) {
    const port = await findAvailablePort();
    const server = await startServer(
      { ...appEnv, PORT: String(port), PUBLIC_API_BASE_URL },
      new MemoryMediaStorage(),
    );
    try {
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address === "object");
      const created = await sendHttp(address.port, "/v1/uploads", {
        method: "POST",
        headers: {
          Host: "internal.example",
          "x-forwarded-host": "spoofed.example",
          "x-forwarded-proto": "http",
          Authorization: "Bearer test-api-key",
          "Content-Type": "application/json",
        },
        body: Buffer.from("{}"),
      });
      assert.equal(created.statusCode, 201);
      const ticket = JSON.parse(created.body.toString("utf8"));
      assert.equal(new URL(ticket.uploadUrl).origin, PUBLIC_API_BASE_URL);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});
