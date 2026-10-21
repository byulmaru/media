// Frozen from c625323 to verify markerless histories replay through the legacy workflow branch.
import {
  ApplicationFailure,
  CancellationScope,
  condition,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";
import type * as activities from "../../src/temporal/activities";
import type { ProcessUploadInput, ProcessUploadResult } from "../../src/temporal/types";
import {
  PUBLISH_UPLOAD_SIGNAL_NAME,
  UPLOAD_EXPIRED_ERROR_TYPE,
  UPLOAD_EXPIRATION_MS,
  UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
  UPLOAD_SOURCE_ERROR_TYPE,
  UPLOAD_VALIDATION_ERROR_TYPE,
} from "../../src/temporal/types";
import { parseProcessUploadInput } from "../../src/temporal/validation";

const publishUploadSignal = defineSignal(PUBLISH_UPLOAD_SIGNAL_NAME);

const { getUploadSourceLastModified } = proxyActivities<Pick<
  ReturnType<typeof activities.createUploadProcessingActivities>,
  "getUploadSourceLastModified"
>>({
  startToCloseTimeout: "30 seconds",
  scheduleToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    nonRetryableErrorTypes: [UPLOAD_PROCESSING_INPUT_ERROR_TYPE, UPLOAD_SOURCE_ERROR_TYPE],
  },
});

const { processUploadImage } = proxyActivities<Pick<
  ReturnType<typeof activities.createUploadProcessingActivities>,
  "processUploadImage"
>>({
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    nonRetryableErrorTypes: [UPLOAD_VALIDATION_ERROR_TYPE, UPLOAD_PROCESSING_INPUT_ERROR_TYPE],
  },
});

const { deleteUploadSource } = proxyActivities<Pick<
  ReturnType<typeof activities.createUploadProcessingActivities>,
  "deleteUploadSource"
>>({
  startToCloseTimeout: "30 seconds",
  scheduleToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    nonRetryableErrorTypes: [UPLOAD_PROCESSING_INPUT_ERROR_TYPE],
  },
});

function uploadSourceError(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "upload source metadata is invalid",
    type: UPLOAD_SOURCE_ERROR_TYPE,
    nonRetryable: true,
  });
}

function uploadExpiredError(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "upload expired before publication",
    type: UPLOAD_EXPIRED_ERROR_TYPE,
    nonRetryable: true,
  });
}

export async function processUploadWorkflow(input: ProcessUploadInput): Promise<ProcessUploadResult> {
  const validatedInput = parseProcessUploadInput(input);
  if (!validatedInput) {
    throw ApplicationFailure.create({
      message: "upload processing input is invalid",
      type: UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
      nonRetryable: true,
    });
  }

  let published = false;
  try {
    setHandler(publishUploadSignal, () => {
      published = true;
    });

    const uploadedAt = await getUploadSourceLastModified(validatedInput);
    if (!Number.isFinite(uploadedAt) || uploadedAt <= 0 || uploadedAt > Date.now()) {
      throw uploadSourceError();
    }

    const deadline = uploadedAt + UPLOAD_EXPIRATION_MS;
    if (!Number.isFinite(deadline)) throw uploadSourceError();
    if (Date.now() >= deadline) throw uploadExpiredError();
    if (!published) {
      if (!(await condition(() => published, Math.max(0, deadline - Date.now())))) {
        throw uploadExpiredError();
      }
      if (Date.now() >= deadline) throw uploadExpiredError();
    }

    return await processUploadImage(validatedInput);
  } finally {
    try {
      await CancellationScope.nonCancellable(() => deleteUploadSource({
        id: validatedInput.id,
        sourceKey: validatedInput.sourceKey,
      }));
    } catch {
      log.warn("Upload source cleanup failed", {
        event: "upload_source_cleanup_failed",
        uploadId: validatedInput.id,
      });
    }
  }
}
