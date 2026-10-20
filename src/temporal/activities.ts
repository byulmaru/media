import { ApplicationFailure } from "@temporalio/activity";

import { IMMUTABLE_CACHE_CONTROL } from "../constants";
import { HttpError } from "../errors";
import { assertImageWithinLimits, inspectImage } from "../image-info";
import { transcodeOriginal } from "../codec";
import { initializeNodeCodec } from "../codec.node";
import type { MediaStorage } from "../storage";
import type { UploadStagingStorage } from "../storage/staging";
import type { ProcessUploadInput, UploadSourceCleanupInput } from "./types";
import {
  UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
  UPLOAD_VALIDATION_CODES,
  UPLOAD_VALIDATION_ERROR_TYPE,
} from "./types";
import { parseProcessUploadInput, parseUploadSourceCleanupInput } from "./validation";

const acceptedContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const validationCodes: ReadonlySet<string> = new Set(UPLOAD_VALIDATION_CODES);

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

export async function initializeUploadProcessingCodec(): Promise<void> {
  await initializeNodeCodec();
}

function invalidProcessingInput(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "upload processing input is invalid",
    type: UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
    nonRetryable: true,
    details: [{ code: "invalid_processing_input" }],
  });
}

export function createUploadProcessingActivities(
  staging: UploadStagingStorage,
  media: MediaStorage,
) {
  return {
    async processUploadImage(rawInput: ProcessUploadInput): Promise<void> {
      const input = parseProcessUploadInput(rawInput);
      if (!input) throw invalidProcessingInput();

      const outputKey = `original/${input.id}.webp`;
      if (await media.head(outputKey)) return;

      try {
        if (!acceptedContentTypes.has(input.contentType)) {
          throw new HttpError(415, "unsupported_image", "Content-Type must be JPEG, PNG, or WebP");
        }

        let bytes: ArrayBuffer;
        try {
          bytes = await staging.get(input.sourceKey, input.maxBytes);
        } catch (error) {
          if (error instanceof RangeError) {
            throw new HttpError(413, "size_limit_exceeded", "image exceeds maxBytes");
          }
          throw error;
        }
        if (bytes.byteLength > input.maxBytes) {
          throw new HttpError(413, "size_limit_exceeded", "image exceeds maxBytes");
        }

        const info = inspectImage(bytes);
        const expectedContentType = info.format === "jpeg" ? "image/jpeg" : `image/${info.format}`;
        if (input.contentType !== expectedContentType) {
          throw new HttpError(415, "content_type_mismatch", "Content-Type does not match image bytes");
        }
        assertImageWithinLimits(info.width, info.height, {
          maxBytes: input.maxBytes,
          maxDimension: input.maxDimension,
        });

        const transformStarted = Date.now();
        const output = await transcodeOriginal(bytes, info.format);
        console.log(JSON.stringify({
          event: "image_transform",
          sourceKind: "upload",
          sourceFormat: info.format,
          inputBytes: bytes.byteLength,
          outputBytes: output.bytes.byteLength,
          width: output.width,
          height: output.height,
          durationMs: Date.now() - transformStarted,
        }));

        const stored = await media.put(outputKey, output.bytes, {
          onlyIf: new Headers({ "If-None-Match": "*" }),
          httpMetadata: {
            contentType: "image/webp",
            cacheControl: IMMUTABLE_CACHE_CONTROL,
          },
        });
        if (!stored && !(await media.head(outputKey))) {
          throw new Error("conditional media write could not be confirmed");
        }
      } catch (error) {
        throw asNonRetryableValidationFailure(error) ?? error;
      }
    },

    async deleteUploadSource(rawInput: UploadSourceCleanupInput): Promise<void> {
      const input = parseUploadSourceCleanupInput(rawInput);
      if (!input) throw invalidProcessingInput();
      await staging.delete(input.sourceKey);
    },
  };
}
