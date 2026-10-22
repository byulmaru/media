import { ApplicationFailure, Context, heartbeat } from "@temporalio/activity";
import { Readable } from "node:stream";

import { DEFAULT_MAX_BYTES } from "../constants";
import { HttpError } from "../errors";
import { validateImageUpload } from "../image-info";
import { hopePreparedUploadKey, isPreparedUpload } from "../prepared-upload";
import type { UploadStagingStorage } from "../storage/staging";
import type { HopeApiConfig } from "./hope-config";
import type { HopeProcessingInput } from "./types";
import {
  HOPE_MAX_EDGE,
  UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
  UPLOAD_VALIDATION_CODES,
  UPLOAD_VALIDATION_ERROR_TYPE,
} from "./types";
import { encodeHopeInput, validateHopeWebp } from "./codec";
import { parseHopeProcessingInput } from "./validation";

const validationCodes: ReadonlySet<string> = new Set(UPLOAD_VALIDATION_CODES);
const HEARTBEAT_INTERVAL_MS = 5_000;

function invalidProcessingInput(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "Hope processing input is invalid",
    type: UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
    nonRetryable: true,
  });
}

function inputValidationFailure(error: unknown): ApplicationFailure | undefined {
  if (error instanceof RangeError) {
    return ApplicationFailure.create({
      message: "Hope source image is invalid",
      type: UPLOAD_VALIDATION_ERROR_TYPE,
      nonRetryable: true,
      details: [{ status: 413 }],
    });
  }
  if (
    !(error instanceof HttpError) ||
    error.status < 400 ||
    error.status >= 500 ||
    !validationCodes.has(error.code)
  ) {
    return undefined;
  }
  return ApplicationFailure.create({
    message: "Hope source image is invalid",
    type: UPLOAD_VALIDATION_ERROR_TYPE,
    nonRetryable: true,
    details: [{ status: error.status }],
  });
}

function hopeHttpFailure(status: number): ApplicationFailure {
  return ApplicationFailure.create({
    message: "Hope service request failed",
    type: "HopeHttpError",
    nonRetryable: status >= 400 && status < 500 && status !== 408,
    details: [{ status }],
  });
}

function hopeNetworkFailure(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "Hope service request failed",
    type: "HopeNetworkError",
  });
}

function invalidHopeOutput(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "Hope service returned an invalid image",
    type: "HopeOutputError",
    nonRetryable: true,
  });
}

async function readBoundedWebp(response: Response): Promise<Buffer> {
  const maxBytes = DEFAULT_MAX_BYTES;
  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "image/webp" || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw invalidHopeOutput();
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw invalidHopeOutput();
    }
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw invalidHopeOutput();
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export function createHopeProcessingActivities(
  staging: Pick<UploadStagingStorage, "head" | "get" | "putStream">,
  config: HopeApiConfig,
) {
  return {
    async prepareHopeUpload(rawInput: HopeProcessingInput): Promise<void> {
      const input = parseHopeProcessingInput(rawInput);
      if (!input) throw invalidProcessingInput();

      const { cancellationSignal } = Context.current();
      const heartbeatTimer = setInterval(() => {
        if (!cancellationSignal.aborted) heartbeat();
      }, HEARTBEAT_INTERVAL_MS);

      try {
        cancellationSignal.throwIfAborted();
        const outputKey = hopePreparedUploadKey(input.sourceKey, input.requestId);
        const existing = await staging.head(outputKey);
        if (existing) {
          if (!isPreparedUpload(existing)) throw invalidHopeOutput();
          cancellationSignal.throwIfAborted();
          return;
        }

        let source: ArrayBuffer;
        try {
          source = await staging.get(input.sourceKey, input.maxBytes);
          cancellationSignal.throwIfAborted();
          if (source.byteLength > input.maxBytes) {
            throw new RangeError("source image exceeds maxBytes");
          }
          validateImageUpload(source, input.contentType, input);
        } catch (error) {
          throw inputValidationFailure(error) ?? error;
        }

        let png: Awaited<ReturnType<typeof encodeHopeInput>>;
        try {
          png = await encodeHopeInput(source);
        } catch (error) {
          throw inputValidationFailure(error) ?? error;
        }

        let response: Response;
        try {
          cancellationSignal.throwIfAborted();
          const url = new URL("/protect", config.HOPE_BASE_URL);
          url.search = new URLSearchParams({
            algorithm: input.hope.algorithm,
            iterations: String(input.hope.iterations),
            intensity: String(input.hope.intensity),
            max_edge: String(HOPE_MAX_EDGE),
            quality: "80",
          }).toString();
          response = await fetch(url, {
            method: "POST",
            headers: {
              accept: "image/webp",
              authorization: "Bearer " + config.HOPE_API_TOKEN,
              "content-length": String(png.size),
              "content-type": "image/png",
            },
            body: Readable.toWeb(png.stream),
            signal: cancellationSignal,
            redirect: "error",
            duplex: "half",
          } as RequestInit & { duplex: "half" });
        } catch (error) {
          if (cancellationSignal.aborted) throw error;
          throw hopeNetworkFailure();
        } finally {
          png.stream.destroy();
        }

        cancellationSignal.throwIfAborted();
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw hopeHttpFailure(response.status);
        }

        let protectedImage: Buffer;
        try {
          protectedImage = await readBoundedWebp(response);
        } catch (error) {
          if (cancellationSignal.aborted) throw error;
          if (error instanceof ApplicationFailure) throw error;
          throw hopeNetworkFailure();
        }

        try {
          await validateHopeWebp(protectedImage);
        } catch {
          if (cancellationSignal.aborted) throw cancellationSignal.reason;
          throw invalidHopeOutput();
        }
        cancellationSignal.throwIfAborted();

        const body = Readable.from([protectedImage]);
        try {
          cancellationSignal.throwIfAborted();
          await staging.putStream(
            outputKey,
            body,
            protectedImage.byteLength,
            {
              onlyIf: new Headers({ "If-None-Match": "*" }),
              httpMetadata: { contentType: "image/webp" },
            },
          );
          cancellationSignal.throwIfAborted();
          if (!isPreparedUpload(await staging.head(outputKey))) throw invalidHopeOutput();
          cancellationSignal.throwIfAborted();
          return;
        } finally {
          body.destroy();
        }
      } finally {
        clearInterval(heartbeatTimer);
      }
    },
  };
}
