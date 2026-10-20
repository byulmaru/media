import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";

import { defaultPayloadConverter } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  createTemporalUploadProcessor,
  createUploadProcessingActivities,
  initializeUploadProcessingCodec,
  startServer,
} from "../dist/temporal/test-runtime.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const LIMITS = { maxBytes: 16 * 1024 * 1024, maxDimension: 8192 };
const API_ENV = {
  API_KEY: "test-api-key",
  UPLOAD_SIGNING_SECRET: "test-signing-secret-at-least-32-bytes",
  ALLOWED_ORIGINS: "https://app.example.com",
  PUBLIC_BASE_URL: "https://media.byulma.run",
  PUBLIC_API_BASE_URL: "https://api.example.com",
  R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  R2_BUCKET_NAME: "byulmaru-media",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
};

class MemoryStagingStorage {
  objects = new Map();
  putKeys = [];
  deleteKeys = [];
  readCounts = new Map();
  readGate;

  async put(key, bytes) {
    this.putKeys.push(key);
    this.objects.set(key, bytes.slice(0));
  }

  async get(key, maxBytes) {
    this.readCounts.set(key, (this.readCounts.get(key) ?? 0) + 1);
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("missing staged upload");
    if (bytes.byteLength > maxBytes) throw new RangeError("staging object exceeds maxBytes");
    const gate = this.readGate;
    if (gate) {
      this.readGate = undefined;
      gate.entered.resolve(key);
      await gate.release.promise;
    }
    return bytes.slice(0);
  }

  async delete(key) {
    this.deleteKeys.push(key);
    this.objects.delete(key);
  }
}

class MemoryMediaStorage {
  objects = new Map();
  putCounts = new Map();
  failAfterCommitKey;

  async head(key) {
    const object = this.objects.get(key);
    return object ? { httpMetadata: object.httpMetadata } : null;
  }

  async put(key, bytes, options) {
    assert.equal(options.onlyIf.get("If-None-Match"), "*");
    assert.equal(options.httpMetadata.contentType, "image/webp");
    const count = (this.putCounts.get(key) ?? 0) + 1;
    this.putCounts.set(key, count);
    if (this.objects.has(key)) return null;
    this.objects.set(key, { bytes: bytes.slice(0), httpMetadata: options.httpMetadata });
    if (this.failAfterCommitKey === key) {
      this.failAfterCommitKey = undefined;
      throw new Error("transient error after committed write");
    }
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
        response.on("end", () => resolve({
          statusCode: response.statusCode,
          body: Buffer.concat(chunks),
        }));
      },
    );
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function uploadInput(id, bytes = Uint8Array.from(PNG_1X1).buffer, contentType = "image/png") {
  return { id, bytes, contentType, limits: LIMITS };
}

function deferred() {
  let resolve;
  const promise = new Promise((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function createUploadTicket(port) {
  const response = await sendHttp(port, "/v2/uploads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_ENV.API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(LIMITS),
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body);
}

function putUploadTicket(port, ticket) {
  return sendHttp(port, new URL(ticket.uploadUrl).pathname, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: PNG_1X1,
  });
}

test("v1 server starts without Temporal configuration or a running Temporal server", async () => {
  const port = await findAvailablePort();
  const server = await startServer({ ...API_ENV, PORT: String(port) }, new MemoryMediaStorage());
  try {
    await once(server, "listening");
    const v1 = await sendHttp(port, "/v1/uploads", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_ENV.API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ maxBytes: 1024 }),
    });
    assert.equal(v1.statusCode, 201);

    const v2 = await sendHttp(port, "/v2/uploads/not-a-token", { method: "PUT" });
    assert.equal(v2.statusCode, 503);
    assert.equal(JSON.parse(v2.body).error.code, "processing_unavailable");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Temporal activities reject invalid IDs, staging keys, and limits before storage access", async () => {
  const storageCalls = [];
  const activities = createUploadProcessingActivities(
    {
      async put() { storageCalls.push("staging.put"); },
      async get() { storageCalls.push("staging.get"); return new ArrayBuffer(0); },
      async delete() { storageCalls.push("staging.delete"); },
    },
    {
      async head() { storageCalls.push("media.head"); return null; },
      async put() { storageCalls.push("media.put"); return {}; },
    },
  );
  const id = "u_00000000-0000-4000-8000-000000000001";
  const input = {
    id,
    sourceKey: `uploads/${id}/00000000-0000-4000-8000-000000000002`,
    contentType: "image/png",
    maxBytes: LIMITS.maxBytes,
    maxDimension: LIMITS.maxDimension,
  };
  const isInvalidProcessingInput = (error) => error?.type === "UploadProcessingInputError" &&
    error.nonRetryable === true &&
    error.details?.[0]?.code === "invalid_processing_input";

  await assert.rejects(
    activities.processUploadImage({ ...input, id: "invalid" }),
    isInvalidProcessingInput,
  );
  await assert.rejects(
    activities.processUploadImage({
      ...input,
      sourceKey: "uploads/u_00000000-0000-4000-8000-000000000003/00000000-0000-4000-8000-000000000004",
    }),
    isInvalidProcessingInput,
  );
  await assert.rejects(
    activities.processUploadImage({ ...input, maxDimension: LIMITS.maxDimension + 1 }),
    isInvalidProcessingInput,
  );
  await assert.rejects(
    activities.deleteUploadSource("uploads/../../private-object"),
    isInvalidProcessingInput,
  );
  await assert.rejects(
    activities.deleteUploadSource({
      id,
      sourceKey: "uploads/u_00000000-0000-4000-8000-000000000003/00000000-0000-4000-8000-000000000004",
    }),
    isInvalidProcessingInput,
  );
  assert.deepEqual(storageCalls, []);
});

test("Temporal processing retries idempotently, cleans staging, preserves only references, and allows failed workflow retry", async () => {
  await initializeUploadProcessingCodec();
  const environment = await TestWorkflowEnvironment.createLocal();
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const taskQueue = "media-upload-tests";
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace,
    taskQueue,
    workflowBundle: { codePath: resolve("dist/workflows.js") },
    activities: createUploadProcessingActivities(staging, media),
    maxConcurrentActivityTaskExecutions: 1,
  });
  const processor = createTemporalUploadProcessor(
    { address: environment.address, namespace: environment.namespace, taskQueue },
    staging,
  );
  const port = await findAvailablePort();
  const server = await startServer(
    { ...API_ENV, PORT: String(port) },
    media,
    processor.process,
  );
  let activeReadGate;
  let activeUpload;

  try {
    await once(server, "listening");
    await worker.runUntil(async () => {
      const successfulTicket = await createUploadTicket(port);
      const successfulId = successfulTicket.id;
      const successfulKey = `original/${successfulId}.webp`;
      media.failAfterCommitKey = successfulKey;
      const successfulPut = await putUploadTicket(port, successfulTicket);
      assert.equal(successfulPut.statusCode, 201);
      assert.equal(staging.objects.size, 0);
      const stored = media.objects.get(successfulKey);
      assert(stored);
      assert.equal(Buffer.from(stored.bytes).toString("ascii", 0, 4), "RIFF");
      assert.equal(Buffer.from(stored.bytes).toString("ascii", 8, 12), "WEBP");
      assert.equal(media.putCounts.get(successfulKey), 1);
      const committedInputKey = staging.putKeys.at(-1);
      assert.equal(staging.readCounts.get(committedInputKey), 1);

      const completed = await sendHttp(port, `/v2/uploads/${successfulId}`, {
        headers: { Authorization: `Bearer ${API_ENV.API_KEY}` },
      });
      assert.equal(completed.statusCode, 200);
      assert.deepEqual(JSON.parse(completed.body), {
        url: `${API_ENV.PUBLIC_BASE_URL}/${successfulKey}`,
        mediaType: "image/webp",
      });

      const history = await environment.client.workflow.getHandle(`media-upload:${successfulId}`).fetchHistory();
      const startedEvent = history.events.find((event) => event.workflowExecutionStartedEventAttributes);
      assert(startedEvent);
      const payload = startedEvent.workflowExecutionStartedEventAttributes.input.payloads[0];
      const workflowInput = defaultPayloadConverter.fromPayload(payload);
      assert.deepEqual(workflowInput, {
        id: successfulId,
        sourceKey: committedInputKey,
        contentType: "image/png",
        maxBytes: LIMITS.maxBytes,
        maxDimension: LIMITS.maxDimension,
      });
      assert.equal(Object.hasOwn(workflowInput, "bytes"), false);

      await assert.rejects(
        processor.process(uploadInput(successfulId)),
        (error) => error.status === 409 && error.code === "already_uploaded",
      );
      assert.equal(staging.objects.size, 0);
      assert.equal(staging.deleteKeys.at(-1), staging.putKeys.at(-1));
      assert.notEqual(staging.putKeys.at(-1), committedInputKey);

      const activeTicket = await createUploadTicket(port);
      activeReadGate = { entered: deferred(), release: deferred() };
      staging.readGate = activeReadGate;
      activeUpload = putUploadTicket(port, activeTicket);
      try {
        const originalInputKey = await withTimeout(
          activeReadGate.entered.promise,
          5_000,
          "original upload did not reach its blocked staging read",
        );
        assert(staging.objects.has(originalInputKey));

        const activeDuplicate = await withTimeout(
          putUploadTicket(port, activeTicket),
          5_000,
          "active duplicate upload did not return",
        );
        assert.equal(activeDuplicate.statusCode, 409);
        assert.equal(JSON.parse(activeDuplicate.body).error.code, "already_uploaded");
        const duplicateCandidateKey = staging.putKeys.at(-1);
        assert.notEqual(duplicateCandidateKey, originalInputKey);
        assert.equal(staging.objects.size, 1);
        assert(staging.objects.has(originalInputKey));
        assert(!staging.objects.has(duplicateCandidateKey));
        assert.equal(staging.deleteKeys.at(-1), duplicateCandidateKey);
      } finally {
        activeReadGate.release.resolve();
      }

      const activeResult = await withTimeout(
        activeUpload,
        5_000,
        "original upload did not finish after releasing its activity",
      );
      activeUpload = undefined;
      activeReadGate = undefined;
      assert.equal(activeResult.statusCode, 201);
      assert.equal(staging.objects.size, 0);

      const retryableId = "u_00000000-0000-4000-8000-000000000002";
      const invalidBytes = Uint8Array.from([1, 2, 3, 4]).buffer;
      await assert.rejects(
        processor.process(uploadInput(retryableId, invalidBytes)),
        (error) => error.status === 415 && error.code === "unsupported_image",
      );
      assert.equal(staging.objects.size, 0);
      const invalidInputKey = staging.putKeys.at(-1);
      assert.equal(staging.readCounts.get(invalidInputKey), 1);

      await processor.process(uploadInput(retryableId));
      assert(media.objects.has(`original/${retryableId}.webp`));
      assert.equal(staging.objects.size, 0);
      assert.equal(staging.deleteKeys.at(-1), staging.putKeys.at(-1));
    });
  } finally {
    activeReadGate?.release.resolve();
    if (activeUpload) {
      await withTimeout(activeUpload, 5_000, "active upload cleanup timed out").catch(() => undefined);
    }
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await processor.close();
    await environment.teardown();
  }
});
