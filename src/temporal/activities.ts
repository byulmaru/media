import { ApplicationFailure } from "@temporalio/activity";

import { IMMUTABLE_CACHE_CONTROL } from "../constants";
import { HttpError } from "../errors";
import { ensurePreparedUpload } from "../prepare-upload.node";
import { hopePreparedUploadKey, preparedUploadKey } from "../prepared-upload";
import type { R2S3MediaStorage } from "../storage/r2-s3";
import type { UploadStagingStorage } from "../storage/staging";
import type {
  ProcessUploadInput,
  ProcessUploadResult,
  PublishPreparedUploadInput,
  UploadSourceCleanupInput,
} from "./types";
import {
  UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
  UPLOAD_SOURCE_ERROR_TYPE,
  UPLOAD_VALIDATION_CODES,
  UPLOAD_VALIDATION_ERROR_TYPE,
} from "./types";
import {
  parseProcessUploadInput,
  parsePublishPreparedUploadInput,
  parseUploadSourceCleanupInput,
} from "./validation";

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
