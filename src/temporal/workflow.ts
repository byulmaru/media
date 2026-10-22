import {
  ActivityCancellationType,
  ApplicationFailure,
  CancellationScope,
  Trigger,
  allHandlersFinished,
  condition,
  defineSignal,
  getExternalWorkflowHandle,
  log,
  patched,
  proxyActivities,
  setHandler,
  uuid4,
  workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type * as hopeActivities from "./hope-activities";
import type {
  ProcessUploadInput,
  ProcessUploadResult,
  SetHopeInput,
  SetHopeRequestSignal,
  SetHopeResult,
  SetHopeWorkflowFailure,
  SetHopeWorkflowReply,
} from "./types";
import {
  HOPE_PROCESSING_ERROR_TYPE,
  HOPE_TASK_QUEUE,
  PUBLISH_UPLOAD_SIGNAL_NAME,
  SET_HOPE_REPLY_ERROR_TYPES,
  SET_HOPE_REQUEST_SIGNAL_NAME,
  SET_HOPE_RESULT_SIGNAL_NAME,
  UPLOAD_EXPIRED_ERROR_TYPE,
  UPLOAD_EXPIRATION_MS,
  UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
  UPLOAD_SOURCE_ERROR_TYPE,
  UPLOAD_VALIDATION_ERROR_TYPE,
} from "./types";
import {
  parseProcessUploadInput,
  parseSetHopeInput,
  parseSetHopeRequestEnvelope,
  parseSetHopeRequestSignal,
  parseSetHopeWorkflowReply,
} from "./validation";

const publishUploadSignal = defineSignal(PUBLISH_UPLOAD_SIGNAL_NAME);
const setHopeRequestSignal = defineSignal<[unknown]>(SET_HOPE_REQUEST_SIGNAL_NAME);
const setHopeResultSignal = defineSignal<[unknown]>(SET_HOPE_RESULT_SIGNAL_NAME);

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

const { processUploadImage, prepareUploadImage } = proxyActivities<Pick<
  ReturnType<typeof activities.createUploadProcessingActivities>,
  "processUploadImage" | "prepareUploadImage"
>>({
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    nonRetryableErrorTypes: [UPLOAD_VALIDATION_ERROR_TYPE, UPLOAD_PROCESSING_INPUT_ERROR_TYPE],
  },
});

const { publishPreparedUpload } = proxyActivities<Pick<
  ReturnType<typeof activities.createUploadProcessingActivities>,
  "publishPreparedUpload"
>>({
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "30 seconds",
    nonRetryableErrorTypes: [UPLOAD_PROCESSING_INPUT_ERROR_TYPE],
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

function hopeUpdateError(message: string): ApplicationFailure {
  return ApplicationFailure.create({
    message,
    type: HOPE_PROCESSING_ERROR_TYPE,
    nonRetryable: true,
  });
}

function safeSetHopeFailure(error: unknown): SetHopeWorkflowFailure {
  let cause = error;
  while (cause instanceof Error && !(cause instanceof ApplicationFailure)) {
    cause = "cause" in cause ? cause.cause : undefined;
  }
  const originalType = cause instanceof ApplicationFailure ? cause.type : "";
  const type = typeof originalType === "string" &&
    (SET_HOPE_REPLY_ERROR_TYPES as readonly string[]).includes(originalType)
    ? originalType as SetHopeWorkflowFailure["type"]
    : HOPE_PROCESSING_ERROR_TYPE;
  const originalMessage = cause instanceof Error ? cause.message : "";

  if (type === HOPE_PROCESSING_ERROR_TYPE) {
    const knownMessages = [
      "A Hope update is already in progress",
      "Upload publication has started",
      "Hope updates are not supported for this upload",
    ];
    return {
      type,
      message: knownMessages.includes(originalMessage) ? originalMessage : "Hope processing failed",
    };
  }
  if (type === UPLOAD_EXPIRED_ERROR_TYPE) {
    return { type, message: "upload expired before publication" };
  }
  if (type === UPLOAD_PROCESSING_INPUT_ERROR_TYPE) {
    return { type, message: "Hope processing input is invalid" };
  }
  if (type === UPLOAD_SOURCE_ERROR_TYPE) {
    return { type, message: "upload source metadata is invalid" };
  }
  if (type === UPLOAD_VALIDATION_ERROR_TYPE) {
    return { type, message: "Hope source image is invalid" };
  }
  if (type === "HopeOutputError") {
    return { type, message: "Hope service returned an invalid image" };
  }
  if (type === "HopeNetworkError") {
    return { type, message: "Hope service request failed" };
  }
  return { type, message: "Hope service request failed" };
}

type HopeCommand = SetHopeRequestSignal;

async function sendSetHopeReply(
  uploadId: string,
  replyWorkflowId: string,
  reply: SetHopeWorkflowReply,
): Promise<void> {
  await CancellationScope.nonCancellable(async () => {
    try {
      await getExternalWorkflowHandle(replyWorkflowId).signal(setHopeResultSignal, reply);
    } catch {
      log.warn("Hope result delivery failed", {
        event: "hope_result_delivery_failed",
        uploadId,
      });
    }
  });
}

async function setHopeWorkflow(input: SetHopeInput): Promise<SetHopeResult> {
  const normalized = parseSetHopeInput(input);
  if (!normalized) {
    throw ApplicationFailure.create({
      message: "Hope options are invalid",
      type: UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
      nonRetryable: true,
    });
  }

  const requestId = uuid4();
  const result = new Trigger<SetHopeWorkflowReply>();
  setHandler(setHopeResultSignal, (rawReply) => {
    const reply = parseSetHopeWorkflowReply(normalized.id, requestId, rawReply);
    if (reply) result.resolve(reply);
  });

  const replyWorkflowId = workflowInfo().workflowId;
  await getExternalWorkflowHandle(`media-upload:${normalized.id}`).signal(setHopeRequestSignal, {
    requestId,
    replyWorkflowId,
    hope: normalized.hope,
  } satisfies SetHopeRequestSignal);

  const reply = await result;
  if ("error" in reply) {
    throw ApplicationFailure.create({
      message: reply.error.message,
      type: reply.error.type,
      nonRetryable: true,
    });
  }
  return reply.result;
}

export { setHopeWorkflow };

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
  let hopeFailed = false;
  let hopeCommandBusy = false;
  let hopeRequestsEnabled: boolean | undefined;
  let workflowEnding = false;
  let deadline: number | undefined;
  let pendingHopeCommand: HopeCommand | undefined;
  let selectedHopeRequestId: string | undefined;
  const hopeRequestIds: string[] = [];
  let workflowFailure: unknown;

  try {
    setHandler(publishUploadSignal, () => {
      if (!hopeFailed || hopeCommandBusy) published = true;
    });

    // Register before the first activity so an immediate Hope request can be buffered.
    setHandler(setHopeRequestSignal, async (rawRequest) => {
      const envelope = parseSetHopeRequestEnvelope(validatedInput.id, rawRequest);
      if (!envelope) {
        log.warn("Invalid Hope request was dropped", {
          event: "hope_request_dropped",
          uploadId: validatedInput.id,
        });
        return;
      }

      const command = parseSetHopeRequestSignal(validatedInput.id, rawRequest);
      const reject = async (error: unknown) => {
        await sendSetHopeReply(validatedInput.id, envelope.replyWorkflowId, {
          requestId: envelope.requestId,
          error: safeSetHopeFailure(error),
        });
      };
      if (!command) {
        await reject(ApplicationFailure.create({
          message: "Hope options are invalid",
          type: UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
          nonRetryable: true,
        }));
        return;
      }
      if (workflowEnding) {
        await reject(hopeUpdateError("Upload workflow ended"));
        return;
      }
      if (hopeRequestsEnabled === false) {
        await reject(hopeUpdateError("Hope updates are not supported for this upload"));
        return;
      }
      if (hopeCommandBusy) {
        await reject(hopeUpdateError("A Hope update is already in progress"));
        return;
      }
      if (published) {
        await reject(hopeUpdateError("Upload publication has started"));
        return;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        await reject(uploadExpiredError());
        return;
      }

      hopeCommandBusy = true;
      if (command.hope !== null) hopeRequestIds.push(command.requestId);
      pendingHopeCommand = command;
    });

    const uploadedAt = await getUploadSourceLastModified(validatedInput);
    if (!Number.isFinite(uploadedAt) || uploadedAt <= 0 || uploadedAt > Date.now()) {
      throw uploadSourceError();
    }

    deadline = uploadedAt + UPLOAD_EXPIRATION_MS;
    if (!Number.isFinite(deadline)) throw uploadSourceError();
    if (Date.now() >= deadline) throw uploadExpiredError();

    const usePreparedPublication = patched("prepare-private-webp-before-publish");
    const useHopeRequests = usePreparedPublication && patched("optional-hope-upload-v1");
    hopeRequestsEnabled = useHopeRequests;

    if (!useHopeRequests && pendingHopeCommand) {
      const command = pendingHopeCommand;
      pendingHopeCommand = undefined;
      hopeCommandBusy = false;
      await sendSetHopeReply(validatedInput.id, command.replyWorkflowId, {
        requestId: command.requestId,
        error: safeSetHopeFailure(hopeUpdateError("Hope updates are not supported for this upload")),
      });
      await CancellationScope.nonCancellable(() => condition(allHandlersFinished));
    }

    if (usePreparedPublication) {
      await prepareUploadImage(validatedInput);
      if (Date.now() >= deadline) throw uploadExpiredError();
    }

    if (useHopeRequests) {
      while (true) {
        if (pendingHopeCommand) {
          const command = pendingHopeCommand;
          pendingHopeCommand = undefined;
          try {
            if (Date.now() >= deadline) throw uploadExpiredError();

            if (command.hope !== null) {
              const remaining = deadline - Date.now();
              if (remaining <= 0) throw uploadExpiredError();
              const cleanupGraceMs = 5 * 60 * 1000;
              const startToCloseMs = Math.min(30 * 60 * 1000, remaining + cleanupGraceMs);
              const { prepareHopeUpload } = proxyActivities<Pick<
                ReturnType<typeof hopeActivities.createHopeProcessingActivities>,
                "prepareHopeUpload"
              >>({
                taskQueue: HOPE_TASK_QUEUE,
                startToCloseTimeout: startToCloseMs,
                scheduleToCloseTimeout: remaining + cleanupGraceMs,
                heartbeatTimeout: Math.min(30_000, startToCloseMs),
                cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
                retry: {
                  initialInterval: "1 second",
                  maximumInterval: "30 seconds",
                  nonRetryableErrorTypes: [
                    UPLOAD_VALIDATION_ERROR_TYPE,
                    UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
                  ],
                },
              });
              await CancellationScope.withTimeout(remaining, () =>
                prepareHopeUpload({
                  ...validatedInput,
                  requestId: command.requestId,
                  hope: command.hope!,
                }),
              );
              if (Date.now() >= deadline) throw uploadExpiredError();
              selectedHopeRequestId = command.requestId;
            } else {
              if (Date.now() >= deadline) throw uploadExpiredError();
              selectedHopeRequestId = undefined;
            }

            hopeFailed = false;
            await sendSetHopeReply(validatedInput.id, command.replyWorkflowId, {
              requestId: command.requestId,
              result: { id: validatedInput.id, hope: command.hope },
            });
            hopeCommandBusy = false;
          } catch (error) {
            // A failed attempt never publishes the last successful Hope artifact by accident.
            hopeFailed = true;
            published = false;
            await sendSetHopeReply(validatedInput.id, command.replyWorkflowId, {
              requestId: command.requestId,
              error: safeSetHopeFailure(error),
            });
            hopeCommandBusy = false;
          }
          continue;
        }

        if (published && !hopeFailed) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw uploadExpiredError();
        if (!(await condition(
          () => pendingHopeCommand !== undefined || (published && !hopeFailed),
          remaining,
        ))) {
          throw uploadExpiredError();
        }
      }

      await CancellationScope.nonCancellable(() => condition(allHandlersFinished));
      if (Date.now() >= deadline) throw uploadExpiredError();
      return await publishPreparedUpload({
        ...validatedInput,
        ...(selectedHopeRequestId ? { hopeRequestId: selectedHopeRequestId } : {}),
      });
    }

    if (!published) {
      if (!(await condition(() => published, Math.max(0, deadline - Date.now())))) {
        throw uploadExpiredError();
      }
      if (Date.now() >= deadline) throw uploadExpiredError();
    }

    return usePreparedPublication
      ? await publishPreparedUpload(validatedInput)
      : await processUploadImage(validatedInput);
  } catch (error) {
    workflowFailure = error;
    throw error;
  } finally {
    try {
      workflowEnding = true;
      if (pendingHopeCommand) {
        const command = pendingHopeCommand;
        pendingHopeCommand = undefined;
        hopeCommandBusy = false;
        await sendSetHopeReply(validatedInput.id, command.replyWorkflowId, {
          requestId: command.requestId,
          error: safeSetHopeFailure(workflowFailure ?? hopeUpdateError("Upload workflow ended")),
        });
      }
      await CancellationScope.nonCancellable(async () => {
        await condition(allHandlersFinished);
        await deleteUploadSource({
          id: validatedInput.id,
          sourceKey: validatedInput.sourceKey,
          ...(hopeRequestIds.length > 0 ? { hopeRequestIds } : {}),
        });
      });
    } catch {
      log.warn("Upload source cleanup failed", {
        event: "upload_source_cleanup_failed",
        uploadId: validatedInput.id,
      });
    }
  }
}
