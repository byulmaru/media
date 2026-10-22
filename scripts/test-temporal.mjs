import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { test } from "node:test";
import sharp from "sharp";

import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { ApplicationFailure } from "@temporalio/activity";
import { defaultPayloadConverter } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import {
  createUploadProcessingActivities,
  createHopeProcessingActivities,
  createMediaServiceHandler,
  DEFAULT_MAX_BYTES,
  HOPE_TASK_QUEUE,
  JPEG_ORIENTED_2X1,
  mediaServiceHandler,
  PNG_RGBA_2X1,
  R2S3MediaStorage,
  R2S3StagingStorage,
} from "../dist/temporal/test-runtime.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PUBLIC_BASE_URL = "https://media.byulma.run";
const TASK_QUEUE = "media-nexus-tests";
const WORKFLOW_TIMEOUT_MS = 10_000;
const HOPE_API_TOKEN = "test-hope-token-do-not-log";

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

async function startHopeServer(handler) {
  const requests = [];
  const failures = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const captured = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      const reply = await handler(captured);
      if (response.destroyed) return;
      response.writeHead(reply.status ?? 200, reply.headers ?? { "content-type": "image/webp" });
      response.end(reply.body ?? Buffer.alloc(0));
    })().catch((error) => {
      if (!request.aborted && !response.destroyed) failures.push(error);
      response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    failures,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
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

async function startHopeWorker(environment, staging, hopeConfig, failures) {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace,
    taskQueue: HOPE_TASK_QUEUE,
    activities: createHopeProcessingActivities(staging, hopeConfig),
    maxConcurrentActivityTaskExecutions: 1,
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

async function startHopeCaller(environment, endpoint, input, workflowId, timeout = "25 hours") {
  return environment.client.workflow.start("nexusSetHopeCallerWorkflow", {
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

test("Nexus Hope updates prepare a bounded private variant before publishing", async () => {
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
  const responses = [];
  const hopeServer = await startHopeServer(async () => {
    const reply = responses.shift();
    assert(reply, "unexpected Hope request");
    return typeof reply === "function" ? reply() : reply;
  });
  const endpointName = `media-hope-test-${randomUUID()}`;
  const endpoint = await environment.createNexusEndpoint(endpointName, TASK_QUEUE);
  let worker;
  let hopeWorker;
  let pendingHopeResponse;

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
      staging,
      { HOPE_BASE_URL: hopeServer.url, HOPE_API_TOKEN },
      workerFailures,
    );

    const largePng = await sharp({
      create: { width: 1600, height: 800, channels: 3, background: { r: 80, g: 130, b: 190 } },
    }).png().toBuffer();
    const protectedWebp = await sharp(largePng)
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .webp()
      .toBuffer();
    const protectedMetadata = await sharp(protectedWebp).metadata();
    const source = newUpload();
    const input = uploadInput(source.id, source.sourceKey);
    const defaultKey = preparedKey(source.sourceKey);
    const publicKey = `original/${source.id}.webp`;
    staging.seed(source.sourceKey, largePng);

    const uploadCaller = await startCaller(
      environment,
      endpointName,
      input,
      `hope-upload:${randomUUID()}`,
    );
    const uploadOutcomePromise = uploadCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => staging.objects.has(defaultKey), "default private image was not prepared");
    const defaultBytes = Buffer.from(staging.objects.get(defaultKey).bytes);
    assert.notDeepEqual(defaultBytes, protectedWebp);

    pendingHopeResponse = deferred();
    responses.push(() => pendingHopeResponse.promise);
    const hopeCaller = await startHopeCaller(
      environment,
      endpointName,
      { id: source.id, hope: { algorithm: "noise", iterations: 37, intensity: 0.65 } },
      `hope-update:${randomUUID()}`,
    );
    const hopeOutcomePromise = hopeCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => hopeServer.requests.length === 1, "Hope request was not sent");

    const request = hopeServer.requests[0];
    const requestUrl = new URL(request.url, hopeServer.url);
    assert.equal(request.method, "POST");
    assert.equal(requestUrl.pathname, "/protect");
    assert.equal(requestUrl.searchParams.get("algorithm"), "noise");
    assert.equal(requestUrl.searchParams.get("iterations"), "37");
    assert.equal(requestUrl.searchParams.get("intensity"), "0.65");
    assert.equal(requestUrl.searchParams.get("max_edge"), "1024");
    assert.equal(request.headers.authorization, `Bearer ${HOPE_API_TOKEN}`);
    assert.equal(request.headers.accept, "image/webp");
    assert.equal(request.headers["content-type"], "image/png");
    assert.equal(Number(request.headers["content-length"]), request.body.byteLength);
    const requestMetadata = await sharp(request.body).metadata();
    assert.equal(requestMetadata.format, "png");
    assert.equal(requestMetadata.width, 1024);
    assert.equal(requestMetadata.height, 512);

    await delay(100);
    assert.equal((await Promise.race([
      hopeOutcomePromise.then(() => true),
      delay(0).then(() => false),
    ])), false, "setHope returned before Hope finished");

    const busyCaller = await startHopeCaller(
      environment,
      endpointName,
      { id: source.id, hope: { algorithm: "glaze", iterations: 8 } },
      `hope-busy:${randomUUID()}`,
      "5 seconds",
    );
    const busyResult = await withTimeout(busyCaller.result(), 5_000, "busy Hope update did not reject");
    assert.match(busyResult.error, /already in progress/i);
    assert.equal(hopeServer.requests.length, 1);

    const publishCaller = await startPublishCaller(
      environment,
      endpointName,
      source.id,
      `hope-publish:${randomUUID()}`,
    );
    assert.deepEqual(await withTimeout(publishCaller.result(), 5_000, "publish signal did not complete"), {
      result: { id: source.id },
    });
    const uploadHandle = environment.client.workflow.getHandle(`media-upload:${source.id}`);
    await waitFor(async () => {
      const history = await uploadHandle.fetchHistory();
      return history.events.some(
        (event) => event.workflowExecutionSignaledEventAttributes?.signalName === "publishUpload",
      );
    }, "publish signal was not recorded");
    await delay(100);
    assert.equal((await Promise.race([
      uploadOutcomePromise.then(() => true),
      delay(0).then(() => false),
    ])), false, "upload published before Hope finished");
    assert.equal(media.putCounts.get(publicKey) ?? 0, 0);
    assert.equal(staging.objects.has(source.sourceKey), true);
    assert.equal(staging.streamReads.get(defaultKey) ?? 0, 0);

    pendingHopeResponse.resolve({ body: protectedWebp });
    pendingHopeResponse = undefined;
    const hopeOutcome = await withTimeout(hopeOutcomePromise, WORKFLOW_TIMEOUT_MS, "Hope update did not finish");
    assert.equal(hopeOutcome.error, undefined);
    assert.deepEqual(hopeOutcome.value, {
      result: {
        id: source.id,
        hope: { algorithm: "noise", iterations: 37, intensity: 0.65 },
      },
    });
    const hopeKeys = staging.putStreamKeys.filter((key) => key.startsWith(`${source.sourceKey}.hope/`));
    assert.equal(hopeKeys.length, 1);

    const uploadOutcome = await withTimeout(uploadOutcomePromise, WORKFLOW_TIMEOUT_MS, "upload did not publish");
    assert.equal(uploadOutcome.error, undefined);
    assert.equal(uploadOutcome.value.upload.id, source.id);
    assert.deepEqual(media.objects.get(publicKey).bytes, protectedWebp);
    assert.equal(protectedMetadata.format, "webp");
    assert.equal(protectedMetadata.width, 1024);
    assert.equal(protectedMetadata.height, 512);
    assert.equal(staging.objects.has(source.sourceKey), false);
    assert.equal(staging.objects.has(defaultKey), false);
    assert.equal(staging.objects.has(hopeKeys[0]), false);
    assert.deepEqual(
      staging.deleteKeys.filter((key) => key === hopeKeys[0] || key === defaultKey || key === source.sourceKey),
      [hopeKeys[0], defaultKey, source.sourceKey],
    );

    const historyText = JSON.stringify({
      upload: await uploadHandle.fetchHistory(),
      hope: await hopeCaller.fetchHistory(),
      busy: await busyCaller.fetchHistory(),
      publish: await publishCaller.fetchHistory(),
      failures: workerFailures,
    });
    assert.equal(historyText.includes(HOPE_API_TOKEN), false);
    assert.deepEqual(workerFailures, []);
    assert.deepEqual(hopeServer.failures, []);
  } finally {
    pendingHopeResponse?.resolve({
      headers: { "content-type": "image/webp" },
      body: Buffer.from("invalid WebP test cleanup"),
    });
    if (worker) await stopWorker(worker).catch(() => undefined);
    if (hopeWorker) await stopWorker(hopeWorker).catch(() => undefined);
    await environment.deleteNexusEndpoint(endpoint).catch(() => undefined);
    await hopeServer.close();
    await environment.teardown();
  }
});

test("Nexus Hope retries transient responses, blocks stale publication on failure, and clears to default", async () => {
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
  const responses = [];
  const hopeServer = await startHopeServer(async () => {
    const reply = responses.shift();
    assert(reply, "unexpected Hope request");
    return typeof reply === "function" ? reply() : reply;
  });
  const endpointName = `media-hope-failure-test-${randomUUID()}`;
  const endpoint = await environment.createNexusEndpoint(endpointName, TASK_QUEUE);
  let worker;
  let hopeWorker;
  let pendingFailureResponse;

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
      staging,
      { HOPE_BASE_URL: hopeServer.url, HOPE_API_TOKEN },
      workerFailures,
    );

    const source = newUpload();
    const input = uploadInput(source.id, source.sourceKey);
    const defaultKey = preparedKey(source.sourceKey);
    const publicKey = `original/${source.id}.webp`;
    const responseWebp = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 240, g: 25, b: 135 } },
    }).webp({ quality: 50 }).toBuffer();
    staging.seed(source.sourceKey, PNG_1X1);
    const uploadCaller = await startCaller(
      environment,
      endpointName,
      input,
      `hope-failure-upload:${randomUUID()}`,
    );
    const uploadOutcomePromise = uploadCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => staging.objects.has(defaultKey), "default private image was not prepared");
    const defaultBytes = Buffer.from(staging.objects.get(defaultKey).bytes);

    responses.push(
      { status: 503, headers: { "content-type": "text/plain" }, body: "try again" },
      { body: responseWebp },
    );
    const successfulHopeCaller = await startHopeCaller(
      environment,
      endpointName,
      { id: source.id, hope: { algorithm: "glaze", iterations: 29 } },
      `hope-retry:${randomUUID()}`,
      "10 seconds",
    );
    const successfulHopeResult = await withTimeout(
      successfulHopeCaller.result(),
      10_000,
      "transient Hope response did not retry",
    );
    assert.equal(hopeServer.requests.length, 2);
    assert.deepEqual(hopeServer.requests[0].body, hopeServer.requests[1].body);
    for (const request of hopeServer.requests) {
      assert.equal(request.headers.authorization, `Bearer ${HOPE_API_TOKEN}`);
      assert.equal(new URL(request.url, hopeServer.url).searchParams.get("intensity"), "0.3");
      const metadata = await sharp(request.body).metadata();
      assert.equal(metadata.format, "png");
      assert.equal(metadata.width, 1);
      assert.equal(metadata.height, 1);
    }
    assert.deepEqual(successfulHopeResult, {
      result: { id: source.id, hope: { algorithm: "glaze", iterations: 29, intensity: 0.3 } },
    });
    const lastGoodKey = staging.putStreamKeys.find((key) => key.startsWith(`${source.sourceKey}.hope/`));
    assert(lastGoodKey);
    assert.equal(staging.objects.has(source.sourceKey), true);

    pendingFailureResponse = deferred();
    responses.push(() => pendingFailureResponse.promise);
    const failedStatusCaller = await startHopeCaller(
      environment,
      endpointName,
      { id: source.id, hope: { algorithm: "noise", iterations: 17 } },
      `hope-http-failure:${randomUUID()}`,
      "5 seconds",
    );
    const failedStatusOutcomePromise = failedStatusCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => hopeServer.requests.length === 3, "HTTP error Hope request was not sent");

    const pendingPublishCaller = await startPublishCaller(
      environment,
      endpointName,
      source.id,
      `hope-pending-publish:${randomUUID()}`,
    );
    assert.deepEqual(await withTimeout(
      pendingPublishCaller.result(),
      5_000,
      "publish signal did not complete while Hope was pending",
    ), { result: { id: source.id } });
    const uploadHandle = environment.client.workflow.getHandle(`media-upload:${source.id}`);
    await waitFor(async () => {
      const history = await uploadHandle.fetchHistory();
      return history.events.some(
        (event) => event.workflowExecutionSignaledEventAttributes?.signalName === "publishUpload",
      );
    }, "publish signal was not recorded");
    pendingFailureResponse.resolve({
      status: 400,
      headers: { "content-type": "application/json" },
      body: "invalid parameters",
    });
    pendingFailureResponse = undefined;
    const failedStatusOutcome = await withTimeout(
      failedStatusOutcomePromise,
      WORKFLOW_TIMEOUT_MS,
      "non-retryable Hope HTTP error did not finish",
    );
    assert.match(failedStatusOutcome.value.error, /HopeHttpError/);
    assert.equal(hopeServer.requests.length, 3);
    assert.equal(staging.objects.has(lastGoodKey), true);
    assert.equal(staging.objects.has(source.sourceKey), true);
    assert.equal(media.objects.has(publicKey), false);
    assert.equal(media.putCounts.get(publicKey) ?? 0, 0);
    assert.equal((await Promise.race([
      uploadOutcomePromise.then(() => true),
      delay(100).then(() => false),
    ])), false, "failed Hope published the last successful variant");

    const failedHopeCallers = [successfulHopeCaller, failedStatusCaller];
    async function expectRejectedHope(reply, type, label) {
      const requestCount = hopeServer.requests.length;
      responses.push(reply);
      const caller = await startHopeCaller(
        environment,
        endpointName,
        { id: source.id, hope: { algorithm: "nightshade", iterations: 11 } },
        `hope-${label}:${randomUUID()}`,
        "5 seconds",
      );
      failedHopeCallers.push(caller);
      const result = await withTimeout(caller.result(), 5_000, `${label} Hope response did not reject`);
      assert.match(result.error, new RegExp(type));
      assert.equal(hopeServer.requests.length, requestCount + 1);
      assert.equal(staging.objects.has(lastGoodKey), true);
      assert.equal(staging.objects.has(source.sourceKey), true);
      assert.equal(media.putCounts.get(publicKey) ?? 0, 0);
    }

    await expectRejectedHope({
      status: 200,
      headers: { "content-type": "image/png" },
      body: PNG_1X1,
    }, "HopeOutputError", "non-webp");
    await expectRejectedHope({ body: Buffer.from("not a WebP") }, "HopeOutputError", "invalid-webp");
    await expectRejectedHope({ body: Buffer.alloc(DEFAULT_MAX_BYTES + 1) }, "HopeOutputError", "oversized");

    const requestCountBeforeClear = hopeServer.requests.length;
    const clearCaller = await startHopeCaller(
      environment,
      endpointName,
      { id: source.id, hope: null },
      `hope-clear:${randomUUID()}`,
      "5 seconds",
    );
    failedHopeCallers.push(clearCaller);
    assert.deepEqual(await withTimeout(clearCaller.result(), 5_000, "clear Hope update did not finish"), {
      result: { id: source.id, hope: null },
    });
    assert.equal(hopeServer.requests.length, requestCountBeforeClear);
    assert.equal(media.objects.has(publicKey), false);

    const finalPublishCaller = await startPublishCaller(
      environment,
      endpointName,
      source.id,
      `hope-clear-publish:${randomUUID()}`,
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
    assert.notDeepEqual(media.objects.get(publicKey).bytes, responseWebp);
    assert.equal(staging.objects.has(lastGoodKey), false);
    assert.equal(staging.objects.has(defaultKey), false);
    assert.equal(staging.objects.has(source.sourceKey), false);

    const scopedDeletes = staging.deleteKeys.filter((key) =>
      key === source.sourceKey || key === defaultKey || key.startsWith(`${source.sourceKey}.hope/`),
    );
    const defaultDeleteIndex = scopedDeletes.indexOf(defaultKey);
    const sourceDeleteIndex = scopedDeletes.lastIndexOf(source.sourceKey);
    const hopeDeleteKeys = scopedDeletes.filter((key) => key.startsWith(`${source.sourceKey}.hope/`));
    assert(defaultDeleteIndex >= 0 && sourceDeleteIndex > defaultDeleteIndex);
    assert(hopeDeleteKeys.every((key) => scopedDeletes.indexOf(key) < defaultDeleteIndex));
    assert.equal(hopeDeleteKeys.length, 5);

    const histories = await Promise.all(failedHopeCallers.map((caller) => caller.fetchHistory()));
    assert.equal(JSON.stringify({ upload: await uploadHandle.fetchHistory(), histories, workerFailures })
      .includes(HOPE_API_TOKEN), false);
    assert.deepEqual(workerFailures, []);
    assert.deepEqual(hopeServer.failures, []);
  } finally {
    pendingFailureResponse?.resolve({ status: 400, body: "cleanup" });
    if (worker) await stopWorker(worker).catch(() => undefined);
    if (hopeWorker) await stopWorker(hopeWorker).catch(() => undefined);
    await environment.deleteNexusEndpoint(endpoint).catch(() => undefined);
    await hopeServer.close();
    await environment.teardown();
  }
});

test("Hope expiry cancels a blocked fetch and caller cancellation drains an in-flight private write", async () => {
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
  const responses = [];
  const hopeServer = await startHopeServer(async () => {
    const reply = responses.shift();
    assert(reply, "unexpected Hope request");
    return typeof reply === "function" ? reply() : reply;
  });
  const endpointName = `media-hope-cancel-test-${randomUUID()}`;
  const endpoint = await environment.createNexusEndpoint(endpointName, TASK_QUEUE);
  let worker;
  let hopeWorker;
  let pendingExpiryResponse;
  let privateWrite;

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
      staging,
      { HOPE_BASE_URL: hopeServer.url, HOPE_API_TOKEN },
      workerFailures,
    );
    const responseWebp = await sharp(PNG_1X1).webp().toBuffer();

    const expiring = newUpload();
    const expiringDefaultKey = preparedKey(expiring.sourceKey);
    const expiringPublicKey = `original/${expiring.id}.webp`;
    // Hope activities heartbeat every 5 seconds, so expiry needs to follow a heartbeat
    // for Temporal to deliver cancellation while the HTTP request is still blocked.
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
      `hope-expiring-upload:${randomUUID()}`,
    );
    const expiringOutcomePromise = expiringCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => staging.objects.has(expiringDefaultKey), "expiring image was not prepared");
    pendingExpiryResponse = deferred();
    responses.push(() => pendingExpiryResponse.promise);
    const expiringHopeCaller = await startHopeCaller(
      environment,
      endpointName,
      { id: expiring.id, hope: { algorithm: "noise", iterations: 8 } },
      `hope-expiring-update:${randomUUID()}`,
      "30 seconds",
    );
    const expiringHopeOutcomePromise = expiringHopeCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => hopeServer.requests.length === 1, "expiring Hope request did not start");
    const expiringOutcome = await withTimeout(
      expiringOutcomePromise,
      remainingLifetimeMs + 10_000,
      "upload did not expire while Hope HTTP was blocked",
    );
    assert.equal(expiringOutcome.error, undefined);
    assert.match(expiringOutcome.value.error, /upload expired before publication/i);
    pendingExpiryResponse.resolve({ body: responseWebp });
    pendingExpiryResponse = undefined;
    await withTimeout(expiringHopeOutcomePromise, WORKFLOW_TIMEOUT_MS, "expiring Hope update did not settle");
    assert.equal(staging.objects.has(expiring.sourceKey), false);
    assert.equal(staging.objects.has(expiringDefaultKey), false);
    assert.equal(staging.putStreamKeys.some((key) => key.startsWith(`${expiring.sourceKey}.hope/`)), false);
    assert.equal(media.putCounts.get(expiringPublicKey) ?? 0, 0);

    const cancelled = newUpload();
    const cancelledDefaultKey = preparedKey(cancelled.sourceKey);
    const cancelledPublicKey = `original/${cancelled.id}.webp`;
    staging.seed(cancelled.sourceKey, PNG_1X1);
    const cancelledCaller = await startCaller(
      environment,
      endpointName,
      uploadInput(cancelled.id, cancelled.sourceKey),
      `hope-cancelled-upload:${randomUUID()}`,
    );
    const cancelledOutcomePromise = cancelledCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await waitFor(() => staging.objects.has(cancelledDefaultKey), "cancelled image was not prepared");

    const privateWriteGate = deferred();
    const privateWriteStarted = deferred();
    let privateWriteKey;
    staging.putGate = {
      matches: (key) => key.startsWith(`${cancelled.sourceKey}.hope/`),
      started: (key) => {
        privateWriteKey = key;
        privateWriteStarted.resolve(key);
      },
      promise: privateWriteGate.promise,
    };
    privateWrite = privateWriteGate;
    responses.push({ body: responseWebp });
    const cancelledHopeCaller = await startHopeCaller(
      environment,
      endpointName,
      { id: cancelled.id, hope: { algorithm: "glaze", iterations: 13 } },
      `hope-cancelled-update:${randomUUID()}`,
      "5 seconds",
    );
    const cancelledHopeOutcomePromise = cancelledHopeCaller.result().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await withTimeout(privateWriteStarted.promise, WORKFLOW_TIMEOUT_MS, "Hope private write did not start");
    assert.equal(staging.objects.has(privateWriteKey), false);

    await cancelledCaller.cancel();
    await delay(100);
    assert.equal((await Promise.race([
      cancelledOutcomePromise.then(() => true),
      delay(0).then(() => false),
    ])), false, "caller cancellation finished before the in-flight private write drained");
    assert.equal(staging.objects.has(privateWriteKey), false);
    assert.equal(media.putCounts.get(cancelledPublicKey) ?? 0, 0);

    privateWrite.resolve();
    privateWrite = undefined;
    const cancelledOutcome = await withTimeout(
      cancelledOutcomePromise,
      WORKFLOW_TIMEOUT_MS,
      "cancelled upload did not finish after the private write drained",
    );
    assert(cancelledOutcome.error);
    assert.match(errorCauseChain(cancelledOutcome.error), /CancelledFailure/);
    await withTimeout(cancelledHopeOutcomePromise, WORKFLOW_TIMEOUT_MS, "cancelled Hope update did not settle");
    const cancelledHistory = await environment.client.workflow.getHandle(`media-upload:${cancelled.id}`).fetchHistory();
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
        key === sourceKey || key === defaultKey || key.startsWith(`${sourceKey}.hope/`),
      );
      const defaultDeleteIndex = scopedDeletes.indexOf(defaultKey);
      const sourceDeleteIndex = scopedDeletes.lastIndexOf(sourceKey);
      assert(defaultDeleteIndex >= 0 && sourceDeleteIndex > defaultDeleteIndex);
      assert(scopedDeletes.filter((key) => key.startsWith(`${sourceKey}.hope/`))
        .every((key) => scopedDeletes.indexOf(key) < defaultDeleteIndex));
    }

    const safetyHistory = JSON.stringify({
      expiring: await environment.client.workflow.getHandle(`media-upload:${expiring.id}`).fetchHistory(),
      expiringHope: await expiringHopeCaller.fetchHistory(),
      cancelled: cancelledHistory,
      cancelledHope: await cancelledHopeCaller.fetchHistory(),
      workerFailures,
    });
    assert.equal(safetyHistory.includes(HOPE_API_TOKEN), false);
    assert.deepEqual(workerFailures, []);
    assert.deepEqual(hopeServer.failures, []);
  } finally {
    pendingExpiryResponse?.resolve({ body: Buffer.from("cleanup") });
    privateWrite?.resolve();
    staging.putGate = undefined;
    if (worker) await stopWorker(worker).catch(() => undefined);
    if (hopeWorker) await stopWorker(hopeWorker).catch(() => undefined);
    await environment.deleteNexusEndpoint(endpoint).catch(() => undefined);
    await hopeServer.close();
    await environment.teardown();
  }
});
