import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";
import { test } from "node:test";
import sharp from "sharp";

import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { ApplicationFailure, CancelledFailure, Context, heartbeat } from "@temporalio/activity";
import { defaultPayloadConverter } from "@temporalio/client";
import { MockActivityEnvironment, TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, NativeConnection, Worker } from "@temporalio/worker";
import {
  createUploadProcessingActivities,
  createHopeHttpRequest,
  createHopeProcessingActivities,
  createMediaServiceHandler,
  DEFAULT_MAX_BYTES,
  HOPE_PROCESSING_ERROR_TYPE,
  HOPE_TASK_QUEUE,
  hopePreparedUploadKey,
  JPEG_ORIENTED_2X1,
  mediaServiceHandler,
  PNG_RGBA_2X1,
  R2S3MediaStorage,
  R2S3StagingStorage,
  runWorkerGroup,
  startWorker as startConfiguredWorker,
} from "../dist/temporal/test-runtime.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PUBLIC_BASE_URL = "https://media.byulma.run";
const TASK_QUEUE = "media-nexus-tests";
const WORKFLOW_TIMEOUT_MS = 10_000;

function hopeActivityInput(options = {}) {
  const id = options.id ?? `u_${randomUUID()}`;
  return {
    id,
    sourceKey: options.sourceKey ?? `uploads/${id}/${randomUUID()}`,
    contentType: "image/png",
    maxBytes: DEFAULT_MAX_BYTES,
    maxDimension: 8192,
    requestId: randomUUID(),
    maxEdge: 1024,
    hope: { algorithm: "nightshade", iterations: 750, intensity: 0.3 },
    ...options,
  };
}

function hopeResponse(bytes, width, height, headers = {}) {
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "image/webp",
      "x-hope-model-calls": "1",
      "x-hope-width": String(width),
      "x-hope-height": String(height),
      ...headers,
    },
  });
}

test("staging adapter maps missing metadata and bounds streamed reads", async () => {
  const lastModified = new Date("2026-10-20T00:00:00.000Z");
  const metadataStorage = new R2S3StagingStorage({
    async send(command) {
      assert(command instanceof HeadObjectCommand);
      assert.deepEqual(command.input, { Bucket: "media-staging", Key: "uploads/a" });
      return { LastModified: lastModified };
    },
  }, "media-staging");
  assert.equal(await metadataStorage.headLastModified("uploads/a"), lastModified);

  const missingStorage = new R2S3StagingStorage({
    async send(command) {
      assert(command instanceof HeadObjectCommand);
      throw new S3ServiceException({
        name: "NotFound",
        $fault: "client",
        $metadata: { httpStatusCode: 404 },
      });
    },
  }, "media-staging");
  assert.equal(await missingStorage.headLastModified("uploads/missing"), null);

  let destroyed = false;
  const oversizedByHeader = new R2S3StagingStorage({
    async send(command) {
      assert(command instanceof GetObjectCommand);
      return {
        ContentLength: 5,
        Body: Object.assign((async function* () {})(), { destroy() { destroyed = true; } }),
      };
    },
  }, "media-staging");
  await assert.rejects(oversizedByHeader.get("uploads/large", 4), /exceeds maxBytes/);
  assert.equal(destroyed, true);

  destroyed = false;
  const oversizedByStream = new R2S3StagingStorage({
    async send(command) {
      assert(command instanceof GetObjectCommand);
      return {
        Body: Object.assign((async function* () {
          yield Uint8Array.from([1, 2, 3]);
          yield Uint8Array.from([4, 5]);
        })(), { destroy() { destroyed = true; } }),
      };
    },
  }, "media-staging");
  await assert.rejects(oversizedByStream.get("uploads/large", 4), /exceeds maxBytes/);
  assert.equal(destroyed, true);

  const preparedBytes = Buffer.from("webp");
  const preparedBody = Readable.from([preparedBytes]);
  const preparedStorage = new R2S3StagingStorage({
    async send(command) {
      assert(command instanceof GetObjectCommand);
      assert.deepEqual(command.input, { Bucket: "media-staging", Key: "uploads/a.webp" });
      return { ContentType: "image/webp", ContentLength: preparedBytes.byteLength, Body: preparedBody };
    },
  }, "media-staging");
  const preparedStream = await preparedStorage.getStream("uploads/a.webp", "image/webp");
  assert.equal(preparedStream.body, preparedBody);
  assert.equal(preparedStream.contentLength, preparedBytes.byteLength);
  assert.deepEqual(Buffer.concat(await Array.fromAsync(preparedStream.body)), preparedBytes);

  for (const [label, metadata] of [
    ["content type", { ContentType: "image/png", ContentLength: 4 }],
    ["content length", { ContentType: "image/webp" }],
  ]) {
    const invalidBody = Readable.from([preparedBytes]);
    const invalidStorage = new R2S3StagingStorage({
      async send(command) {
        assert(command instanceof GetObjectCommand);
        return { ...metadata, Body: invalidBody };
      },
    }, "media-staging");
    await assert.rejects(
      invalidStorage.getStream("uploads/a.webp", "image/webp"),
      /staged object stream metadata is invalid/,
      `${label} mismatch should reject the staged stream`,
    );
    assert.equal(invalidBody.destroyed, true);
  }
});
class MemoryStagingStorage {
  objects = new Map();
  lastModifiedReads = new Map();
  contentReads = new Map();
  streamReads = new Map();
  putStreamKeys = [];
  deleteKeys = [];
  failDeleteKey;
  transientDeleteKey;
  getGate;
  putGate;

  seed(key, bytes, lastModified = new Date(), contentType = "image/png") {
    this.objects.set(key, {
      bytes: Uint8Array.from(bytes),
      lastModified,
      httpMetadata: { contentType },
    });
  }

  async head(key) {
    const object = this.objects.get(key);
    return object ? {
      httpMetadata: object.httpMetadata,
      size: object.bytes.byteLength,
      uploaded: object.lastModified,
    } : null;
  }

  async headLastModified(key) {
    this.lastModifiedReads.set(key, (this.lastModifiedReads.get(key) ?? 0) + 1);
    const object = this.objects.get(key);
    return object?.lastModified == null ? null : new Date(object.lastModified);
  }

  async get(key, maxBytes) {
    this.contentReads.set(key, (this.contentReads.get(key) ?? 0) + 1);
    const object = this.objects.get(key);
    if (!object) throw new Error("missing staged upload");
    if (object.bytes.byteLength > maxBytes) throw new RangeError("staging object exceeds maxBytes");
    if (this.getGate?.key === key) {
      this.getGate.started();
      await this.getGate.promise;
    }
    return object.bytes.slice().buffer;
  }

  async putStream(key, body, contentLength, options) {
    assert.equal(options.onlyIf.get("If-None-Match"), "*");
    this.putStreamKeys.push(key);
    if (this.objects.has(key)) return null;
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.byteLength, contentLength);
    if (this.putGate?.matches(key)) {
      this.putGate.started(key);
      await this.putGate.promise;
    }
    this.objects.set(key, {
      bytes,
      lastModified: new Date(),
      httpMetadata: options.httpMetadata,
    });
    return {};
  }

  async getStream(key, contentType) {
    this.streamReads.set(key, (this.streamReads.get(key) ?? 0) + 1);
    const object = this.objects.get(key);
    if (!object) return null;
    if (object.httpMetadata?.contentType !== contentType) {
      throw new Error("prepared image has an invalid content type");
    }
    if (!Number.isSafeInteger(object.bytes.byteLength) || object.bytes.byteLength <= 0) {
      throw new Error("prepared image has an invalid size");
    }
    if (this.getGate?.key === key) {
      this.getGate.started();
      await this.getGate.promise;
    }
    return {
      body: Readable.from([object.bytes]),
      contentLength: object.bytes.byteLength,
    };
  }

  async delete(key) {
    this.deleteKeys.push(key);
    if (this.failDeleteKey === key) {
      this.failDeleteKey = undefined;
      throw ApplicationFailure.create({
        message: "injected terminal staged-source cleanup failure",
        type: "InjectedCleanupFailure",
        nonRetryable: true,
      });
    }
    if (this.transientDeleteKey === key) {
      this.transientDeleteKey = undefined;
      throw new Error("injected transient staged-source cleanup failure");
    }
    this.objects.delete(key);
  }
}

class MemoryMediaStorage {
  objects = new Map();
  putCounts = new Map();
  streams = new Map();
  streamReads = new Map();
  failAfterCommitKey;
  failStreamKey;
  failStreamError;
  conflictKey;
  conflictHeadMisses = 0;

  async head(key) {
    if (key === this.conflictKey && this.conflictHeadMisses > 0) {
      this.conflictHeadMisses -= 1;
      if (this.conflictHeadMisses === 0) this.conflictKey = undefined;
      return null;
    }
    const object = this.objects.get(key);
    return object ? { httpMetadata: object.httpMetadata } : null;
  }

  async putStream(key, body, contentLength, options) {
    assert.equal(options.onlyIf.get("If-None-Match"), "*");
    assert.equal(options.httpMetadata.contentType, "image/webp");
    assert.equal(typeof contentLength, "number");
    this.putCounts.set(key, (this.putCounts.get(key) ?? 0) + 1);
    this.streams.set(key, body);
    if (this.failStreamKey === key) {
      this.failStreamKey = undefined;
      const error = this.failStreamError;
      this.failStreamError = undefined;
      if (error) {
        body.once("error", () => {});
        body.destroy(error);
        throw error;
      }
      throw new Error("injected media stream failure");
    }
    if (this.objects.has(key)) return null;
    const chunks = [];
    this.streamReads.set(key, (this.streamReads.get(key) ?? 0) + 1);
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.byteLength, contentLength);
    this.objects.set(key, {
      bytes,
      httpMetadata: options.httpMetadata,
    });
    if (this.failAfterCommitKey === key) {
      this.failAfterCommitKey = undefined;
      throw new Error("transient error after committed write");
    }
    return {};
  }
}

test("R2 S3 media writes stream the known-length body with create-once metadata", async () => {
  const requests = [];
  let statusCode = 200;
  const client = new S3Client({
    endpoint: "https://r2.test",
    region: "auto",
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    requestHandler: {
      async handle(request) {
        const chunks = [];
        for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
        requests.push({
          method: request.method,
          headers: { ...request.headers },
          body: Buffer.concat(chunks),
        });
        return {
          response: {
            statusCode,
            headers: {},
            body: Readable.from(statusCode === 200 ? [] : [
              "<Error><Code>PreconditionFailed</Code><Message>already exists</Message></Error>",
            ]),
          },
        };
      },
    },
  });
  const storage = new R2S3MediaStorage(client, "media");
  const bytes = Buffer.from("encoded webp bytes");
  const options = {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: {
      contentType: "image/webp",
      cacheControl: "public, max-age=31536000, immutable",
    },
  };

  assert.deepEqual(await storage.putStream("original/u_test.webp", Readable.from([bytes]), bytes.byteLength, options), {});
  const request = requests[0];
  assert.equal(request.method, "PUT");
  assert.equal(request.headers["content-length"], String(bytes.byteLength));
  assert.equal(request.headers["if-none-match"], "*");
  assert.equal(request.headers["content-type"], "image/webp");
  assert.equal(request.headers["cache-control"], options.httpMetadata.cacheControl);
  assert.equal(request.body.compare(bytes), 0);
  assert.doesNotMatch(request.headers["content-encoding"] ?? "", /aws-chunked/i);
  assert.equal(request.headers["transfer-encoding"], undefined);
  assert.equal(request.headers.trailer, undefined);
  assert.equal(request.headers["x-amz-trailer"], undefined);

  statusCode = 412;
  assert.equal(await storage.putStream("original/u_test.webp", Readable.from([bytes]), bytes.byteLength, options), null);
  assert.equal(requests[1].headers["if-none-match"], "*");

  statusCode = 500;
  await assert.rejects(
    storage.putStream("original/u_test.webp", Readable.from([bytes]), bytes.byteLength, options),
    (error) => {
      assert.equal(error.$metadata.httpStatusCode, 500);
      return true;
    },
  );
});

function uploadInput(id, sourceKey, contentType = "image/png") {
  return {
    id,
    sourceKey,
    contentType,
    maxBytes: 1024 * 1024,
    maxDimension: 8192,
  };
}

function newUpload() {
  const id = `u_${randomUUID()}`;
  return { id, sourceKey: `uploads/${id}/${randomUUID()}` };
}

function preparedKey(sourceKey) {
  return `${sourceKey}.webp`;
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("Native HTTPS Hope transport waits for headers and aborts header and body reads", async () => {
  const certificate = await readFile(new URL("../test/fixtures/hope-http-test-cert.pem", import.meta.url));
  const privateKey = await readFile(new URL("../test/fixtures/hope-http-test-key.pem", import.meta.url));
  const headerRequest = deferred();
  const headerResponseClosed = deferred();
  const bodyRequest = deferred();
  const bodyResponseClosed = deferred();
  const server = createHttpsServer({ cert: certificate, key: privateKey }, (request, response) => {
    if (request.url === "/delayed") {
      setTimeout(() => {
        response.writeHead(200, { "content-length": "2" });
        response.end("ok");
      }, 120);
      return;
    }
    if (request.url === "/headers") {
      headerRequest.resolve();
      response.on("close", headerResponseClosed.resolve);
      return;
    }
    bodyRequest.resolve();
    response.on("close", bodyResponseClosed.resolve);
    response.writeHead(200, { "content-length": "8" });
    response.flushHeaders();
    response.write("partial");
  });
  server.listen(0, "localhost");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const requestOptions = [];
  const trustedHttpsRequest = (url, options, callback) => {
    requestOptions.push(options);
    return httpsRequest(url, { ...options, ca: certificate }, callback);
  };
  const requestHope = createHopeHttpRequest(trustedHttpsRequest);
  const makeOptions = (signal) => ({
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from("request"),
    signal,
  });
  const baseUrl = `https://localhost:${address.port}`;

  try {
    const start = Date.now();
    const delayed = await requestHope(new URL("/delayed", baseUrl), makeOptions(new AbortController().signal));
    assert(Date.now() - start >= 100);
    assert.equal(await new Response(delayed.body).text(), "ok");
    assert.equal(requestOptions[0].agent, false);
    assert.equal(requestOptions[0].timeout, 0);

    const headerAbort = new AbortController();
    const waitingForHeaders = requestHope(new URL("/headers", baseUrl), makeOptions(headerAbort.signal));
    await headerRequest.promise;
    headerAbort.abort();
    await assert.rejects(waitingForHeaders, (error) => error.name === "AbortError");
    await withTimeout(headerResponseClosed.promise, WORKFLOW_TIMEOUT_MS, "aborted header request stayed open");

    const bodyAbort = new AbortController();
    const bodyResponse = await requestHope(new URL("/body", baseUrl), makeOptions(bodyAbort.signal));
    const reader = bodyResponse.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "partial");
    const waitingForBody = reader.read();
    bodyAbort.abort();
    await assert.rejects(waitingForBody);
    await withTimeout(bodyResponseClosed.promise, WORKFLOW_TIMEOUT_MS, "aborted response body stayed open");
    reader.releaseLock();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function errorCauseChain(error) {
  const messages = [];
  const seen = new Set();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.name);
    if ("type" in current && typeof current.type === "string") messages.push(current.type);
    if (current.message) messages.push(current.message);
    current = "cause" in current ? current.cause : undefined;
  }
  if (current !== undefined) messages.push(String(current));
  return messages.join(" <- ");
}

async function waitFor(predicate, message, timeoutMs = WORKFLOW_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(25);
  }
  throw new Error(message);
}

async function startWorker(
  environment,
  workflowBundle,
  staging,
  media,
  failures,
  activities,
  nexusServices = [mediaServiceHandler],
) {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace,
    taskQueue: TASK_QUEUE,
    workflowBundle: { code: workflowBundle.code },
    activities: activities ?? createUploadProcessingActivities(staging, media, PUBLIC_BASE_URL),
    nexusServices,
    maxConcurrentActivityTaskExecutions: 4,
  });
  const run = worker.run().catch((error) => { failures.push(error); });
  return { worker, run };
}

async function startHopeWorker(environment, prepareHopeUpload, failures) {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace,
    taskQueue: HOPE_TASK_QUEUE,
    activities: {
      async prepareHopeUpload(input) {
        assert.equal(input.maxEdge, 1024);
        const { cancellationSignal } = Context.current();
        const heartbeatTimer = setInterval(() => {
          if (!cancellationSignal.aborted) heartbeat();
        }, 5_000);
        try {
          cancellationSignal.throwIfAborted();
          await prepareHopeUpload(input, cancellationSignal);
          cancellationSignal.throwIfAborted();
        } finally {
          clearInterval(heartbeatTimer);
        }
      },
    },
    maxConcurrentActivityTaskExecutions: 1,
    defaultHeartbeatThrottleInterval: 5_000,
    maxHeartbeatThrottleInterval: 5_000,
  });
  const run = worker.run().catch((error) => { failures.push(error); });
  return { worker, run };
}

async function stopWorker(state) {
  state.worker.shutdown();
  await withTimeout(state.run, WORKFLOW_TIMEOUT_MS, "Temporal worker did not shut down");
}

async function startCaller(environment, endpoint, input, workflowId, timeout = "25 hours") {
  return environment.client.workflow.start("nexusUploadCallerWorkflow", {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [endpoint, input, timeout],
  });
}

async function startApplyHopeCaller(environment, endpoint, input, workflowId, timeout = "25 hours") {
  return environment.client.workflow.start("nexusApplyHopeCallerWorkflow", {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [endpoint, input, timeout],
  });
}

async function startPublishCaller(environment, endpoint, id, workflowId) {
  return environment.client.workflow.start("nexusPublishCallerWorkflow", {
    workflowId,
    taskQueue: TASK_QUEUE,
    args: [endpoint, id],
  });
}

async function awaitUploadWorkflowWaiting(environment, staging, id, sourceKey) {
  await waitFor(
    () => staging.lastModifiedReads.get(sourceKey) > 0,
    "workflow did not inspect source metadata",
  );
  await waitFor(async () => {
    if (!staging.objects.has(preparedKey(sourceKey))) return false;
    const history = await environment.client.workflow.getHandle(`media-upload:${id}`).fetchHistory();
    return history.events.some((event) => event.timerStartedEventAttributes);
  }, "upload workflow did not reach its durable publish wait");
}

function startedInput(history) {
  const event = history.events.find((item) => item.workflowExecutionStartedEventAttributes);
  assert(event);
  return defaultPayloadConverter.fromPayload(
    event.workflowExecutionStartedEventAttributes.input.payloads[0],
  );
}

test("Temporal image activity applies JPEG orientation and preserves WebP transparency", async () => {
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const activities = createUploadProcessingActivities(staging, media, PUBLIC_BASE_URL);
  const oriented = newUpload();
  const transparent = newUpload();
  staging.seed(oriented.sourceKey, JPEG_ORIENTED_2X1);
  staging.seed(transparent.sourceKey, PNG_RGBA_2X1);

  await activities.prepareUploadImage(uploadInput(oriented.id, oriented.sourceKey, "image/jpeg"));
  await activities.prepareUploadImage(uploadInput(transparent.id, transparent.sourceKey));

  const orientedPrepared = staging.objects.get(preparedKey(oriented.sourceKey));
  const transparentPrepared = staging.objects.get(preparedKey(transparent.sourceKey));
  assert(orientedPrepared);
  assert(transparentPrepared);
  assert.equal(orientedPrepared.httpMetadata.contentType, "image/webp");
  assert.equal(transparentPrepared.httpMetadata.contentType, "image/webp");
  assert.equal(media.objects.size, 0);

  await activities.publishPreparedUpload(uploadInput(oriented.id, oriented.sourceKey, "image/jpeg"));
  await activities.publishPreparedUpload(uploadInput(transparent.id, transparent.sourceKey));

  const orientedImage = media.objects.get(`original/${oriented.id}.webp`);
  assert(orientedImage);
  assert.deepEqual(orientedImage.bytes, orientedPrepared.bytes);
  assert.equal(media.streamReads.get(`original/${oriented.id}.webp`), 1);
  assert.equal(media.streams.get(`original/${oriented.id}.webp`).destroyed, true);
  const orientedMetadata = await sharp(orientedImage.bytes).metadata();
  assert.equal(orientedMetadata.format, "webp");
  assert.equal(orientedMetadata.width, 1);
  assert.equal(orientedMetadata.height, 2);
  assert.equal(orientedMetadata.orientation, undefined);
  assert.equal(orientedMetadata.exif, undefined);

  const transparentImage = media.objects.get(`original/${transparent.id}.webp`);
  assert(transparentImage);
  assert.deepEqual(transparentImage.bytes, transparentPrepared.bytes);
  assert.equal(media.streamReads.get(`original/${transparent.id}.webp`), 1);
  assert.equal(media.streams.get(`original/${transparent.id}.webp`).destroyed, true);
  const decoded = await sharp(transparentImage.bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, 2);
  assert.equal(decoded.info.height, 1);
  assert.equal(decoded.data[7], 0);
});

test("legacy image activity returns an existing public object without staged reads or writes", async () => {
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const activities = createUploadProcessingActivities(staging, media, PUBLIC_BASE_URL);
  const existing = newUpload();
  const outputKey = `original/${existing.id}.webp`;
  const existingBytes = Buffer.from("already-published-webp");
  media.objects.set(outputKey, {
    bytes: existingBytes,
    httpMetadata: { contentType: "image/webp" },
  });

  assert.deepEqual(
    await activities.processUploadImage(uploadInput(existing.id, existing.sourceKey)),
    {
      id: existing.id,
      url: `${PUBLIC_BASE_URL}/${outputKey}`,
      mediaType: "image/webp",
    },
  );
  assert.deepEqual(media.objects.get(outputKey).bytes, existingBytes);
  assert.equal(staging.contentReads.get(existing.sourceKey) ?? 0, 0);
  assert.equal(staging.objects.has(preparedKey(existing.sourceKey)), false);
  assert.deepEqual(staging.putStreamKeys, []);
  assert.equal(media.putCounts.get(outputKey) ?? 0, 0);
  assert.equal(media.streamReads.get(outputKey) ?? 0, 0);
});

test("prepared publication retries a public write without rereading or reencoding staged bytes", async () => {
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const activities = createUploadProcessingActivities(staging, media, PUBLIC_BASE_URL);
  const source = newUpload();
  const input = uploadInput(source.id, source.sourceKey);
  const preparedObjectKey = preparedKey(source.sourceKey);
  const outputKey = `original/${source.id}.webp`;
  staging.seed(source.sourceKey, PNG_1X1);

  await activities.prepareUploadImage(input);
  const preparedBytes = Buffer.from(staging.objects.get(preparedObjectKey).bytes);
  assert.equal(staging.contentReads.get(source.sourceKey), 1);
  assert.deepEqual(staging.putStreamKeys, [preparedObjectKey]);
  staging.objects.delete(source.sourceKey);

  const storageError = new Error("injected public storage transport failure");
  media.failStreamKey = outputKey;
  media.failStreamError = storageError;
  await assert.rejects(
    activities.publishPreparedUpload(input),
    (error) => error === storageError,
  );
  const failedStream = media.streams.get(outputKey);
  assert(failedStream.destroyed);
  assert.equal(media.objects.has(outputKey), false);
  assert.equal(staging.objects.has(source.sourceKey), false);
  assert.equal(staging.contentReads.get(source.sourceKey), 1);
  assert.deepEqual(staging.putStreamKeys, [preparedObjectKey]);

  assert.deepEqual(await activities.publishPreparedUpload(input), {
    id: source.id,
    url: `${PUBLIC_BASE_URL}/${outputKey}`,
    mediaType: "image/webp",
  });
  assert.deepEqual(media.objects.get(outputKey).bytes, preparedBytes);
  assert.equal(media.putCounts.get(outputKey), 2);
  assert.equal(media.streamReads.get(outputKey), 1);
  assert.equal(media.streams.get(outputKey).destroyed, true);
  assert.equal(staging.contentReads.get(source.sourceKey), 1);
  assert.deepEqual(staging.putStreamKeys, [preparedObjectKey]);
});

test("Temporal activity classifies native malformed decodes as non-retryable invalid_image without a public write", async () => {
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const activities = createUploadProcessingActivities(staging, media, PUBLIC_BASE_URL);
  const malformed = newUpload();
  staging.seed(malformed.sourceKey, PNG_RGBA_2X1.slice(0, 30));

  await assert.rejects(
    activities.prepareUploadImage(uploadInput(malformed.id, malformed.sourceKey)),
    (error) => {
      assert(error instanceof ApplicationFailure);
      assert.equal(error.type, "UploadValidationError");
      assert.equal(error.nonRetryable, true);
      assert.deepEqual(error.details, [{ status: 422, code: "invalid_image" }]);
      return true;
    },
  );
  assert.equal(media.putCounts.get(`original/${malformed.id}.webp`) ?? 0, 0);
  assert.equal(media.objects.has(`original/${malformed.id}.webp`), false);
  assert.equal(staging.objects.has(preparedKey(malformed.sourceKey)), false);
  assert.equal(staging.contentReads.get(malformed.sourceKey), 1);
  assert.equal(media.streams.size, 0);
});

test("Temporal activity destroys an unconsumed WebP stream after a conditional conflict or storage error", async () => {
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const activities = createUploadProcessingActivities(staging, media, PUBLIC_BASE_URL);
  const conflict = newUpload();
  const conflictKey = `original/${conflict.id}.webp`;
  staging.seed(conflict.sourceKey, PNG_1X1);
  media.objects.set(conflictKey, {
    bytes: Buffer.from("already committed"),
    httpMetadata: { contentType: "image/webp" },
  });
  media.conflictKey = conflictKey;
  media.conflictHeadMisses = 2;
  await activities.processUploadImage(uploadInput(conflict.id, conflict.sourceKey));
  assert.equal(media.putCounts.get(conflictKey), 1);
  assert.equal(media.streamReads.get(conflictKey) ?? 0, 0);
  assert.equal(media.streams.get(conflictKey).destroyed, true);

  const failed = newUpload();
  const failedKey = `original/${failed.id}.webp`;
  staging.seed(failed.sourceKey, PNG_1X1);
  media.failStreamKey = failedKey;
  await assert.rejects(
    activities.processUploadImage(uploadInput(failed.id, failed.sourceKey)),
    /injected media stream failure/,
  );
  assert.equal(media.putCounts.get(failedKey), 1);
  assert.equal(media.streamReads.get(failedKey) ?? 0, 0);
  assert.equal(media.streams.get(failedKey).destroyed, true);
  assert.equal(media.objects.has(failedKey), false);

  const transportFailed = newUpload();
  const transportFailedKey = `original/${transportFailed.id}.webp`;
  const transportError = new Error("injected R2 request failure");
  staging.seed(transportFailed.sourceKey, PNG_1X1);
  media.failStreamKey = transportFailedKey;
  media.failStreamError = transportError;
  await assert.rejects(
    activities.processUploadImage(uploadInput(transportFailed.id, transportFailed.sourceKey)),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof ApplicationFailure, false);
      return true;
    },
  );
  assert.equal(media.putCounts.get(transportFailedKey), 1);
  assert.equal(media.streams.get(transportFailedKey).destroyed, true);
});

test("markerless legacy history replays without preparing until publish is signaled", async () => {
  const legacyWorkflowBundle = await bundleWorkflowCode({
    workflowsPath: resolve("scripts/fixtures/legacy-upload-workflow.ts"),
  });
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: resolve("scripts/temporal-test-workflow.ts"),
  });
  const executable = process.env.TEMPORAL_CLI_PATH
    ? { type: "existing-path", path: process.env.TEMPORAL_CLI_PATH }
    : { type: "cached-download" };
  const environment = await TestWorkflowEnvironment.createLocal({ server: { executable } });
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const workerFailures = [];
  const source = newUpload();
  const input = uploadInput(source.id, source.sourceKey);
  staging.seed(source.sourceKey, PNG_1X1);
  let worker;

  try {
    worker = await startWorker(environment, legacyWorkflowBundle, staging, media, workerFailures);
    const handle = await environment.client.workflow.start("processUploadWorkflow", {
      workflowId: `legacy-replay:${source.id}`,
      taskQueue: TASK_QUEUE,
      args: [input],
    });

    await waitFor(async () => {
      const history = await handle.fetchHistory();
      return history.events.some((event) => event.timerStartedEventAttributes);
    }, "legacy workflow did not reach its durable publish wait");
    const legacyHistory = await handle.fetchHistory();
    assert.equal(legacyHistory.events.some((event) => event.markerRecordedEventAttributes), false);
    assert.equal(staging.contentReads.get(source.sourceKey) ?? 0, 0);
    assert.equal(staging.objects.has(preparedKey(source.sourceKey)), false);
    assert.equal(media.objects.has(`original/${source.id}.webp`), false);

    await stopWorker(worker);
    const calls = { prepare: 0, publish: 0, process: 0 };
    const baseActivities = createUploadProcessingActivities(staging, media, PUBLIC_BASE_URL);
    let preparedBytes;
    const trackedActivities = {
      ...baseActivities,
      async prepareUploadImage(activityInput) {
        calls.prepare += 1;
        return baseActivities.prepareUploadImage(activityInput);
      },
      async publishPreparedUpload(activityInput) {
        calls.publish += 1;
        return baseActivities.publishPreparedUpload(activityInput);
      },
      async processUploadImage(activityInput) {
        calls.process += 1;
        const result = await baseActivities.processUploadImage(activityInput);
        preparedBytes = Buffer.from(staging.objects.get(preparedKey(source.sourceKey)).bytes);
        return result;
      },
    };
    worker = await startWorker(
      environment,
      workflowBundle,
      staging,
      media,
      workerFailures,
      trackedActivities,
    );

    await handle.signal("publishUpload");
    const result = await withTimeout(handle.result(), WORKFLOW_TIMEOUT_MS, "legacy history did not replay and publish");
    const outputKey = `original/${source.id}.webp`;
    assert.equal(result.id, source.id);
    assert.equal(calls.process, 1);
    assert.equal(calls.prepare, 0);
    assert.equal(calls.publish, 0);
    assert.deepEqual(media.objects.get(outputKey).bytes, preparedBytes);
    assert.equal(staging.objects.has(source.sourceKey), false);
    assert.equal(staging.objects.has(preparedKey(source.sourceKey)), false);
    assert.deepEqual(staging.deleteKeys, [preparedKey(source.sourceKey), source.sourceKey]);
    assert.deepEqual(workerFailures, []);
  } finally {
    if (worker) await stopWorker(worker).catch(() => undefined);
    await environment.teardown();
  }
});

test("prepared-before-wait history replays with the Hope-aware workflow", async () => {
  const preparedWorkflowBundle = await bundleWorkflowCode({
    workflowsPath: resolve("scripts/fixtures/pre-hope-prepared-upload-workflow.ts"),
  });
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: resolve("scripts/temporal-test-workflow.ts"),
  });
  const executable = process.env.TEMPORAL_CLI_PATH
    ? { type: "existing-path", path: process.env.TEMPORAL_CLI_PATH }
    : { type: "cached-download" };
  const environment = await TestWorkflowEnvironment.createLocal({ server: { executable } });
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const workerFailures = [];
  const previousCalls = { prepare: 0 };
  const source = newUpload();
  const input = uploadInput(source.id, source.sourceKey);
  const defaultKey = preparedKey(source.sourceKey);
  const publicKey = `original/${source.id}.webp`;
  staging.seed(source.sourceKey, PNG_1X1);
  let worker;

  try {
    const previousActivities = createUploadProcessingActivities(staging, media, PUBLIC_BASE_URL);
    worker = await startWorker(
      environment,
      preparedWorkflowBundle,
      staging,
      media,
      workerFailures,
      {
        ...previousActivities,
        async prepareUploadImage(activityInput) {
          previousCalls.prepare += 1;
          return previousActivities.prepareUploadImage(activityInput);
        },
      },
    );
    const handle = await environment.client.workflow.start("processUploadWorkflow", {
      workflowId: `prepared-replay:${source.id}`,
      taskQueue: TASK_QUEUE,
      args: [input],
    });

    await waitFor(async () => {
      if (!staging.objects.has(defaultKey)) return false;
      const history = await handle.fetchHistory();
      return history.events.some((event) => event.timerStartedEventAttributes);
    }, "prepared workflow did not reach its durable publish wait");
    const previousHistory = await handle.fetchHistory();
    assert.equal(previousCalls.prepare, 1);
    assert(previousHistory.events.some((event) => event.markerRecordedEventAttributes));
    assert.equal(staging.contentReads.get(source.sourceKey), 1);
    assert.equal(media.objects.has(publicKey), false);
    const preparedBytes = Buffer.from(staging.objects.get(defaultKey).bytes);

    await stopWorker(worker);
    worker = undefined;
    const nextCalls = { prepare: 0, publish: 0, process: 0 };
    const nextActivities = createUploadProcessingActivities(staging, media, PUBLIC_BASE_URL);
    worker = await startWorker(
      environment,
      workflowBundle,
      staging,
      media,
      workerFailures,
      {
        ...nextActivities,
        async prepareUploadImage(activityInput) {
          nextCalls.prepare += 1;
          return nextActivities.prepareUploadImage(activityInput);
        },
        async publishPreparedUpload(activityInput) {
          nextCalls.publish += 1;
          return nextActivities.publishPreparedUpload(activityInput);
        },
        async processUploadImage(activityInput) {
          nextCalls.process += 1;
          return nextActivities.processUploadImage(activityInput);
        },
      },
    );

    await handle.signal("publishUpload");
    const result = await withTimeout(
      handle.result(),
      WORKFLOW_TIMEOUT_MS,
      "prepared history did not replay and publish",
    );
    assert.equal(result.id, source.id);
    assert.deepEqual(nextCalls, { prepare: 0, publish: 1, process: 0 });
    assert.equal(staging.streamReads.get(defaultKey), 1);
    assert.deepEqual(media.objects.get(publicKey).bytes, preparedBytes);
    assert.equal(staging.objects.has(source.sourceKey), false);
    assert.equal(staging.objects.has(defaultKey), false);
    assert.deepEqual(staging.deleteKeys, [defaultKey, source.sourceKey]);
    assert.deepEqual(workerFailures, []);
  } finally {
    if (worker) await stopWorker(worker).catch(() => undefined);
    await environment.teardown();
  }
});

test("Nexus upload operations wait, publish idempotently, and clean up terminal workflows", async () => {
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: resolve("scripts/temporal-test-workflow.ts"),
  });
  const executable = process.env.TEMPORAL_CLI_PATH
    ? { type: "existing-path", path: process.env.TEMPORAL_CLI_PATH }
    : { type: "cached-download" };
  const environment = await TestWorkflowEnvironment.createLocal({
    server: { executable },
  });
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const workerFailures = [];
  const endpointName = `media-test-${randomUUID()}`;
  const endpoint = await environment.createNexusEndpoint(endpointName, TASK_QUEUE);
  let worker;

  try {
    worker = await startWorker(environment, workflowBundle, staging, media, workerFailures);

    const invalid = newUpload();
    const invalidInput = uploadInput(invalid.id, `uploads/${newUpload().id}/${randomUUID()}`);
    const invalidCaller = await startCaller(
      environment,
      endpointName,
      invalidInput,
      `invalid-caller:${randomUUID()}`,
      "3 seconds",
    );
    const invalidResult = await withTimeout(invalidCaller.result(), 5_000, "invalid refs did not fail");
    assert.match(invalidResult.error, /upload input is invalid/i);
    assert.equal(staging.lastModifiedReads.size, 0);
    assert.equal(staging.contentReads.size, 0);
    assert.deepEqual(staging.deleteKeys, []);

    const beforeMalformed = {
      metadataReads: staging.lastModifiedReads.size,
      contentReads: staging.contentReads.size,
      deletes: staging.deleteKeys.length,
    };
    for (const [label, args] of [["null", [null]], ["undefined", []]]) {
      const malformed = await environment.client.workflow.start("processUploadWorkflow", {
        workflowId: `malformed-${label}:${randomUUID()}`,
        taskQueue: TASK_QUEUE,
        args,
      });
      await assert.rejects(
        withTimeout(malformed.result(), 5_000, `raw ${label} input did not fail promptly`),
        (error) => {
          assert.match(errorCauseChain(error), /UploadProcessingInputError/);
          return true;
        },
      );
      const malformedHistory = await malformed.fetchHistory();
      assert(malformedHistory.events.some((event) => event.workflowExecutionFailedEventAttributes));
      assert.equal(
        malformedHistory.events.some((event) => event.workflowExecutionTimedOutEventAttributes),
        false,
      );
    }
    assert.deepEqual({
      metadataReads: staging.lastModifiedReads.size,
      contentReads: staging.contentReads.size,
      deletes: staging.deleteKeys.length,
    }, beforeMalformed);

    const missingPublishId = newUpload().id;
    const missingPublish = await environment.client.workflow.start("nexusPublishCallerWorkflow", {
      workflowId: `publish-missing:${randomUUID()}`,
      taskQueue: TASK_QUEUE,
      args: [endpointName, missingPublishId],
    });
    const missingPublishResult = await withTimeout(
      missingPublish.result(),
      5_000,
      "publish of a missing upload did not fail promptly",
    );
    assert.match(missingPublishResult.error, /upload workflow was not found/i);
    assert.equal(staging.lastModifiedReads.size, 0);

    const blocked = newUpload();
    const concurrent = newUpload();
    staging.seed(blocked.sourceKey, PNG_1X1);
    staging.seed(concurrent.sourceKey, PNG_1X1);
    let releaseBlockedGet;
    let announceBlockedGet;
    const blockedGetStarted = new Promise((resolve) => { announceBlockedGet = resolve; });
    const blockedGet = new Promise((resolve) => { releaseBlockedGet = resolve; });
    staging.getGate = {
      key: blocked.sourceKey,
      started: announceBlockedGet,
      promise: blockedGet,
    };
    let blockedResultPromise;
    let blockedCompleted = false;
    let blockedCaller;
    try {
      blockedCaller = await startCaller(
        environment,
        endpointName,
        uploadInput(blocked.id, blocked.sourceKey),
        `blocked-caller:${randomUUID()}`,
      );
      await withTimeout(blockedGetStarted, WORKFLOW_TIMEOUT_MS, "first upload did not start preparation");
      const blockedHistory = await environment.client.workflow.getHandle(`media-upload:${blocked.id}`).fetchHistory();
      assert.equal(blockedHistory.events.some((event) => event.timerStartedEventAttributes), false);
      blockedResultPromise = blockedCaller.result().then((result) => {
        blockedCompleted = true;
        assert.equal(result.upload?.id, blocked.id);
        assert.equal(result.error, undefined);
      });

      const concurrentCaller = await startCaller(
        environment,
        endpointName,
        uploadInput(concurrent.id, concurrent.sourceKey),
        `concurrent-caller:${randomUUID()}`,
      );
      await awaitUploadWorkflowWaiting(environment, staging, concurrent.id, concurrent.sourceKey);
      await concurrentCaller.signal("finishNexusUploadTest");
      const concurrentResult = await withTimeout(
        concurrentCaller.result(),
        WORKFLOW_TIMEOUT_MS,
        "second upload did not complete while first processing was blocked",
      );
      const concurrentOutputKey = `original/${concurrent.id}.webp`;
      assert.equal(concurrentResult.upload?.id, concurrent.id);
      assert.equal(concurrentResult.error, undefined);
      assert.equal(blockedCompleted, false);
      assert.equal(staging.objects.has(blocked.sourceKey), true);
      assert.equal(staging.deleteKeys.includes(blocked.sourceKey), false);
      const blockedWaitingHistory = await environment.client.workflow.getHandle(`media-upload:${blocked.id}`).fetchHistory();
      assert.equal(blockedWaitingHistory.events.some((event) => event.timerStartedEventAttributes), false);
      assert.equal(staging.contentReads.get(concurrent.sourceKey), 1);
      assert.equal(staging.objects.has(concurrent.sourceKey), false);
      assert.equal(staging.deleteKeys.includes(concurrent.sourceKey), true);
      assert.deepEqual(
        staging.deleteKeys.filter((key) => key === preparedKey(concurrent.sourceKey) || key === concurrent.sourceKey),
        [preparedKey(concurrent.sourceKey), concurrent.sourceKey],
      );
      assert.equal(media.putCounts.get(concurrentOutputKey), 1);
    } finally {
      releaseBlockedGet();
      staging.getGate = undefined;
    }
    await awaitUploadWorkflowWaiting(environment, staging, blocked.id, blocked.sourceKey);
    await blockedCaller.signal("finishNexusUploadTest");
    await withTimeout(
      blockedResultPromise,
      WORKFLOW_TIMEOUT_MS,
      "first upload did not complete after processing was released",
    );
    assert.equal(staging.objects.has(blocked.sourceKey), false);
    assert.equal(staging.deleteKeys.includes(blocked.sourceKey), true);

    const successful = newUpload();
    const successfulInput = uploadInput(successful.id, successful.sourceKey);
    staging.seed(successful.sourceKey, PNG_1X1);
    const successfulCaller = await startCaller(
      environment,
      endpointName,
      successfulInput,
      `success-caller:${randomUUID()}`,
    );
    await awaitUploadWorkflowWaiting(environment, staging, successful.id, successful.sourceKey);
    const outputKey = `original/${successful.id}.webp`;
    assert.equal(staging.contentReads.get(successful.sourceKey), 1);
    const preparedOutputKey = preparedKey(successful.sourceKey);
    const preparedBytes = Buffer.from(staging.objects.get(preparedOutputKey).bytes);
    assert.equal(media.putCounts.get(outputKey) ?? 0, 0);
    assert.equal(media.objects.has(outputKey), false);

    const history = await environment.client.workflow.getHandle(`media-upload:${successful.id}`).fetchHistory();
    assert.deepEqual(startedInput(history), successfulInput);
    assert.equal(JSON.stringify(history.events).includes(PNG_1X1.toString("base64")), false);
    const callerHistory = await environment.client.workflow.getHandle(successfulCaller.workflowId).fetchHistory();
    assert.equal(JSON.stringify(callerHistory.events).includes(PNG_1X1.toString("base64")), false);
    staging.objects.delete(successful.sourceKey);

    const duplicate = { id: successful.id, sourceKey: `uploads/${successful.id}/${randomUUID()}` };
    staging.seed(duplicate.sourceKey, PNG_1X1);
    const duplicateCaller = await startCaller(
      environment,
      endpointName,
      uploadInput(duplicate.id, duplicate.sourceKey),
      `duplicate-caller:${randomUUID()}`,
      "3 seconds",
    );
    const duplicateResult = await withTimeout(duplicateCaller.result(), 5_000, "duplicate start did not fail");
    assert.match(duplicateResult.error, /upload ID has already been used/i);
    assert.equal(staging.objects.has(duplicate.sourceKey), true);
    assert.equal(staging.deleteKeys.includes(duplicate.sourceKey), false);
    assert.equal(staging.contentReads.get(successful.sourceKey), 1);

    await stopWorker(worker);
    worker = await startWorker(environment, workflowBundle, staging, media, workerFailures);
    media.failAfterCommitKey = outputKey;
    await successfulCaller.signal("finishNexusUploadTest");
    const successfulResult = await withTimeout(
      successfulCaller.result(),
      WORKFLOW_TIMEOUT_MS,
      "published upload did not complete",
    );
    assert.deepEqual(successfulResult, {
      upload: {
        id: successful.id,
        url: `${PUBLIC_BASE_URL}/${outputKey}`,
        mediaType: "image/webp",
      },
      publishResults: [{ id: successful.id }, { id: successful.id }],
    });
    assert.equal(media.putCounts.get(outputKey), 1);
    assert.equal(staging.contentReads.get(successful.sourceKey), 1);
    assert.equal(staging.objects.has(successful.sourceKey), false);
    assert.equal(staging.deleteKeys.includes(successful.sourceKey), true);
    const stored = media.objects.get(outputKey);
    assert(stored);
    assert.deepEqual(stored.bytes, preparedBytes);
    assert.deepEqual(
      staging.deleteKeys.filter((key) => key === preparedOutputKey || key === successful.sourceKey),
      [preparedOutputKey, successful.sourceKey],
    );
    assert.equal(stored.bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(stored.bytes.toString("ascii", 8, 12), "WEBP");

    const cleanupFailure = newUpload();
    staging.seed(cleanupFailure.sourceKey, PNG_1X1);
    const cleanupFailureCaller = await startCaller(
      environment,
      endpointName,
      uploadInput(cleanupFailure.id, cleanupFailure.sourceKey),
      `cleanup-failure-caller:${randomUUID()}`,
    );
    await awaitUploadWorkflowWaiting(environment, staging, cleanupFailure.id, cleanupFailure.sourceKey);
    const cleanupFailureOutputKey = `original/${cleanupFailure.id}.webp`;
    staging.transientDeleteKey = preparedKey(cleanupFailure.sourceKey);
    await cleanupFailureCaller.signal("finishNexusUploadTest");
    const cleanupFailureResult = await withTimeout(
      cleanupFailureCaller.result(),
      WORKFLOW_TIMEOUT_MS,
      "published upload with a cleanup failure did not complete",
    );
    assert.equal(media.objects.has(cleanupFailureOutputKey), true);
    assert.equal(media.putCounts.get(cleanupFailureOutputKey), 1);
    assert.equal(staging.objects.has(cleanupFailure.sourceKey), false);
    assert.equal(staging.objects.has(preparedKey(cleanupFailure.sourceKey)), false);
    assert.deepEqual(
      staging.deleteKeys.filter((key) => key === preparedKey(cleanupFailure.sourceKey) || key === cleanupFailure.sourceKey),
      [preparedKey(cleanupFailure.sourceKey), preparedKey(cleanupFailure.sourceKey), cleanupFailure.sourceKey],
    );
    assert.deepEqual(cleanupFailureResult, {
      upload: {
        id: cleanupFailure.id,
        url: `${PUBLIC_BASE_URL}/${cleanupFailureOutputKey}`,
        mediaType: "image/webp",
      },
      publishResults: [{ id: cleanupFailure.id }, { id: cleanupFailure.id }],
    });

    const terminalCleanupFailure = newUpload();
    staging.seed(terminalCleanupFailure.sourceKey, PNG_1X1);
    const terminalCleanupCaller = await startCaller(
      environment,
      endpointName,
      uploadInput(terminalCleanupFailure.id, terminalCleanupFailure.sourceKey),
      `terminal-cleanup-failure-caller:${randomUUID()}`,
    );
    await awaitUploadWorkflowWaiting(
      environment,
      staging,
      terminalCleanupFailure.id,
      terminalCleanupFailure.sourceKey,
    );
    const terminalPreparedKey = preparedKey(terminalCleanupFailure.sourceKey);
    const terminalPreparedBytes = Buffer.from(staging.objects.get(terminalPreparedKey).bytes);
    const terminalOutputKey = `original/${terminalCleanupFailure.id}.webp`;
    staging.failDeleteKey = terminalPreparedKey;
    await terminalCleanupCaller.signal("finishNexusUploadTest");
    const terminalCleanupResult = await withTimeout(
      terminalCleanupCaller.result(),
      WORKFLOW_TIMEOUT_MS,
      "published upload did not complete after terminal cleanup failure",
    );
    assert.deepEqual(terminalCleanupResult, {
      upload: {
        id: terminalCleanupFailure.id,
        url: `${PUBLIC_BASE_URL}/${terminalOutputKey}`,
        mediaType: "image/webp",
      },
      publishResults: [{ id: terminalCleanupFailure.id }, { id: terminalCleanupFailure.id }],
    });
    assert.deepEqual(media.objects.get(terminalOutputKey).bytes, terminalPreparedBytes);
    assert.equal(staging.objects.has(terminalPreparedKey), true);
    assert.equal(staging.objects.has(terminalCleanupFailure.sourceKey), true);
    assert.deepEqual(
      staging.deleteKeys.filter(
        (key) => key === terminalPreparedKey || key === terminalCleanupFailure.sourceKey,
      ),
      [terminalPreparedKey],
    );

    const completedPublish = await environment.client.workflow.start("nexusPublishCallerWorkflow", {
      workflowId: `publish-completed:${randomUUID()}`,
      taskQueue: TASK_QUEUE,
      args: [endpointName, successful.id],
    });
    const completedPublishResult = await withTimeout(
      completedPublish.result(),
      5_000,
      "publish of a completed upload did not fail promptly",
    );
    assert.match(completedPublishResult.error, /upload workflow was not found/i);

    const badImage = newUpload();
    const badImageInput = uploadInput(badImage.id, badImage.sourceKey);
    staging.seed(badImage.sourceKey, Uint8Array.from([1, 2, 3, 4]));
    const badImageCaller = await startCaller(
      environment,
      endpointName,
      badImageInput,
      `bad-image-caller:${randomUUID()}`,
    );
    staging.failDeleteKey = preparedKey(badImage.sourceKey);
    const badImageResult = await withTimeout(
      badImageCaller.result(),
      WORKFLOW_TIMEOUT_MS,
      "invalid image did not fail after publication",
    );
    assert.match(badImageResult.error, /invalid_image|upload validation failed/i);
    assert.doesNotMatch(badImageResult.error, /InjectedCleanupFailure|cleanup failure/i);
    assert.equal(media.putCounts.get(`original/${badImage.id}.webp`) ?? 0, 0);
    assert.equal(staging.objects.has(badImage.sourceKey), true);
    assert.equal(staging.objects.has(preparedKey(badImage.sourceKey)), false);
    assert.equal(staging.contentReads.get(badImage.sourceKey), 1);
    assert.deepEqual(staging.deleteKeys.slice(-1), [preparedKey(badImage.sourceKey)]);
    const badImageHistory = await environment.client.workflow.getHandle(`media-upload:${badImage.id}`).fetchHistory();
    assert.equal(badImageHistory.events.some((event) => event.timerStartedEventAttributes), false);

    for (const [label, lastModified] of [
      ["missing", null],
      ["invalid", new Date(Number.NaN)],
      ["expired", new Date(Date.now() - 24 * 60 * 60 * 1000 - 1_000)],
    ]) {
      const source = newUpload();
      staging.seed(source.sourceKey, PNG_1X1, lastModified);
      const caller = await startCaller(
        environment,
        endpointName,
        uploadInput(source.id, source.sourceKey),
        `${label}-metadata-caller:${randomUUID()}`,
      );
      await waitFor(
        () => !staging.objects.has(source.sourceKey) && staging.deleteKeys.includes(source.sourceKey),
        `${label} source metadata did not terminate and clean up`,
      );
      const result = await withTimeout(caller.result(), 5_000, `${label} metadata result did not fail`);
      assert(result.error);
      assert.equal(staging.contentReads.get(source.sourceKey) ?? 0, 0);
      assert.equal(media.putCounts.get(`original/${source.id}.webp`) ?? 0, 0);
      assert.deepEqual(
        staging.deleteKeys.filter((key) => key === preparedKey(source.sourceKey) || key === source.sourceKey),
        [preparedKey(source.sourceKey), source.sourceKey],
      );
    }

    const expiring = newUpload();
    const remainingLifetimeMs = 2_000;
    staging.seed(
      expiring.sourceKey,
      PNG_1X1,
      new Date(Date.now() - 24 * 60 * 60 * 1000 + remainingLifetimeMs),
    );
    let releaseExpiringGet;
    let announceExpiringGet;
    const expiringGetStarted = new Promise((resolve) => { announceExpiringGet = resolve; });
    const expiringGet = new Promise((resolve) => { releaseExpiringGet = resolve; });
    staging.getGate = {
      key: expiring.sourceKey,
      started: announceExpiringGet,
      promise: expiringGet,
    };
    const expiringCaller = await startCaller(
      environment,
      endpointName,
      uploadInput(expiring.id, expiring.sourceKey),
      `expiring-caller:${randomUUID()}`,
    );
    try {
      await withTimeout(expiringGetStarted, WORKFLOW_TIMEOUT_MS, "expiring upload did not start preparation");
      await delay(remainingLifetimeMs + 100);
    } finally {
      releaseExpiringGet();
      staging.getGate = undefined;
    }
    await waitFor(
      () => !staging.objects.has(expiring.sourceKey) && staging.deleteKeys.includes(expiring.sourceKey),
      "short remaining-life upload did not expire and clean up",
    );
    assert.equal(staging.contentReads.get(expiring.sourceKey), 1);
    assert.equal(staging.objects.has(preparedKey(expiring.sourceKey)), false);
    assert.deepEqual(
      staging.deleteKeys.filter((key) => key === preparedKey(expiring.sourceKey) || key === expiring.sourceKey),
      [preparedKey(expiring.sourceKey), expiring.sourceKey],
    );
    assert.equal(media.putCounts.get(`original/${expiring.id}.webp`) ?? 0, 0);
    const expiringHistory = await environment.client.workflow.getHandle(`media-upload:${expiring.id}`).fetchHistory();
    assert.equal(expiringHistory.events.some((event) => event.timerStartedEventAttributes), false);
    const expiringResult = await withTimeout(
      expiringCaller.result(),
      5_000,
      "expired Nexus upload result did not finish",
    );
    assert.match(expiringResult.error, /upload expired before publication/i);

    const cancelled = newUpload();
    staging.seed(cancelled.sourceKey, PNG_1X1);
    const cancelledCaller = await startCaller(
      environment,
      endpointName,
      uploadInput(cancelled.id, cancelled.sourceKey),
      `cancelled-caller:${randomUUID()}`,
    );
    await awaitUploadWorkflowWaiting(environment, staging, cancelled.id, cancelled.sourceKey);
    await cancelledCaller.cancel();
    await assert.rejects(
      withTimeout(
        cancelledCaller.result(),
        WORKFLOW_TIMEOUT_MS,
        "cancelled Nexus caller did not finish promptly",
      ),
      (error) => {
        assert.match(errorCauseChain(error), /CancelledFailure/);
        return true;
      },
    );
    const cancelledCallerHistory = await cancelledCaller.fetchHistory();
    assert(cancelledCallerHistory.events.some((event) => event.workflowExecutionCanceledEventAttributes));
    await waitFor(async () => {
      const history = await environment.client.workflow.getHandle(`media-upload:${cancelled.id}`).fetchHistory();
      return history.events.some((event) => event.workflowExecutionCanceledEventAttributes) &&
        !staging.objects.has(cancelled.sourceKey) &&
        staging.deleteKeys.includes(cancelled.sourceKey);
    }, "Nexus caller cancellation did not propagate and clean up the upload");
    assert.equal(staging.objects.has(cancelled.sourceKey), false);
    assert.equal(staging.objects.has(preparedKey(cancelled.sourceKey)), false);
    assert.equal(staging.contentReads.get(cancelled.sourceKey), 1);
    assert.deepEqual(
      staging.deleteKeys.filter((key) => key === preparedKey(cancelled.sourceKey) || key === cancelled.sourceKey),
      [preparedKey(cancelled.sourceKey), cancelled.sourceKey],
    );
    assert.equal(media.putCounts.get(`original/${cancelled.id}.webp`) ?? 0, 0);
    assert.deepEqual(workerFailures, []);
  } finally {
    if (worker) await stopWorker(worker).catch(() => undefined);
    await environment.deleteNexusEndpoint(endpoint).catch(() => undefined);
    await environment.teardown();
  }
});

test("Nexus applyHope waits for queued processing and publishes its private variant", async () => {
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: resolve("scripts/temporal-test-workflow.ts"),
  });
  const executable = process.env.TEMPORAL_CLI_PATH
    ? { type: "existing-path", path: process.env.TEMPORAL_CLI_PATH }
    : { type: "cached-download" };
  const environment = await TestWorkflowEnvironment.createLocal({ server: { executable } });
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const workerFailures = [];
  const endpointName = "media-hope-test-" + randomUUID();
  const endpoint = await environment.createNexusEndpoint(endpointName, TASK_QUEUE);
  const prepareStarted = deferred();
  const prepareGate = deferred();
  const protectedWebp = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 240, g: 25, b: 135 } },
  }).webp().toBuffer();
  let worker;
  let hopeWorker;

  try {
    worker = await startWorker(
      environment,
      workflowBundle,
      staging,
      media,
      workerFailures,
      undefined,
      [createMediaServiceHandler({ hopeEnabled: true })],
    );

    const source = newUpload();
    const input = uploadInput(source.id, source.sourceKey);
    const defaultKey = preparedKey(source.sourceKey);
    const publicKey = "original/" + source.id + ".webp";
    staging.seed(source.sourceKey, PNG_1X1);
    const uploadCaller = await startCaller(
      environment,
      endpointName,
      input,
      "hope-upload:" + randomUUID(),
    );
    const uploadOutcomePromise = uploadCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => staging.objects.has(defaultKey), "default private image was not prepared");
    const defaultBytes = Buffer.from(staging.objects.get(defaultKey).bytes);

    const applyHopeCaller = await startApplyHopeCaller(
      environment,
      endpointName,
      { id: source.id, hope: { algorithm: "noise", iterations: 37, intensity: 0.65 } },
      "hope-update:" + randomUUID(),
      "60 seconds",
    );
    const hopeOutcomePromise = applyHopeCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const uploadHandle = environment.client.workflow.getHandle("media-upload:" + source.id);
    const scheduledEvent = await waitFor(async () => {
      const history = await uploadHandle.fetchHistory();
      return history.events.find(
        (event) => event.activityTaskScheduledEventAttributes?.activityType?.name === "prepareHopeUpload",
      );
    }, "applyHope did not schedule prepareHopeUpload");
    const scheduled = scheduledEvent.activityTaskScheduledEventAttributes;
    const scheduledInput = defaultPayloadConverter.fromPayload(scheduled.input.payloads[0]);
    assert.equal(scheduled.taskQueue.name, HOPE_TASK_QUEUE);
    assert.equal(scheduledInput.maxEdge, 1024);
    assert.deepEqual(scheduledInput, {
      ...input,
      requestId: scheduledInput.requestId,
      maxEdge: 1024,
      hope: { algorithm: "noise", iterations: 37, intensity: 0.65 },
    });
    assert.match(scheduledInput.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const hopeKey = hopePreparedUploadKey(source.sourceKey, scheduledInput.requestId);

    await delay(100);
    assert.equal((await Promise.race([
      hopeOutcomePromise.then(() => true),
      delay(0).then(() => false),
    ])), false, "applyHope completed without an external worker");
    assert.equal(staging.objects.has(hopeKey), false);
    assert.equal(media.putCounts.get(publicKey) ?? 0, 0);
    assert.equal((await Promise.race([
      uploadOutcomePromise.then(() => true),
      delay(0).then(() => false),
    ])), false, "upload published without an external worker");

    hopeWorker = await startHopeWorker(
      environment,
      async (activityInput, cancellationSignal) => {
        assert.deepEqual(activityInput, scheduledInput);
        prepareStarted.resolve(activityInput);
        await prepareGate.promise;
        cancellationSignal.throwIfAborted();
        await staging.putStream(
          hopePreparedUploadKey(activityInput.sourceKey, activityInput.requestId),
          Readable.from([protectedWebp]),
          protectedWebp.byteLength,
          {
            onlyIf: new Headers({ "If-None-Match": "*" }),
            httpMetadata: { contentType: "image/webp" },
          },
        );
        const preparedKey = hopePreparedUploadKey(activityInput.sourceKey, activityInput.requestId);
        assert.deepEqual(Buffer.from(staging.objects.get(preparedKey).bytes), protectedWebp);
      },
      workerFailures,
    );
    await withTimeout(prepareStarted.promise, WORKFLOW_TIMEOUT_MS, "external activity did not start");

    const busyCaller = await startApplyHopeCaller(
      environment,
      endpointName,
      { id: source.id, hope: { algorithm: "glaze", iterations: 8 } },
      "hope-busy:" + randomUUID(),
      "5 seconds",
    );
    const busyResult = await withTimeout(busyCaller.result(), 5_000, "busy applyHope did not reject");
    assert.match(busyResult.error, /already in progress/i);

    const publishCaller = await startPublishCaller(
      environment,
      endpointName,
      source.id,
      "hope-publish:" + randomUUID(),
    );
    assert.deepEqual(await withTimeout(publishCaller.result(), 5_000, "publish signal did not complete"), {
      result: { id: source.id },
    });
    await waitFor(async () => {
      const history = await uploadHandle.fetchHistory();
      return history.events.some(
        (event) => event.workflowExecutionSignaledEventAttributes?.signalName === "publishUpload",
      );
    }, "publish signal was not recorded");
    assert.equal((await Promise.race([
      uploadOutcomePromise.then(() => true),
      delay(0).then(() => false),
    ])), false, "upload published before external processing finished");
    assert.equal(media.putCounts.get(publicKey) ?? 0, 0);
    assert.equal(staging.objects.has(source.sourceKey), true);

    prepareGate.resolve();
    const hopeOutcome = await withTimeout(hopeOutcomePromise, WORKFLOW_TIMEOUT_MS, "applyHope did not finish");
    assert.equal(hopeOutcome.error, undefined);
    assert.deepEqual(hopeOutcome.value, {
      result: {
        id: source.id,
        hope: { algorithm: "noise", iterations: 37, intensity: 0.65 },
      },
    });
    const uploadOutcome = await withTimeout(uploadOutcomePromise, WORKFLOW_TIMEOUT_MS, "upload did not publish");
    assert.equal(uploadOutcome.error, undefined);
    assert.equal(uploadOutcome.value.upload.id, source.id);
    assert.deepEqual(media.objects.get(publicKey).bytes, protectedWebp);
    assert.notDeepEqual(media.objects.get(publicKey).bytes, defaultBytes);
    assert.equal(staging.objects.has(source.sourceKey), false);
    assert.equal(staging.objects.has(defaultKey), false);
    assert.equal(staging.objects.has(hopeKey), false);
    assert.deepEqual(
      staging.deleteKeys.filter((key) => key === hopeKey || key === defaultKey || key === source.sourceKey),
      [hopeKey, defaultKey, source.sourceKey],
    );

    assert.deepEqual(workerFailures, []);
  } finally {
    prepareGate.resolve();
    if (worker) await stopWorker(worker).catch(() => undefined);
    if (hopeWorker) await stopWorker(hopeWorker).catch(() => undefined);
    await environment.deleteNexusEndpoint(endpoint).catch(() => undefined);
    await environment.teardown();
  }
});

test("Nexus applyHope retries transient worker failures, blocks stale publication, then clears to default", async () => {
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: resolve("scripts/temporal-test-workflow.ts"),
  });
  const executable = process.env.TEMPORAL_CLI_PATH
    ? { type: "existing-path", path: process.env.TEMPORAL_CLI_PATH }
    : { type: "cached-download" };
  const environment = await TestWorkflowEnvironment.createLocal({ server: { executable } });
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const workerFailures = [];
  const activityInputs = [];
  const endpointName = "media-hope-failure-test-" + randomUUID();
  const endpoint = await environment.createNexusEndpoint(endpointName, TASK_QUEUE);
  const terminalFailureStarted = deferred();
  const terminalFailureGate = deferred();
  const protectedWebp = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 240, g: 25, b: 135 } },
  }).webp({ quality: 50 }).toBuffer();
  let lastGoodKey;
  let terminalFailureInput;
  let worker;
  let hopeWorker;

  try {
    worker = await startWorker(
      environment,
      workflowBundle,
      staging,
      media,
      workerFailures,
      undefined,
      [createMediaServiceHandler({ hopeEnabled: true })],
    );
    hopeWorker = await startHopeWorker(
      environment,
      async (activityInput, cancellationSignal) => {
        activityInputs.push(activityInput);
        if (activityInput.hope.algorithm === "glaze") {
          const glazeAttempts = activityInputs.filter((item) => item.hope.algorithm === "glaze").length;
          if (glazeAttempts === 1) {
            throw ApplicationFailure.create({
              message: "injected transient Hope processing failure",
              type: HOPE_PROCESSING_ERROR_TYPE,
            });
          }
          lastGoodKey = hopePreparedUploadKey(activityInput.sourceKey, activityInput.requestId);
          await staging.putStream(
            lastGoodKey,
            Readable.from([protectedWebp]),
            protectedWebp.byteLength,
            {
              onlyIf: new Headers({ "If-None-Match": "*" }),
              httpMetadata: { contentType: "image/webp" },
            },
          );
          return;
        }

        terminalFailureInput = activityInput;
        terminalFailureStarted.resolve(activityInput);
        await terminalFailureGate.promise;
        cancellationSignal.throwIfAborted();
        throw ApplicationFailure.create({
          message: "injected terminal Hope processing failure",
          type: HOPE_PROCESSING_ERROR_TYPE,
          nonRetryable: true,
        });
      },
      workerFailures,
    );

    const source = newUpload();
    const input = uploadInput(source.id, source.sourceKey);
    const defaultKey = preparedKey(source.sourceKey);
    const publicKey = "original/" + source.id + ".webp";
    staging.seed(source.sourceKey, PNG_1X1);
    const uploadCaller = await startCaller(
      environment,
      endpointName,
      input,
      "hope-failure-upload:" + randomUUID(),
    );
    const uploadOutcomePromise = uploadCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => staging.objects.has(defaultKey), "default private image was not prepared");
    const defaultBytes = Buffer.from(staging.objects.get(defaultKey).bytes);

    const successfulHopeCaller = await startApplyHopeCaller(
      environment,
      endpointName,
      { id: source.id, hope: { algorithm: "glaze", iterations: 29 } },
      "hope-retry:" + randomUUID(),
      "15 seconds",
    );
    assert.deepEqual(await withTimeout(
      successfulHopeCaller.result(),
      15_000,
      "transient Hope activity failure did not retry",
    ), {
      result: { id: source.id, hope: { algorithm: "glaze", iterations: 29, intensity: 0.3 } },
    });
    assert.equal(activityInputs.length, 2);
    assert.deepEqual(activityInputs[0], activityInputs[1]);
    assert.equal(activityInputs[0].maxEdge, 1024);
    assert.equal(activityInputs[0].id, source.id);
    assert.equal(activityInputs[0].sourceKey, source.sourceKey);
    assert.deepEqual(activityInputs[0].hope, { algorithm: "glaze", iterations: 29, intensity: 0.3 });
    assert(lastGoodKey);
    assert.equal(staging.objects.has(lastGoodKey), true);
    assert.deepEqual(Buffer.from(staging.objects.get(lastGoodKey).bytes), protectedWebp);
    assert.equal(staging.objects.has(source.sourceKey), true);

    const failedHopeCaller = await startApplyHopeCaller(
      environment,
      endpointName,
      { id: source.id, hope: { algorithm: "noise", iterations: 17 } },
      "hope-terminal-failure:" + randomUUID(),
      "10 seconds",
    );
    const failedHopeOutcomePromise = failedHopeCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await withTimeout(
      terminalFailureStarted.promise,
      WORKFLOW_TIMEOUT_MS,
      "terminal Hope activity did not start",
    );

    const pendingPublishCaller = await startPublishCaller(
      environment,
      endpointName,
      source.id,
      "hope-pending-publish:" + randomUUID(),
    );
    assert.deepEqual(await withTimeout(
      pendingPublishCaller.result(),
      5_000,
      "publish signal did not complete while Hope was pending",
    ), { result: { id: source.id } });
    const uploadHandle = environment.client.workflow.getHandle("media-upload:" + source.id);
    await waitFor(async () => {
      const history = await uploadHandle.fetchHistory();
      return history.events.some(
        (event) => event.workflowExecutionSignaledEventAttributes?.signalName === "publishUpload",
      );
    }, "publish signal was not recorded");
    terminalFailureGate.resolve();

    const failedHopeOutcome = await withTimeout(
      failedHopeOutcomePromise,
      WORKFLOW_TIMEOUT_MS,
      "terminal Hope activity failure did not finish",
    );
    assert.match(failedHopeOutcome.value.error, /HopeProcessingError/);
    const failedKey = hopePreparedUploadKey(source.sourceKey, terminalFailureInput.requestId);
    assert.equal(staging.objects.has(failedKey), false);
    assert.equal(staging.objects.has(lastGoodKey), true);
    assert.equal(staging.objects.has(source.sourceKey), true);
    assert.equal(media.objects.has(publicKey), false);
    assert.equal(media.putCounts.get(publicKey) ?? 0, 0);
    assert.equal((await Promise.race([
      uploadOutcomePromise.then(() => true),
      delay(100).then(() => false),
    ])), false, "failed Hope processing published the previous variant");

    const clearCaller = await startApplyHopeCaller(
      environment,
      endpointName,
      { id: source.id, hope: null },
      "hope-clear:" + randomUUID(),
      "5 seconds",
    );
    assert.deepEqual(await withTimeout(clearCaller.result(), 5_000, "clear Hope update did not finish"), {
      result: { id: source.id, hope: null },
    });
    assert.equal(activityInputs.length, 3);
    assert.equal(media.objects.has(publicKey), false);

    const finalPublishCaller = await startPublishCaller(
      environment,
      endpointName,
      source.id,
      "hope-clear-publish:" + randomUUID(),
    );
    assert.deepEqual(await withTimeout(
      finalPublishCaller.result(),
      5_000,
      "publication did not resume after clear",
    ), { result: { id: source.id } });
    const uploadOutcome = await withTimeout(uploadOutcomePromise, WORKFLOW_TIMEOUT_MS, "cleared upload did not publish");
    assert.equal(uploadOutcome.error, undefined);
    assert.equal(uploadOutcome.value.upload.id, source.id);
    assert.deepEqual(media.objects.get(publicKey).bytes, defaultBytes);
    assert.notDeepEqual(media.objects.get(publicKey).bytes, protectedWebp);
    assert.equal(staging.objects.has(lastGoodKey), false);
    assert.equal(staging.objects.has(failedKey), false);
    assert.equal(staging.objects.has(defaultKey), false);
    assert.equal(staging.objects.has(source.sourceKey), false);

    const scopedDeletes = staging.deleteKeys.filter((key) =>
      key === source.sourceKey || key === defaultKey || key.startsWith(source.sourceKey + ".hope/"),
    );
    const defaultDeleteIndex = scopedDeletes.indexOf(defaultKey);
    const sourceDeleteIndex = scopedDeletes.lastIndexOf(source.sourceKey);
    const hopeDeleteKeys = scopedDeletes.filter((key) => key.startsWith(source.sourceKey + ".hope/"));
    assert(defaultDeleteIndex >= 0 && sourceDeleteIndex > defaultDeleteIndex);
    assert(hopeDeleteKeys.every((key) => scopedDeletes.indexOf(key) < defaultDeleteIndex));
    assert.deepEqual(hopeDeleteKeys, [lastGoodKey, failedKey]);

    const histories = await Promise.all([
      successfulHopeCaller.fetchHistory(),
      failedHopeCaller.fetchHistory(),
      clearCaller.fetchHistory(),
    ]);
    assert.equal(JSON.stringify({ upload: await uploadHandle.fetchHistory(), histories })
      .includes("HopeProcessingError"), true);
    assert.deepEqual(workerFailures, []);
  } finally {
    terminalFailureGate.resolve();
    if (worker) await stopWorker(worker).catch(() => undefined);
    if (hopeWorker) await stopWorker(hopeWorker).catch(() => undefined);
    await environment.deleteNexusEndpoint(endpoint).catch(() => undefined);
    await environment.teardown();
  }
});

test("Hope expiry cancels queued processing and caller cancellation drains an in-flight private write", async () => {
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: resolve("scripts/temporal-test-workflow.ts"),
  });
  const executable = process.env.TEMPORAL_CLI_PATH
    ? { type: "existing-path", path: process.env.TEMPORAL_CLI_PATH }
    : { type: "cached-download" };
  const environment = await TestWorkflowEnvironment.createLocal({ server: { executable } });
  const staging = new MemoryStagingStorage();
  const media = new MemoryMediaStorage();
  const workerFailures = [];
  const endpointName = "media-hope-cancel-test-" + randomUUID();
  const endpoint = await environment.createNexusEndpoint(endpointName, TASK_QUEUE);
  const expiring = newUpload();
  const cancelled = newUpload();
  const expiryGate = deferred();
  const expiringActivityStarted = deferred();
  const cancelledPrivateWrite = deferred();
  const privateWriteStarted = deferred();
  const workerCancellationReceived = deferred();
  const protectedWebp = await sharp(PNG_1X1).webp().toBuffer();
  let privateWriteKey;
  let expiringHopeKey;
  let worker;
  let hopeWorker;

  try {
    worker = await startWorker(
      environment,
      workflowBundle,
      staging,
      media,
      workerFailures,
      undefined,
      [createMediaServiceHandler({ hopeEnabled: true })],
    );
    hopeWorker = await startHopeWorker(
      environment,
      async (activityInput, cancellationSignal) => {
        if (activityInput.id === expiring.id) {
          expiringHopeKey = hopePreparedUploadKey(activityInput.sourceKey, activityInput.requestId);
          expiringActivityStarted.resolve(activityInput);
          await Promise.race([
            expiryGate.promise,
            new Promise((resolve) => {
              if (cancellationSignal.aborted) resolve();
              else cancellationSignal.addEventListener("abort", resolve, { once: true });
            }),
          ]);
          cancellationSignal.throwIfAborted();
          return;
        }

        assert.equal(activityInput.id, cancelled.id);
        const hopeKey = hopePreparedUploadKey(activityInput.sourceKey, activityInput.requestId);
        cancellationSignal.addEventListener("abort", () => workerCancellationReceived.resolve(), { once: true });
        await staging.putStream(
          hopeKey,
          Readable.from([protectedWebp]),
          protectedWebp.byteLength,
          {
            onlyIf: new Headers({ "If-None-Match": "*" }),
            httpMetadata: { contentType: "image/webp" },
          },
        );
        privateWriteKey = hopeKey;
        cancellationSignal.throwIfAborted();
      },
      workerFailures,
    );

    const expiringDefaultKey = preparedKey(expiring.sourceKey);
    const expiringPublicKey = "original/" + expiring.id + ".webp";
    const remainingLifetimeMs = 12_500;
    staging.seed(
      expiring.sourceKey,
      PNG_1X1,
      new Date(Date.now() - 24 * 60 * 60 * 1000 + remainingLifetimeMs),
    );
    const expiringCaller = await startCaller(
      environment,
      endpointName,
      uploadInput(expiring.id, expiring.sourceKey),
      "hope-expiring-upload:" + randomUUID(),
    );
    const expiringOutcomePromise = expiringCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => staging.objects.has(expiringDefaultKey), "expiring image was not prepared");
    const expiringHopeCaller = await startApplyHopeCaller(
      environment,
      endpointName,
      { id: expiring.id, hope: { algorithm: "noise", iterations: 8 } },
      "hope-expiring-update:" + randomUUID(),
      "30 seconds",
    );
    const expiringHopeOutcomePromise = expiringHopeCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const expiringActivityInput = await withTimeout(
      expiringActivityStarted.promise,
      WORKFLOW_TIMEOUT_MS,
      "expiring Hope activity did not start",
    );
    assert.equal(expiringActivityInput.maxEdge, 1024);
    const expiringOutcome = await withTimeout(
      expiringOutcomePromise,
      remainingLifetimeMs + 10_000,
      "upload did not expire while external processing was blocked",
    );
    assert.equal(expiringOutcome.error, undefined);
    assert.match(expiringOutcome.value.error, /upload expired before publication/i);
    const expiringHopeOutcome = await withTimeout(
      expiringHopeOutcomePromise,
      WORKFLOW_TIMEOUT_MS,
      "expiring Hope update did not settle",
    );
    assert.equal(expiringHopeOutcome.error, undefined);
    assert.match(expiringHopeOutcome.value.error, /HopeProcessingError/);
    assert.equal(staging.objects.has(expiring.sourceKey), false);
    assert.equal(staging.objects.has(expiringDefaultKey), false);
    assert.equal(staging.putStreamKeys.some((key) => key.startsWith(expiring.sourceKey + ".hope/")), false);
    assert(expiringHopeKey);
    assert.equal(staging.objects.has(expiringHopeKey), false);
    assert.equal(media.putCounts.get(expiringPublicKey) ?? 0, 0);

    const cancelledDefaultKey = preparedKey(cancelled.sourceKey);
    const cancelledPublicKey = "original/" + cancelled.id + ".webp";
    staging.seed(cancelled.sourceKey, PNG_1X1);
    const cancelledCaller = await startCaller(
      environment,
      endpointName,
      uploadInput(cancelled.id, cancelled.sourceKey),
      "hope-cancelled-upload:" + randomUUID(),
    );
    const cancelledOutcomePromise = cancelledCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => staging.objects.has(cancelledDefaultKey), "cancelled image was not prepared");

    staging.putGate = {
      matches: (key) => key.startsWith(cancelled.sourceKey + ".hope/"),
      started: (key) => {
        privateWriteKey = key;
        privateWriteStarted.resolve(key);
      },
      promise: cancelledPrivateWrite.promise,
    };
    const cancelledHopeCaller = await startApplyHopeCaller(
      environment,
      endpointName,
      { id: cancelled.id, hope: { algorithm: "glaze", iterations: 13 } },
      "hope-cancelled-update:" + randomUUID(),
      "10 seconds",
    );
    const cancelledHopeOutcomePromise = cancelledHopeCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await withTimeout(privateWriteStarted.promise, WORKFLOW_TIMEOUT_MS, "Hope private write did not start");
    assert.equal(staging.objects.has(privateWriteKey), false);

    await cancelledCaller.cancel();
    await withTimeout(workerCancellationReceived.promise, 7_000, "external worker did not receive cancellation");
    assert.equal((await Promise.race([
      cancelledOutcomePromise.then(() => true),
      delay(0).then(() => false),
    ])), false, "caller cancellation finished before the private write drained");
    assert.equal(staging.objects.has(privateWriteKey), false);
    assert.equal(media.putCounts.get(cancelledPublicKey) ?? 0, 0);

    cancelledPrivateWrite.resolve();
    const cancelledOutcome = await withTimeout(
      cancelledOutcomePromise,
      WORKFLOW_TIMEOUT_MS,
      "cancelled upload did not finish after the private write drained",
    );
    assert(cancelledOutcome.error);
    assert.match(errorCauseChain(cancelledOutcome.error), /CancelledFailure/);
    const cancelledHopeOutcome = await withTimeout(
      cancelledHopeOutcomePromise,
      WORKFLOW_TIMEOUT_MS,
      "cancelled Hope update did not settle",
    );
    assert.equal(cancelledHopeOutcome.error, undefined);
    assert.match(cancelledHopeOutcome.value.error, /HopeProcessingError/);
    const cancelledHistory = await environment.client.workflow.getHandle("media-upload:" + cancelled.id).fetchHistory();
    assert(cancelledHistory.events.some((event) => event.workflowExecutionCanceledEventAttributes));
    assert.equal(staging.objects.has(privateWriteKey), false);
    assert.equal(staging.objects.has(cancelled.sourceKey), false);
    assert.equal(staging.objects.has(cancelledDefaultKey), false);
    assert.equal(media.putCounts.get(cancelledPublicKey) ?? 0, 0);
    const completedPutStreamCount = staging.putStreamKeys.length;
    await delay(100);
    assert.equal(staging.putStreamKeys.length, completedPutStreamCount);

    for (const [sourceKey, defaultKey] of [
      [expiring.sourceKey, expiringDefaultKey],
      [cancelled.sourceKey, cancelledDefaultKey],
    ]) {
      const scopedDeletes = staging.deleteKeys.filter((key) =>
        key === sourceKey || key === defaultKey || key.startsWith(sourceKey + ".hope/"),
      );
      const defaultDeleteIndex = scopedDeletes.indexOf(defaultKey);
      const sourceDeleteIndex = scopedDeletes.lastIndexOf(sourceKey);
      assert(defaultDeleteIndex >= 0 && sourceDeleteIndex > defaultDeleteIndex);
      assert(scopedDeletes.filter((key) => key.startsWith(sourceKey + ".hope/"))
        .every((key) => scopedDeletes.indexOf(key) < defaultDeleteIndex));
    }

    assert.deepEqual(workerFailures, []);
  } finally {
    expiryGate.resolve();
    cancelledPrivateWrite.resolve();
    staging.putGate = undefined;
    if (worker) await stopWorker(worker).catch(() => undefined);
    if (hopeWorker) await stopWorker(hopeWorker).catch(() => undefined);
    await environment.deleteNexusEndpoint(endpoint).catch(() => undefined);
    await environment.teardown();
  }
});

test("worker group drains an initialized worker when peer creation fails", async () => {
  const creationError = new Error("Hope worker creation failed");
  let drained = false;
  let closed = false;
  const uploadWorker = {
    run() { assert.fail("worker must not poll before the worker group is complete"); },
    async runUntil(promise) {
      drained = true;
      await promise;
    },
    shutdown() { assert.fail("runUntil owns initialized worker shutdown"); },
  };

  await assert.rejects(
    runWorkerGroup(async (workers) => {
      workers.push(uploadWorker);
      throw creationError;
    }, async () => {
      assert.equal(drained, true);
      closed = true;
    }),
    (error) => error === creationError,
  );
  assert.equal(drained, true);
  assert.equal(closed, true);
});

test("worker group stops and settles the sibling before closing a shared connection", async () => {
  const workerFailure = new Error("media queue worker failed");
  const siblingStopped = deferred();
  let siblingSettled = false;
  let connectionClosed = false;
  const failedWorker = {
    run() { return Promise.reject(workerFailure); },
    async runUntil() {},
    shutdown() { assert.fail("failed worker is already stopped"); },
  };
  const hopeWorker = {
    run() {
      return siblingStopped.promise.then(() => {
        siblingSettled = true;
      });
    },
    async runUntil() {},
    shutdown() { siblingStopped.resolve(); },
  };

  await assert.rejects(
    runWorkerGroup(async (workers) => {
      workers.push(failedWorker, hopeWorker);
    }, async () => {
      assert.equal(siblingSettled, true);
      connectionClosed = true;
    }),
    (error) => error === workerFailure,
  );
  assert.equal(siblingSettled, true);
  assert.equal(connectionClosed, true);
});

test("worker group waits for all workers after a shared shutdown signal", async () => {
  const started = deferred();
  let startCount = 0;
  let settledCount = 0;
  let closed = false;
  const createWorker = () => {
    let finish;
    let stopped = false;
    return {
      run() {
        startCount += 1;
        if (startCount === 2) started.resolve();
        return new Promise((resolve) => {
          finish = () => {
            settledCount += 1;
            resolve();
          };
        });
      },
      async runUntil() {},
      shutdown() {
        if (stopped) return;
        stopped = true;
        finish();
      },
    };
  };
  const workers = [createWorker(), createWorker()];
  const running = runWorkerGroup(async (created) => {
    created.push(...workers);
  }, async () => {
    assert.equal(settledCount, 2);
    closed = true;
  });

  await started.promise;
  for (const worker of workers) worker.shutdown();
  await running;
  assert.equal(closed, true);
});

test("Hope worker starts with five-second heartbeat throttling and concurrency one", async () => {
  const originalConnect = NativeConnection.connect;
  const originalCreate = Worker.create;
  const options = [];
  NativeConnection.connect = async () => ({ close: async () => {} });
  Worker.create = async (workerOptions) => {
    options.push(workerOptions);
    return { run: async () => {}, runUntil: async () => {}, shutdown() {} };
  };
  try {
    await startConfiguredWorker({
      TEMPORAL_ADDRESS: "localhost:7233",
      TEMPORAL_NAMESPACE: "media",
      TEMPORAL_TASK_QUEUE: "media-upload",
      PUBLIC_BASE_URL: "https://media.example",
      R2_ENDPOINT: "https://r2.example",
      R2_BUCKET_NAME: "media",
      R2_STAGING_BUCKET_NAME: "media-staging",
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
      HOPE_API_URL: "https://hope.example",
      HOPE_API_TOKEN: "hope-test-token-at-least-32-characters-long",
    });
  } finally {
    NativeConnection.connect = originalConnect;
    Worker.create = originalCreate;
  }
  assert.equal(options.length, 2);
  assert.equal(options[1].taskQueue, HOPE_TASK_QUEUE);
  assert.equal(options[1].maxConcurrentActivityTaskExecutions, 1);
  assert.equal(options[1].maxHeartbeatThrottleInterval, "5 seconds");
  assert.equal(options[1].defaultHeartbeatThrottleInterval, "5 seconds");
});

test("Media Hope Activity validates and stores the returned WebP idempotently", async () => {
  const input = hopeActivityInput();
  const staging = new MemoryStagingStorage();
  staging.seed(input.sourceKey, PNG_RGBA_2X1);
  const protectedBytes = await sharp(Buffer.from(PNG_RGBA_2X1)).webp({ quality: 80 }).toBuffer();
  const metadata = await sharp(protectedBytes).metadata();
  const requests = [];
  const activity = createHopeProcessingActivities(
    staging,
    "https://hope.tailnet.example",
    "hope-test-token-at-least-32-characters-long",
    async (url, options) => {
      requests.push({ url, options });
      return hopeResponse(protectedBytes, metadata.width, metadata.height);
    },
  ).prepareHopeUpload;
  const environment = new MockActivityEnvironment();

  await environment.run(activity, input);
  await environment.run(activity, input);

  const key = hopePreparedUploadKey(input.sourceKey, input.requestId);
  const stored = staging.objects.get(key);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).pathname, "/protect");
  assert.deepEqual(Object.fromEntries(new URL(requests[0].url).searchParams), {
    algorithm: "nightshade",
    iterations: "750",
    intensity: "0.3",
    max_edge: "1024",
    quality: "80",
  });
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.authorization, "Bearer hope-test-token-at-least-32-characters-long");
  assert.equal(requests[0].options.headers["content-type"], "application/octet-stream");
  assert.equal(requests[0].options.body.byteLength, PNG_RGBA_2X1.byteLength);
  assert.deepEqual(stored.httpMetadata, { contentType: "image/webp" });
  assert.deepEqual(stored.bytes, protectedBytes);
});

test("Media Hope Activity preserves source validation, expiry and remote retry classification", async () => {
  const expired = hopeActivityInput();
  const expiredStaging = new MemoryStagingStorage();
  expiredStaging.seed(expired.sourceKey, PNG_RGBA_2X1, new Date(Date.now() - 25 * 60 * 60 * 1000));
  const unexpectedFetch = async () => assert.fail("expired source must not call Hope");
  const expiredEnvironment = new MockActivityEnvironment();
  await assert.rejects(
    expiredEnvironment.run(createHopeProcessingActivities(
      expiredStaging,
      "https://hope.tailnet.example",
      "hope-test-token-at-least-32-characters-long",
      unexpectedFetch,
    ).prepareHopeUpload, expired),
    (error) => error instanceof ApplicationFailure && error.type === "UploadExpiredError" && error.nonRetryable,
  );

  for (const [label, source, maxBytes] of [
    ["oversized", PNG_RGBA_2X1, PNG_RGBA_2X1.byteLength - 1],
    ["corrupt", Buffer.from("not an image"), DEFAULT_MAX_BYTES],
  ]) {
    const input = hopeActivityInput({ maxBytes });
    const staging = new MemoryStagingStorage();
    staging.seed(input.sourceKey, source);
    const environment = new MockActivityEnvironment();
    await assert.rejects(
      environment.run(createHopeProcessingActivities(
        staging,
        "https://hope.tailnet.example",
        "hope-test-token-at-least-32-characters-long",
        unexpectedFetch,
      ).prepareHopeUpload, input),
      (error) => error instanceof ApplicationFailure && error.type === "UploadValidationError" && error.nonRetryable,
      label,
    );
  }

  for (const [status, retryable] of [
    [400, false], [401, false], [403, false], [404, false], [413, false], [415, false], [422, false],
    [408, true], [429, true], [503, true], [500, true], [302, false],
  ]) {
    const input = hopeActivityInput();
    const staging = new MemoryStagingStorage();
    staging.seed(input.sourceKey, PNG_RGBA_2X1);
    const environment = new MockActivityEnvironment();
    await assert.rejects(
      environment.run(createHopeProcessingActivities(
        staging,
        "https://hope.tailnet.example",
        "hope-test-token-at-least-32-characters-long",
        async () => new Response("internal server detail", { status }),
      ).prepareHopeUpload, input),
      (error) => error instanceof ApplicationFailure &&
        error.type === HOPE_PROCESSING_ERROR_TYPE && error.nonRetryable === !retryable &&
        !error.message.includes("internal server detail"),
      `HTTP ${status}`,
    );
    assert.equal(staging.putStreamKeys.length, 0);
  }

  const networkInput = hopeActivityInput();
  const networkStaging = new MemoryStagingStorage();
  networkStaging.seed(networkInput.sourceKey, PNG_RGBA_2X1);
  const networkEnvironment = new MockActivityEnvironment();
  await assert.rejects(
    networkEnvironment.run(createHopeProcessingActivities(
      networkStaging,
      "https://hope.tailnet.example",
      "hope-test-token-at-least-32-characters-long",
      async () => { throw new Error("internal transport detail"); },
    ).prepareHopeUpload, networkInput),
    (error) => error instanceof ApplicationFailure && error.type === HOPE_PROCESSING_ERROR_TYPE &&
      !error.nonRetryable && !error.message.includes("internal transport detail"),
  );
});

test("Media Hope Activity rejects malformed, mismatched and oversized HTTP output", async () => {
  const protectedBytes = await sharp(Buffer.from(PNG_RGBA_2X1)).webp({ quality: 80 }).toBuffer();
  const largeBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(DEFAULT_MAX_BYTES + 1));
    },
    cancel() {
      largeBodyCancelled = true;
    },
  });
  let largeBodyCancelled = false;
  const cases = [
    ["missing model calls", hopeResponse(protectedBytes, 2, 1, { "x-hope-model-calls": "0" })],
    ["mismatched dimensions", hopeResponse(protectedBytes, 1, 1)],
    ["corrupt WebP", hopeResponse(Buffer.from("invalid"), 1, 1)],
    ["oversized streamed body", hopeResponse(largeBody, 2, 1)],
  ];

  for (const [label, response] of cases) {
    const input = hopeActivityInput();
    const staging = new MemoryStagingStorage();
    staging.seed(input.sourceKey, PNG_RGBA_2X1);
    const environment = new MockActivityEnvironment();
    await assert.rejects(
      environment.run(createHopeProcessingActivities(
        staging,
        "https://hope.tailnet.example",
        "hope-test-token-at-least-32-characters-long",
        async () => response,
      ).prepareHopeUpload, input),
      (error) => error instanceof ApplicationFailure && error.type === HOPE_PROCESSING_ERROR_TYPE && error.nonRetryable,
      label,
    );
    assert.equal(staging.putStreamKeys.length, 0);
  }
  assert.equal(largeBodyCancelled, true);
});

test("Media Hope Activity aborts HTTP on cancellation and waits for a pending R2 write", async () => {
  const input = hopeActivityInput();
  const staging = new MemoryStagingStorage();
  staging.seed(input.sourceKey, PNG_RGBA_2X1);
  const requestStarted = deferred();
  let requestAborted = false;
  const requestEnvironment = new MockActivityEnvironment();
  const requestTask = requestEnvironment.run(createHopeProcessingActivities(
    staging,
    "https://hope.tailnet.example",
    "hope-test-token-at-least-32-characters-long",
    async (_url, options) => {
      requestStarted.resolve();
      return new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => {
          requestAborted = true;
          reject(options.signal.reason);
        }, { once: true });
      });
    },
  ).prepareHopeUpload, input);
  await requestStarted.promise;
  requestEnvironment.cancel();
  await assert.rejects(requestTask, (error) => error instanceof CancelledFailure);
  assert.equal(requestAborted, true);
  assert.equal(staging.putStreamKeys.length, 0);

  const writeInput = hopeActivityInput();
  const writeStaging = new MemoryStagingStorage();
  writeStaging.seed(writeInput.sourceKey, PNG_RGBA_2X1);
  const protectedBytes = await sharp(Buffer.from(PNG_RGBA_2X1)).webp({ quality: 80 }).toBuffer();
  const writeKey = hopePreparedUploadKey(writeInput.sourceKey, writeInput.requestId);
  const writeStarted = deferred();
  const writeGate = deferred();
  writeStaging.putGate = {
    matches: (key) => key === writeKey,
    started: () => writeStarted.resolve(),
    promise: writeGate.promise,
  };
  const writeEnvironment = new MockActivityEnvironment();
  let writeTaskSettled = false;
  const writeTask = writeEnvironment.run(createHopeProcessingActivities(
    writeStaging,
    "https://hope.tailnet.example",
    "hope-test-token-at-least-32-characters-long",
    async () => hopeResponse(protectedBytes, 2, 1),
  ).prepareHopeUpload, writeInput).finally(() => { writeTaskSettled = true; });
  await writeStarted.promise;
  writeEnvironment.cancel();
  await delay(0);
  assert.equal(writeTaskSettled, false);
  writeGate.resolve();
  await assert.rejects(writeTask, (error) => error instanceof CancelledFailure);
  assert.equal(writeTaskSettled, true);
  assert.equal(writeStaging.objects.has(writeKey), true);
});
