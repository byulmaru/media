import { ApplicationFailure, Context } from "@temporalio/activity";
import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import sharp from "sharp";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DIMENSION,
  IMMUTABLE_CACHE_CONTROL,
  MAX_PIXELS,
} from "../constants";
import { HttpError } from "../errors";
import { validateImageUpload } from "../image-info";
import { ensurePreparedUpload } from "../prepare-upload.node";
import {
  hopePreparedUploadKey,
  isPreparedUpload,
  preparedUploadKey,
  uploadSourceKey,
} from "../prepared-upload";
import type { R2S3MediaStorage } from "../storage/r2-s3";
import type { UploadStagingStorage } from "../storage/staging";
import type {
  HopeProcessingInput,
  ProcessUploadInput,
  ProcessUploadResult,
  PublishPreparedUploadInput,
  PublishUploadMetadata,
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
  UPLOAD_METADATA_CONFLICT_ERROR_TYPE,
} from "./types";
import {
  createHopeObservability,
  type HopeFailure,
  type HopeObservability,
} from "./hope-observability";
import {
  parseHopeProcessingInput,
  parseProcessUploadInput,
  parsePublishPreparedUploadInput,
  parseUploadSourceCleanupInput,
} from "./validation";

const validationCodes: ReadonlySet<string> = new Set(UPLOAD_VALIDATION_CODES);
const maxHopeResponseBytes = DEFAULT_MAX_BYTES;
const publicationMetadataMarker = "publication-metadata-sha256";
const plusDataMining = "http://ns.useplus.org/ldf/vocab/DMI-PROHIBITED-AIMLTRAINING";
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

const requestHope: HopeHttpRequest = (url, options) => new Promise((resolve, reject) => {
  const request = httpsRequest(url, {
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

function metadataPublicationConflict(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "Upload metadata does not match the existing public image",
    type: UPLOAD_METADATA_CONFLICT_ERROR_TYPE,
    nonRetryable: true,
  });
}

function metadataSha256(metadata: PublishUploadMetadata): string {
  const values = [
    ["credit", "text", metadata.credit],
    ["copyright", metadata.copyright === undefined ? ["absent"] : ["text", metadata.copyright]],
    ["usageTerms", metadata.usageTerms === undefined ? ["absent"] : ["text", metadata.usageTerms]],
    ["webStatement", metadata.webStatement === undefined ? ["absent"] : ["url", metadata.webStatement]],
  ];
  return createHash("sha256")
    .update(JSON.stringify(["media-publication-metadata-v1", values]))
    .digest("hex");
}

function xmlText(value: string): string {
  return value.replace(/[&<>"'\r]/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&apos;";
      case "\r": return "&#xD;";
      default: return character;
    }
  });
}

function xmpPacket(metadata: PublishUploadMetadata): Buffer {
  const rights = metadata.copyright === undefined
    ? []
    : [
        `<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(metadata.copyright)}</rdf:li></rdf:Alt></dc:rights>`,
        `<xmpRights:UsageTerms><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(metadata.usageTerms!)}</rdf:li></rdf:Alt></xmpRights:UsageTerms>`,
        `<xmpRights:WebStatement rdf:resource="${xmlText(metadata.webStatement!)}"/>`,
      ];
  return Buffer.from([
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/" xmlns:plus="http://ns.useplus.org/ldf/xmp/1.0/">',
    `<photoshop:Credit>${xmlText(metadata.credit)}</photoshop:Credit>`,
    ...rights,
    `<plus:DataMining>${plusDataMining}</plus:DataMining>`,
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join("\n"), "utf8");
}

interface WebPChunk {
  fourCC: string;
  start: number;
  end: number;
  size: number;
}

function parseWebPChunks(bytes: Buffer): WebPChunk[] {
  if (
    bytes.byteLength < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) !== bytes.byteLength - 8
  ) {
    throw invalidProcessingInput();
  }

  const chunks: WebPChunk[] = [];
  for (let offset = 12; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw invalidProcessingInput();
    const size = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size & 1);
    if (end > bytes.byteLength || (size & 1) !== 0 && bytes[end - 1] !== 0) {
      throw invalidProcessingInput();
    }
    chunks.push({ fourCC: bytes.toString("ascii", offset, offset + 4), start: offset, end, size });
    offset = end;
  }
  if (chunks.length === 0) throw invalidProcessingInput();
  return chunks;
}

function simpleWebPDimensions(bytes: Buffer, chunks: WebPChunk[]): {
  width: number;
  height: number;
  alpha: boolean;
} {
  const imageChunks = chunks.filter(({ fourCC }) => fourCC === "VP8 " || fourCC === "VP8L");
  if (imageChunks.length !== 1) throw invalidProcessingInput();
  const chunk = imageChunks[0];
  if (!chunk) throw invalidProcessingInput();
  const offset = chunk.start + 8;
  let width: number;
  let height: number;
  let alpha = chunks.some(({ fourCC }) => fourCC === "ALPH");

  if (chunk.fourCC === "VP8 ") {
    if (
      chunk.size < 10 ||
      (bytes[offset]! & 1) !== 0 ||
      bytes[offset + 3] !== 0x9d || bytes[offset + 4] !== 0x01 || bytes[offset + 5] !== 0x2a
    ) {
      throw invalidProcessingInput();
    }
    width = bytes.readUInt16LE(offset + 6) & 0x3fff;
    height = bytes.readUInt16LE(offset + 8) & 0x3fff;
  } else {
    if (chunk.size < 5 || bytes[offset] !== 0x2f) throw invalidProcessingInput();
    const widthMinusOne = bytes[offset + 1]! | ((bytes[offset + 2]! & 0x3f) << 8);
    const heightMinusOne = (bytes[offset + 2]! >> 6) | (bytes[offset + 3]! << 2) |
      ((bytes[offset + 4]! & 0x0f) << 10);
    width = widthMinusOne + 1;
    height = heightMinusOne + 1;
    alpha ||= (bytes[offset + 4]! & 0x10) !== 0;
  }

  if (width <= 0 || height <= 0 || width > 0x1000000 || height > 0x1000000) {
    throw invalidProcessingInput();
  }
  return { width, height, alpha };
}

function makeWebPChunk(fourCC: string, payload: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + payload.byteLength + (payload.byteLength & 1));
  chunk.write(fourCC, 0, "ascii");
  chunk.writeUInt32LE(payload.byteLength, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function makeVp8xPayload(chunks: WebPChunk[], dimensions: {
  width: number;
  height: number;
  alpha: boolean;
}): Buffer {
  const payload = Buffer.alloc(10);
  let flags = 0x04;
  if (chunks.some(({ fourCC }) => fourCC === "ICCP")) flags |= 0x20;
  if (dimensions.alpha) flags |= 0x10;
  if (chunks.some(({ fourCC }) => fourCC === "EXIF")) flags |= 0x08;
  if (chunks.some(({ fourCC }) => fourCC === "ANIM" || fourCC === "ANMF")) flags |= 0x02;
  payload[0] = flags;
  const widthMinusOne = dimensions.width - 1;
  const heightMinusOne = dimensions.height - 1;
  payload[4] = widthMinusOne & 0xff;
  payload[5] = (widthMinusOne >> 8) & 0xff;
  payload[6] = (widthMinusOne >> 16) & 0xff;
  payload[7] = heightMinusOne & 0xff;
  payload[8] = (heightMinusOne >> 8) & 0xff;
  payload[9] = (heightMinusOne >> 16) & 0xff;
  return payload;
}

function webPWithXmp(bytes: Buffer, metadata: PublishUploadMetadata): {
  chunks: Buffer[];
  contentLength: number;
} {
  const chunks = parseWebPChunks(bytes);
  const vp8xChunks = chunks.filter(({ fourCC }) => fourCC === "VP8X");
  const xmpChunks = chunks.filter(({ fourCC }) => fourCC === "XMP ");
  if (vp8xChunks.length > 1 || xmpChunks.length > 1) throw invalidProcessingInput();

  let vp8x: Buffer | undefined;
  if (vp8xChunks.length === 1) {
    const chunk = vp8xChunks[0];
    if (!chunk) throw invalidProcessingInput();
    if (chunk !== chunks[0] || chunk.size !== 10) throw invalidProcessingInput();
    vp8x = Buffer.from(bytes.subarray(chunk.start, chunk.end));
    vp8x[8] = vp8x[8]! | 0x04;
  } else {
    const dimensions = simpleWebPDimensions(bytes, chunks);
    vp8x = makeWebPChunk("VP8X", makeVp8xPayload(chunks, dimensions));
  }
  if (!vp8x) throw invalidProcessingInput();

  const xmp = makeWebPChunk("XMP ", xmpPacket(metadata));
  const riffHeader = Buffer.from(bytes.subarray(0, 12));
  const output: Buffer[] = [riffHeader];
  if (vp8xChunks.length === 0) output.push(vp8x);
  for (const chunk of chunks) {
    if (chunk.fourCC === "VP8X") output.push(vp8x);
    else if (chunk.fourCC === "XMP ") output.push(xmp);
    else output.push(bytes.subarray(chunk.start, chunk.end));
  }
  if (xmpChunks.length === 0) output.push(xmp);

  const contentLength = output.reduce((sum, part) => sum + part.byteLength, 0);
  if (!Number.isSafeInteger(contentLength) || contentLength - 8 > 0xffffffff) {
    throw invalidProcessingInput();
  }
  riffHeader.writeUInt32LE(contentLength - 8, 4);
  return { chunks: output, contentLength };
}

function hopeTelemetryFailure(error: unknown, aborted: boolean): HopeFailure {
  if (aborted) return { type: "aborted", code: "activity_aborted" };
  if (error instanceof ApplicationFailure) {
    if (error.type === HOPE_PROCESSING_ERROR_TYPE) return { type: "processing", code: "hope_processing" };
    if (error.type === UPLOAD_EXPIRED_ERROR_TYPE) return { type: "expired", code: "upload_expired" };
    if (error.type === UPLOAD_SOURCE_ERROR_TYPE) return { type: "source", code: "upload_source" };
    if (error.type === UPLOAD_VALIDATION_ERROR_TYPE || error.type === UPLOAD_PROCESSING_INPUT_ERROR_TYPE) {
      return { type: "validation", code: "upload_validation" };
    }
  }
  if (error instanceof HttpError && error.status >= 400 && error.status < 600) {
    return { type: "validation", code: "upload_validation", status: error.status };
  }
  return { type: "unexpected", code: "activity_failed" };
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
  requestHopeResponse: HopeHttpRequest = requestHope,
  observability: HopeObservability = createHopeObservability(false),
) {
  return {
    async prepareHopeUpload(rawInput: HopeProcessingInput): Promise<void> {
      const input = parseHopeProcessingInput(rawInput);
      if (!input) throw invalidProcessingInput();
      const context = Context.current();
      const workflowExecution = context.info.workflowExecution;
      return observability.runAttempt(input, {
        workflowId: workflowExecution?.workflowId,
        runId: workflowExecution?.runId,
        activityId: context.info.activityId,
        attempt: context.info.attempt,
      }, async (telemetry) => {
        const sourceKey = uploadSourceKey(input.id);
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
          const source = await staging.head(sourceKey);
          const lastModified = source?.uploaded;
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

          const key = hopePreparedUploadKey(sourceKey, input.requestId);
          const existing = await staging.head(key);
          signal.throwIfAborted();
          if (existing) {
            if (isHopePreparedUpload(existing)) return;
            throw hopeProcessingFailure(true);
          }

          let sourceBytes: ArrayBuffer;
          try {
            sourceBytes = await staging.get(sourceKey, DEFAULT_MAX_BYTES);
          } catch (error) {
            if (error instanceof RangeError) {
              throw new HttpError(413, "size_limit_exceeded", "image exceeds maxBytes");
            }
            throw error;
          }
          signal.throwIfAborted();
          if (sourceBytes.byteLength > DEFAULT_MAX_BYTES) {
            throw new HttpError(413, "size_limit_exceeded", "image exceeds maxBytes");
          }

          const sourceInfo = validateImageUpload(
            sourceBytes,
            source?.httpMetadata?.contentType ?? "",
            {
              maxBytes: DEFAULT_MAX_BYTES,
              maxDimension: DEFAULT_MAX_DIMENSION,
            },
          );
          const sourceMetadata = await decodeImage(Buffer.from(sourceBytes), sourceInfo.format);
          if (sourceMetadata.width !== sourceInfo.width || sourceMetadata.height !== sourceInfo.height) {
            throw new HttpError(422, "invalid_image", "image processing failed");
          }
          telemetry.setImageMetadata(sourceBytes.byteLength, sourceInfo.width, sourceInfo.height);
          signal.throwIfAborted();

          const url = new URL("/protect", apiUrl);
          url.search = new URLSearchParams({
            algorithm: input.hope.algorithm,
            iterations: String(input.hope.iterations),
            intensity: String(input.hope.intensity),
            max_edge: String(HOPE_MAX_EDGE),
            quality: "80",
          }).toString();

          const progressPoller = telemetry.startProgressPolling(apiUrl, input.requestId, input.hope.iterations);
          let output: Buffer;
          try {
            let response: HopeHttpResponse;
            try {
              response = await requestHopeResponse(url, {
                method: "POST",
                headers: {
                  "content-type": "application/octet-stream",
                  "X-Hope-Request-Id": input.requestId,
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
              telemetry.recordFailure({
                type: "processing",
                code: "hope_processing",
                ...(response.status >= 400 && response.status <= 599 ? { status: response.status } : {}),
              });
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

            output = await readHopeResponse(response, signal);
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
          } catch (error) {
            await progressPoller?.fail();
            throw error;
          } finally {
            await progressPoller?.stop();
          }

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
          if (signal.aborted) {
            telemetry.recordFailure(hopeTelemetryFailure(error, true));
            signal.throwIfAborted();
          }
          const normalized = asNonRetryableValidationFailure(error) ?? error;
          telemetry.recordFailure(hopeTelemetryFailure(error, false));
          throw normalized;
        } finally {
          clearInterval(timer);
        }
      });
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
    const sourceKey = uploadSourceKey(input.id);
    const stagingKey = input.hopeRequestId
      ? hopePreparedUploadKey(sourceKey, input.hopeRequestId)
      : preparedUploadKey(sourceKey);
    const result: ProcessUploadResult = {
      id: input.id,
      url: `${publicBaseUrl}/${outputKey}`,
      mediaType: "image/webp",
    };
    const existing = await media.head(outputKey);
    if (existing) {
      if (input.metadata) {
        if (existing.customMetadata?.[publicationMetadataMarker] !== metadataSha256(input.metadata)) {
          throw metadataPublicationConflict();
        }
        return { ...result, metadata: input.metadata };
      }
      return result;
    }

    if (input.metadata) {
      const metadataHash = metadataSha256(input.metadata);
      const prepared = await staging.getStream(stagingKey, "image/webp");
      if (!prepared) throw new Error("prepared upload object is missing");
      let preparedBytes: Buffer;
      try {
        preparedBytes = Buffer.allocUnsafe(prepared.contentLength);
        let offset = 0;
        for await (const chunk of prepared.body) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (offset + bytes.byteLength > prepared.contentLength) throw invalidProcessingInput();
          bytes.copy(preparedBytes, offset);
          offset += bytes.byteLength;
        }
        if (offset !== prepared.contentLength) throw invalidProcessingInput();
      } finally {
        prepared.body.destroy();
      }

      const muxed = webPWithXmp(preparedBytes, input.metadata);
      const output = Readable.from(muxed.chunks);
      try {
        const stored = await media.putStream(
          outputKey,
          output,
          muxed.contentLength,
          {
            onlyIf: new Headers({ "If-None-Match": "*" }),
            httpMetadata: {
              contentType: "image/webp",
              cacheControl: IMMUTABLE_CACHE_CONTROL,
            },
            customMetadata: { [publicationMetadataMarker]: metadataHash },
          },
        );
        if (!stored) {
          const winner = await media.head(outputKey);
          if (winner?.customMetadata?.[publicationMetadataMarker] !== metadataHash) {
            throw metadataPublicationConflict();
          }
        }
        return { ...result, metadata: input.metadata };
      } finally {
        output.destroy();
      }
    }

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

      const lastModified = await staging.headLastModified(uploadSourceKey(input.id));
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
      const sourceKey = uploadSourceKey(input.id);
      for (const requestId of input.hopeRequestIds ?? []) {
        await staging.delete(hopePreparedUploadKey(sourceKey, requestId));
      }
      await staging.delete(preparedUploadKey(sourceKey));
      await staging.delete(sourceKey);
    },
  };
}
