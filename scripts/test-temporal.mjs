import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import {
  GetObjectCommand,
  HeadObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { defaultPayloadConverter } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import {
  createUploadProcessingActivities,
  initializeUploadProcessingCodec,
  mediaServiceHandler,
  R2S3StagingStorage,
} from "../dist/temporal/test-runtime.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PUBLIC_BASE_URL = "https://media.byulma.run";
const TASK_QUEUE = "media-nexus-tests";
const WORKFLOW_TIMEOUT_MS = 10_000;

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
});

class MemoryStagingStorage {
  objects = new Map();
  lastModifiedReads = new Map();
  contentReads = new Map();
  deleteKeys = [];

  seed(key, bytes, lastModified = new Date()) {
    this.objects.set(key, { bytes: Uint8Array.from(bytes), lastModified });
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
    return object.bytes.slice().buffer;
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
    this.putCounts.set(key, (this.putCounts.get(key) ?? 0) + 1);
    if (this.objects.has(key)) return null;
    this.objects.set(key, {
      bytes: Buffer.from(bytes),
      httpMetadata: options.httpMetadata,
    });
    if (this.failAfterCommitKey === key) {
      this.failAfterCommitKey = undefined;
      throw new Error("transient error after committed write");
    }
    return {};
  }
}

function uploadInput(id, sourceKey) {
  return {
    id,
    sourceKey,
    contentType: "image/png",
    maxBytes: 1024 * 1024,
    maxDimension: 8192,
  };
}

function newUpload() {
  const id = `u_${randomUUID()}`;
  return { id, sourceKey: `uploads/${id}/${randomUUID()}` };
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

async function startWorker(environment, workflowBundle, staging, media, failures) {
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    namespace: environment.namespace,
    taskQueue: TASK_QUEUE,
    workflowBundle: { code: workflowBundle.code },
    activities: createUploadProcessingActivities(staging, media, PUBLIC_BASE_URL),
    nexusServices: [mediaServiceHandler],
    maxConcurrentActivityTaskExecutions: 1,
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

async function awaitUploadWorkflowWaiting(environment, staging, id, sourceKey) {
  await waitFor(
    () => staging.lastModifiedReads.get(sourceKey) > 0,
    "workflow did not inspect source metadata",
  );
  await waitFor(async () => {
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

test("Nexus upload operations wait, publish idempotently, and clean up terminal workflows", async () => {
  await initializeUploadProcessingCodec();
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
    assert.equal(staging.contentReads.get(successful.sourceKey) ?? 0, 0);
    assert.equal(media.putCounts.get(outputKey) ?? 0, 0);
    assert.equal(media.objects.has(outputKey), false);

    const history = await environment.client.workflow.getHandle(`media-upload:${successful.id}`).fetchHistory();
    assert.deepEqual(startedInput(history), successfulInput);
    assert.equal(JSON.stringify(history.events).includes(PNG_1X1.toString("base64")), false);
    const callerHistory = await environment.client.workflow.getHandle(successfulCaller.workflowId).fetchHistory();
    assert.equal(JSON.stringify(callerHistory.events).includes(PNG_1X1.toString("base64")), false);

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
    assert.equal(staging.contentReads.get(successful.sourceKey) ?? 0, 0);

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
    assert.equal(stored.bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(stored.bytes.toString("ascii", 8, 12), "WEBP");

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
    await awaitUploadWorkflowWaiting(environment, staging, badImage.id, badImage.sourceKey);
    await badImageCaller.signal("finishNexusUploadTest");
    const badImageResult = await withTimeout(
      badImageCaller.result(),
      WORKFLOW_TIMEOUT_MS,
      "invalid image did not fail after publication",
    );
    assert.match(badImageResult.error, /invalid_image|upload validation failed/i);
    assert.equal(media.putCounts.get(`original/${badImage.id}.webp`) ?? 0, 0);
    assert.equal(staging.objects.has(badImage.sourceKey), false);
    assert.equal(staging.contentReads.get(badImage.sourceKey), 1);

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
    }

    const expiring = newUpload();
    const remainingLifetimeMs = 2_000;
    staging.seed(
      expiring.sourceKey,
      PNG_1X1,
      new Date(Date.now() - 24 * 60 * 60 * 1000 + remainingLifetimeMs),
    );
    const expiringCaller = await startCaller(
      environment,
      endpointName,
      uploadInput(expiring.id, expiring.sourceKey),
      `expiring-caller:${randomUUID()}`,
    );
    await awaitUploadWorkflowWaiting(environment, staging, expiring.id, expiring.sourceKey);
    await waitFor(
      () => !staging.objects.has(expiring.sourceKey) && staging.deleteKeys.includes(expiring.sourceKey),
      "short remaining-life upload did not expire and clean up",
    );
    assert.equal(staging.contentReads.get(expiring.sourceKey) ?? 0, 0);
    assert.equal(media.putCounts.get(`original/${expiring.id}.webp`) ?? 0, 0);
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
    assert.equal(staging.contentReads.get(cancelled.sourceKey) ?? 0, 0);
    assert.equal(media.putCounts.get(`original/${cancelled.id}.webp`) ?? 0, 0);
    assert.deepEqual(workerFailures, []);
  } finally {
    if (worker) await stopWorker(worker).catch(() => undefined);
    await environment.deleteNexusEndpoint(endpoint).catch(() => undefined);
    await environment.teardown();
  }
});
