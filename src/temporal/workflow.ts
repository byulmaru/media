import { CancellationScope, proxyActivities } from "@temporalio/workflow";
import type * as activities from "./activities";
import type { ProcessUploadInput } from "./types";
import {
  UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
  UPLOAD_VALIDATION_ERROR_TYPE,
} from "./types";

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

export async function processUploadWorkflow(input: ProcessUploadInput): Promise<void> {
  try {
    await processUploadImage(input);
  } finally {
    await CancellationScope.nonCancellable(() => deleteUploadSource({
      id: input.id,
      sourceKey: input.sourceKey,
    }));
  }
}
