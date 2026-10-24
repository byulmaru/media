import { ApplicationFailure, Context } from "@temporalio/activity";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import sharp from "sharp";

import { DEFAULT_MAX_BYTES, IMMUTABLE_CACHE_CONTROL, MAX_PIXELS } from "../constants";
import { HttpError } from "../errors";
import { validateImageUpload } from "../image-info";
import { ensurePreparedUpload } from "../prepare-upload.node";
import { hopePreparedUploadKey, isPreparedUpload, preparedUploadKey } from "../prepared-upload";
import type { R2S3MediaStorage } from "../storage/r2-s3";
import type { UploadStagingStorage } from "../storage/staging";
import type {
  HopeProcessingInput,
  ProcessUploadInput,
  ProcessUploadResult,
  PublishPreparedUploadInput,
  UploadSourceCleanupInput,
} from "./types";
import {
  HOPE_MAX_EDGE,
  HOPE_PROCESSING_ERROR_TYPE,
  UPLOAD_EXPIRATION_MS,
  UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
  UPLOAD_EXPIRED_ERROR_TYPE,
  UPLOAD_SOURCE_ERROR_TYPE,
  UPLOAD_VALIDATION_CODES,
  UPLOAD_VALIDATION_ERROR_TYPE,
} from "./types";
import {
  parseHopeProcessingInput,
  parseProcessUploadInput,
  parsePublishPreparedUploadInput,
  parseUploadSourceCleanupInput,
} from "./validation";

const validationCodes: ReadonlySet<string> = new Set(UPLOAD_VALIDATION_CODES);
const maxHopeResponseBytes = DEFAULT_MAX_BYTES;
const hopeResponseHeaders = [
  "content-length",
  "content-type",
  "x-hope-height",
  "x-hope-model-calls",
  "x-hope-width",
] as const;

type HopeHttpResponse = {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
};

type HopeHttpRequestOptions = {
  method: "POST";
  headers: Record<string, string>;
  body: Buffer;
  signal: AbortSignal;
};

type HopeHttpRequest = (url: URL, options: HopeHttpRequestOptions) => Promise<HopeHttpResponse>;

export function createHopeHttpRequest(createRequest: typeof httpsRequest = httpsRequest): HopeHttpRequest {
  return (url, options) => new Promise((resolve, reject) => {
    const request = createRequest(url, {
      method: options.method,
      headers: {
        ...options.headers,
        "content-length": String(options.body.byteLength),
      },
      agent: false,
      timeout: 0,
      signal: options.signal,
    }, (response) => {
      const status = response.statusCode ?? 502;
      const headers = new Headers();
      for (const name of hopeResponseHeaders) {
        const value = response.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const body = status === 204 || status === 304
        ? null
        : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      if (body === null) response.destroy();
      resolve({ status, headers, body });
    });
    request.once("error", reject);
    request.end(options.body);
  });
}

const requestHope = createHopeHttpRequest();

function asNonRetryableValidationFailure(error: unknown): ApplicationFailure | undefined {
  if (
    !(error instanceof HttpError) ||
    error.status < 400 ||
    error.status >= 500 ||
    !validationCodes.has(error.code)
  ) {
    return undefined;
  }
  return ApplicationFailure.create({
    message: "upload validation failed",
    type: UPLOAD_VALIDATION_ERROR_TYPE,
    nonRetryable: true,
    details: [{ status: error.status, code: error.code }],
  });
}

function invalidProcessingInput(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "upload processing input is invalid",
    type: UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
    nonRetryable: true,
    details: [{ code: "invalid_processing_input" }],
  });
}

function invalidUploadSource(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "upload source metadata is missing or invalid",
    type: UPLOAD_SOURCE_ERROR_TYPE,
    nonRetryable: true,
  });
}

function uploadExpired(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "upload expired before publication",
    type: UPLOAD_EXPIRED_ERROR_TYPE,
    nonRetryable: true,
  });
}

function hopeProcessingFailure(nonRetryable: boolean): ApplicationFailure {
  return ApplicationFailure.create({
    message: "Hope processing failed",
    type: HOPE_PROCESSING_ERROR_TYPE,
    nonRetryable,
  });
}

function positiveIntegerHeader(response: HopeHttpResponse, name: string): number | undefined {
  const header = response.headers.get(name);
  if (header === null || !/^\d+$/.test(header)) return undefined;
  const value = Number(header);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function readHopeResponse(response: HopeHttpResponse, signal: AbortSignal): Promise<Buffer> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    if (!/^\d+$/.test(contentLengthHeader)) {
      await response.body?.cancel().catch(() => undefined);
      throw hopeProcessingFailure(true);
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxHopeResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw hopeProcessingFailure(true);
    }
  }
  if (!response.body) throw hopeProcessingFailure(true);

  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxHopeResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw hopeProcessingFailure(true);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof ApplicationFailure) throw error;
    throw hopeProcessingFailure(false);
  } finally {
    reader.releaseLock();
  }
  if (size === 0 || (contentLengthHeader !== null && Number(contentLengthHeader) !== size)) {
    throw hopeProcessingFailure(true);
  }
  return Buffer.concat(chunks, size);
}

async function decodeImage(bytes: Buffer, format: string): Promise<sharp.Metadata> {
  try {
    const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
    await sharp(bytes, { limitInputPixels: MAX_PIXELS }).stats();
    if (metadata.format !== format || !metadata.width || !metadata.height) {
      throw new Error("image metadata is invalid");
    }
    return metadata;
  } catch {
    throw new HttpError(422, "invalid_image", "image processing failed");
  }
}

function isHopePreparedUpload(object: Awaited<ReturnType<UploadStagingStorage["head"]>>): boolean {
  return object !== null && isPreparedUpload(object) && object.size !== undefined &&
    object.size <= maxHopeResponseBytes;
}

export function createHopeProcessingActivities(
  staging: UploadStagingStorage,
  apiUrl: string,
  apiToken: string,
  requestHopeResponse: HopeHttpRequest = requestHope,
) {
  return {
    async prepareHopeUpload(rawInput: HopeProcessingInput): Promise<void> {
      const input = parseHopeProcessingInput(rawInput);
      if (!input) throw invalidProcessingInput();

      const context = Context.current();
      const heartbeatController = new AbortController();
      const signal = AbortSignal.any([context.cancellationSignal, heartbeatController.signal]);
      const timer = setInterval(() => {
        try {
          context.heartbeat();
        } catch (error) {
          heartbeatController.abort(error);
        }
      }, 4_000);

      try {
        const lastModified = await staging.headLastModified(input.sourceKey);
        signal.throwIfAborted();
        if (
          !(lastModified instanceof Date) ||
          !Number.isFinite(lastModified.getTime()) ||
          lastModified.getTime() <= 0 ||
          lastModified.getTime() > Date.now()
        ) {
          throw invalidUploadSource();
        }
        const deadline = lastModified.getTime() + UPLOAD_EXPIRATION_MS;
        if (!Number.isFinite(deadline)) throw invalidUploadSource();
        if (Date.now() >= deadline) throw uploadExpired();

        const key = hopePreparedUploadKey(input.sourceKey, input.requestId);
        const existing = await staging.head(key);
        signal.throwIfAborted();
        if (existing) {
          if (isHopePreparedUpload(existing)) return;
          throw hopeProcessingFailure(true);
        }

        let sourceBytes: ArrayBuffer;
        try {
          sourceBytes = await staging.get(input.sourceKey, input.maxBytes);
        } catch (error) {
          if (error instanceof RangeError) {
            throw new HttpError(413, "size_limit_exceeded", "image exceeds maxBytes");
          }
          throw error;
        }
        signal.throwIfAborted();
        if (sourceBytes.byteLength > input.maxBytes) {
          throw new HttpError(413, "size_limit_exceeded", "image exceeds maxBytes");
        }

        const sourceInfo = validateImageUpload(sourceBytes, input.contentType, input);
        const sourceMetadata = await decodeImage(Buffer.from(sourceBytes), sourceInfo.format);
        if (sourceMetadata.width !== sourceInfo.width || sourceMetadata.height !== sourceInfo.height) {
          throw new HttpError(422, "invalid_image", "image processing failed");
        }
        signal.throwIfAborted();

        const url = new URL("/protect", apiUrl);
        url.search = new URLSearchParams({
          algorithm: input.hope.algorithm,
          iterations: String(input.hope.iterations),
          intensity: String(input.hope.intensity),
          max_edge: String(HOPE_MAX_EDGE),
          quality: "80",
        }).toString();

        let response: HopeHttpResponse;
        try {
          response = await requestHopeResponse(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiToken}`,
              "content-type": "application/octet-stream",
            },
            body: Buffer.from(sourceBytes),
            signal,
          });
        } catch (error) {
          if (signal.aborted) signal.throwIfAborted();
          throw hopeProcessingFailure(false);
        }
        signal.throwIfAborted();
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          signal.throwIfAborted();
          const retryable = response.status === 408 || response.status === 429 ||
            response.status === 503 || (response.status >= 500 && response.status <= 599);
          throw hopeProcessingFailure(!retryable);
        }
        if (
          response.headers.get("content-type")?.toLowerCase() !== "image/webp" ||
          positiveIntegerHeader(response, "x-hope-model-calls") === undefined
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw hopeProcessingFailure(true);
        }
        const declaredWidth = positiveIntegerHeader(response, "x-hope-width");
        const declaredHeight = positiveIntegerHeader(response, "x-hope-height");
        if (declaredWidth === undefined || declaredHeight === undefined) {
          await response.body?.cancel().catch(() => undefined);
          throw hopeProcessingFailure(true);
        }

        const output = await readHopeResponse(response, signal);
        let outputInfo;
        let outputMetadata: sharp.Metadata;
        try {
          outputInfo = validateImageUpload(
            output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer,
            "image/webp",
            { maxBytes: maxHopeResponseBytes, maxDimension: HOPE_MAX_EDGE },
          );
          outputMetadata = await decodeImage(output, "webp");
        } catch {
          throw hopeProcessingFailure(true);
        }
        if (
          outputMetadata.width !== outputInfo.width ||
          outputMetadata.height !== outputInfo.height ||
          outputInfo.width !== declaredWidth ||
          outputInfo.height !== declaredHeight
        ) {
          throw hopeProcessingFailure(true);
        }
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw uploadExpired();

        const outputStream = Readable.from([output]);
        try {
          const stored = await staging.putStream(
            key,
            outputStream,
            output.byteLength,
            {
              onlyIf: new Headers({ "If-None-Match": "*" }),
              httpMetadata: { contentType: "image/webp" },
            },
          );
          signal.throwIfAborted();
          if (!stored && !isHopePreparedUpload(await staging.head(key))) {
            throw hopeProcessingFailure(true);
          }
          signal.throwIfAborted();
        } finally {
          outputStream.destroy();
        }
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted();
        throw asNonRetryableValidationFailure(error) ?? error;
      } finally {
        clearInterval(timer);
      }
    },
  };
}

export function createUploadProcessingActivities(
  staging: UploadStagingStorage,
  media: Pick<R2S3MediaStorage, "head" | "putStream">,
  publicBaseUrl: string,
) {
  async function publishPreparedUpload(input: PublishPreparedUploadInput): Promise<ProcessUploadResult> {
    const outputKey = `original/${input.id}.webp`;
    const stagingKey = input.hopeRequestId
      ? hopePreparedUploadKey(input.sourceKey, input.hopeRequestId)
      : preparedUploadKey(input.sourceKey);
    const result: ProcessUploadResult = {
      id: input.id,
      url: `${publicBaseUrl}/${outputKey}`,
      mediaType: "image/webp",
    };
    if (await media.head(outputKey)) return result;

    const prepared = await staging.getStream(stagingKey, "image/webp");
    if (!prepared) throw new Error("prepared upload object is missing");
    try {
      const stored = await media.putStream(
        outputKey,
        prepared.body,
        prepared.contentLength,
        {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: {
            contentType: "image/webp",
            cacheControl: IMMUTABLE_CACHE_CONTROL,
          },
        },
      );
      if (!stored && !(await media.head(outputKey))) {
        throw new Error("conditional media write could not be confirmed");
      }
      return result;
    } finally {
      prepared.body.destroy();
    }
  }

  return {
    async getUploadSourceLastModified(rawInput: ProcessUploadInput): Promise<number> {
      const input = parseProcessUploadInput(rawInput);
      if (!input) throw invalidProcessingInput();

      const lastModified = await staging.headLastModified(input.sourceKey);
      if (!(lastModified instanceof Date) || !Number.isFinite(lastModified.getTime())) {
        throw invalidUploadSource();
      }
      return lastModified.getTime();
    },

    async prepareUploadImage(rawInput: ProcessUploadInput): Promise<void> {
      const input = parseProcessUploadInput(rawInput);
      if (!input) throw invalidProcessingInput();
      if (await media.head(`original/${input.id}.webp`)) return;
      try {
        await ensurePreparedUpload(staging, input);
      } catch (error) {
        throw asNonRetryableValidationFailure(error) ?? error;
      }
    },

    async publishPreparedUpload(rawInput: PublishPreparedUploadInput): Promise<ProcessUploadResult> {
      const input = parsePublishPreparedUploadInput(rawInput);
      if (!input) throw invalidProcessingInput();
      return publishPreparedUpload(input);
    },

    // Retained for histories that predate prepared-before-wait publication.
    async processUploadImage(rawInput: ProcessUploadInput): Promise<ProcessUploadResult> {
      const input = parseProcessUploadInput(rawInput);
      if (!input) throw invalidProcessingInput();
      const outputKey = `original/${input.id}.webp`;
      if (await media.head(outputKey)) {
        return {
          id: input.id,
          url: `${publicBaseUrl}/${outputKey}`,
          mediaType: "image/webp",
        };
      }
      try {
        await ensurePreparedUpload(staging, input);
        return await publishPreparedUpload(input);
      } catch (error) {
        throw asNonRetryableValidationFailure(error) ?? error;
      }
    },

    async deleteUploadSource(rawInput: UploadSourceCleanupInput): Promise<void> {
      const input = parseUploadSourceCleanupInput(rawInput);
      if (!input) throw invalidProcessingInput();
      for (const requestId of input.hopeRequestIds ?? []) {
        await staging.delete(hopePreparedUploadKey(input.sourceKey, requestId));
      }
      await staging.delete(preparedUploadKey(input.sourceKey));
      await staging.delete(input.sourceKey);
    },
  };
}
