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
import type {
  ProcessUploadInput,
  ProcessUploadResult,
  ApplyHopeInput,
  ApplyHopeRequestSignal,
  ApplyHopeResult,
  ApplyHopeWorkflowFailure,
  ApplyHopeWorkflowReply,
  PublishUploadV2RequestSignal,
  PublishUploadV2Result,
  PublishUploadV2WorkflowInput,
  PublishUploadV2WorkflowFailure,
  PublishUploadV2WorkflowReply,
  HopeProcessingActivities,
  NormalizedHopeOptions,
} from "./types";
import {
  HOPE_MAX_EDGE,
  HOPE_PROCESSING_ERROR_TYPE,
  HOPE_TASK_QUEUE,
  PUBLISH_UPLOAD_SIGNAL_NAME,
  PUBLISH_UPLOAD_V2_REQUEST_SIGNAL_NAME,
  PUBLISH_UPLOAD_V2_RESULT_SIGNAL_NAME,
  APPLY_HOPE_REPLY_ERROR_TYPES,
  APPLY_HOPE_REQUEST_SIGNAL_NAME,
  APPLY_HOPE_RESULT_SIGNAL_NAME,
  UPLOAD_EXPIRED_ERROR_TYPE,
  UPLOAD_EXPIRATION_MS,
  UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
  UPLOAD_SOURCE_ERROR_TYPE,
  UPLOAD_VALIDATION_ERROR_TYPE,
  UPLOAD_PUBLICATION_SELECTION_CONFLICT_ERROR_TYPE,
} from "./types";
import {
  parseProcessUploadInput,
  parseApplyHopeInput,
  parseApplyHopeRequestEnvelope,
  parseApplyHopeRequestSignal,
  parseApplyHopeWorkflowReply,
  parsePublishUploadV2Input,
  parsePublishUploadV2WorkflowInput,
  parsePublishUploadV2RequestEnvelope,
  parsePublishUploadV2RequestSignal,
  parsePublishUploadV2WorkflowReply,
} from "./validation";

const publishUploadSignal = defineSignal(PUBLISH_UPLOAD_SIGNAL_NAME);
const publishUploadV2RequestSignal = defineSignal<[unknown]>(PUBLISH_UPLOAD_V2_REQUEST_SIGNAL_NAME);
const publishUploadV2ResultSignal = defineSignal<[unknown]>(PUBLISH_UPLOAD_V2_RESULT_SIGNAL_NAME);
const applyHopeRequestSignal = defineSignal<[unknown]>(APPLY_HOPE_REQUEST_SIGNAL_NAME);
const applyHopeResultSignal = defineSignal<[unknown]>(APPLY_HOPE_RESULT_SIGNAL_NAME);

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

function publicationSelectionConflictError(): ApplicationFailure {
  return ApplicationFailure.create({
    message: "Upload publication choice conflicts with the accepted choice",
    type: UPLOAD_PUBLICATION_SELECTION_CONFLICT_ERROR_TYPE,
    nonRetryable: true,
  });
}

function safeApplyHopeFailure(error: unknown): ApplyHopeWorkflowFailure {
  let cause = error;
  while (cause instanceof Error && !(cause instanceof ApplicationFailure)) {
    cause = "cause" in cause ? cause.cause : undefined;
  }
  const originalType = cause instanceof ApplicationFailure ? cause.type : "";
  const type = typeof originalType === "string" &&
    (APPLY_HOPE_REPLY_ERROR_TYPES as readonly string[]).includes(originalType)
    ? originalType as ApplyHopeWorkflowFailure["type"]
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
  return { type, message: "Hope processing failed" };
}

function safePublishUploadV2Failure(error: unknown): PublishUploadV2WorkflowFailure {
  let cause = error;
  while (cause instanceof Error && !(cause instanceof ApplicationFailure)) {
    cause = "cause" in cause ? cause.cause : undefined;
  }
  if (
    cause instanceof ApplicationFailure &&
    cause.type === UPLOAD_PUBLICATION_SELECTION_CONFLICT_ERROR_TYPE
  ) {
    return {
      type: UPLOAD_PUBLICATION_SELECTION_CONFLICT_ERROR_TYPE,
      message: "Upload publication choice conflicts with the accepted choice",
    };
  }
  return safeApplyHopeFailure(error);
}

type HopeCommand = ApplyHopeRequestSignal;

async function sendApplyHopeReply(
  uploadId: string,
  replyWorkflowId: string,
  reply: ApplyHopeWorkflowReply,
): Promise<void> {
  await CancellationScope.nonCancellable(async () => {
    try {
      await getExternalWorkflowHandle(replyWorkflowId).signal(applyHopeResultSignal, reply);
    } catch {
      log.warn("Hope result delivery failed", {
        event: "hope_result_delivery_failed",
        uploadId,
      });
    }
  });
}

async function sendPublishUploadV2Reply(
  uploadId: string,
  replyWorkflowId: string,
  reply: PublishUploadV2WorkflowReply,
): Promise<void> {
  await CancellationScope.nonCancellable(async () => {
    try {
      await getExternalWorkflowHandle(replyWorkflowId).signal(publishUploadV2ResultSignal, reply);
    } catch {
      log.warn("Publication result delivery failed", {
        event: "publish_result_delivery_failed",
        uploadId,
      });
    }
  });
}

type PublishUploadV2Outcome =
  | { result: PublishUploadV2Result }
  | { error: PublishUploadV2WorkflowFailure };

async function sendPublishUploadV2Replies(
  uploadId: string,
  requests: readonly PublishUploadV2RequestSignal[],
  outcome: PublishUploadV2Outcome,
): Promise<void> {
  for (const request of requests) {
    const reply: PublishUploadV2WorkflowReply = "result" in outcome
      ? { requestId: request.requestId, result: outcome.result }
      : { requestId: request.requestId, error: outcome.error };
    await sendPublishUploadV2Reply(uploadId, request.replyWorkflowId, reply);
  }
}

async function runHopePreparation(
  input: ProcessUploadInput,
  requestId: string,
  hope: NormalizedHopeOptions,
  deadline: number,
): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw uploadExpiredError();
  const cleanupGraceMs = 5 * 60 * 1000;
  const startToCloseMs = Math.min(60 * 60 * 1000, remaining + cleanupGraceMs);
  const { prepareHopeUpload } = proxyActivities<HopeProcessingActivities>({
    taskQueue: HOPE_TASK_QUEUE,
    startToCloseTimeout: startToCloseMs,
    scheduleToCloseTimeout: remaining + cleanupGraceMs,
    heartbeatTimeout: Math.min(30_000, startToCloseMs),
    cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
    retry: {
      maximumAttempts: 1,
      initialInterval: "1 second",
      maximumInterval: "30 seconds",
      nonRetryableErrorTypes: [
        UPLOAD_VALIDATION_ERROR_TYPE,
        UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
      ],
    },
  });
  await CancellationScope.withTimeout(remaining, () => prepareHopeUpload({
    ...input,
    requestId,
    maxEdge: HOPE_MAX_EDGE,
    hope,
  }));
  if (Date.now() >= deadline) throw uploadExpiredError();
}

async function applyHopeWorkflow(input: ApplyHopeInput): Promise<ApplyHopeResult> {
  const normalized = parseApplyHopeInput(input);
  if (!normalized) {
    throw ApplicationFailure.create({
      message: "Hope options are invalid",
      type: UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
      nonRetryable: true,
    });
  }

  const requestId = uuid4();
  const result = new Trigger<ApplyHopeWorkflowReply>();
  setHandler(applyHopeResultSignal, (rawReply) => {
    const reply = parseApplyHopeWorkflowReply(normalized.id, requestId, rawReply);
    if (reply) result.resolve(reply);
  });

  const replyWorkflowId = workflowInfo().workflowId;
  await getExternalWorkflowHandle(`media-upload:${normalized.id}`).signal(applyHopeRequestSignal, {
    requestId,
    replyWorkflowId,
    hope: normalized.hope,
  } satisfies ApplyHopeRequestSignal);

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

export { applyHopeWorkflow };

async function publishUploadV2Workflow(
  input: PublishUploadV2WorkflowInput,
): Promise<PublishUploadV2Result> {
  const normalized = parsePublishUploadV2WorkflowInput(input);
  if (!normalized) {
    throw ApplicationFailure.create({
      message: "upload publication input is invalid",
      type: UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
      nonRetryable: true,
    });
  }
  if (normalized.applyAiProhibitFilter && !normalized.hopeEnabled) {
    throw ApplicationFailure.create({
      message: "Hope updates are not supported for this upload",
      type: HOPE_PROCESSING_ERROR_TYPE,
      nonRetryable: true,
    });
  }

  const requestId = uuid4();
  const result = new Trigger<PublishUploadV2WorkflowReply>();
  setHandler(publishUploadV2ResultSignal, (rawReply) => {
    const reply = parsePublishUploadV2WorkflowReply(normalized.id, requestId, rawReply);
    if (reply) result.resolve(reply);
  });

  const replyWorkflowId = workflowInfo().workflowId;
  await getExternalWorkflowHandle(`media-upload:${normalized.id}`).signal(
    publishUploadV2RequestSignal,
    {
      requestId,
      replyWorkflowId,
      applyAiProhibitFilter: normalized.applyAiProhibitFilter,
    } satisfies PublishUploadV2RequestSignal,
  );

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

export { publishUploadV2Workflow };

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
  let publicationActivityStarted = false;
  let pendingHopeCommand: HopeCommand | undefined;
  let selectedHopeRequestId: string | undefined;
  let pendingPublishV2Choice: boolean | undefined;
  let pendingPublishV2Requests: PublishUploadV2RequestSignal[] = [];
  let selectedPublishV2Choice: boolean | undefined;
  let pendingPublishV2Results: PublishUploadV2RequestSignal[] = [];
  let completedPublishV2Result: Extract<PublishUploadV2Result, { status: "completed" }> | undefined;
  let publishV2Failure: PublishUploadV2WorkflowFailure | undefined;
  const hopeRequestIds: string[] = [];
  let workflowFailure: unknown;

  try {
    setHandler(publishUploadSignal, () => {
      if (!hopeFailed || hopeCommandBusy) published = true;
    });

    setHandler(publishUploadV2RequestSignal, async (rawRequest) => {
      const envelope = parsePublishUploadV2RequestEnvelope(validatedInput.id, rawRequest);
      if (!envelope) {
        log.warn("Invalid publication request was dropped", {
          event: "publish_request_dropped",
          uploadId: validatedInput.id,
        });
        return;
      }

      const command = parsePublishUploadV2RequestSignal(validatedInput.id, rawRequest);
      const reject = async (error: unknown) => {
        await sendPublishUploadV2Reply(validatedInput.id, envelope.replyWorkflowId, {
          requestId: envelope.requestId,
          error: safePublishUploadV2Failure(error),
        });
      };
      if (!command) {
        await reject(ApplicationFailure.create({
          message: "upload publication input is invalid",
          type: UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
          nonRetryable: true,
        }));
        return;
      }
      if (completedPublishV2Result) {
        if (
          (selectedPublishV2Choice === undefined && selectedHopeRequestId !== undefined) ||
          command.applyAiProhibitFilter !== (selectedPublishV2Choice ?? false)
        ) {
          await reject(publicationSelectionConflictError());
        } else {
          await sendPublishUploadV2Reply(validatedInput.id, command.replyWorkflowId, {
            requestId: command.requestId,
            result: completedPublishV2Result,
          });
        }
        return;
      }
      if (selectedPublishV2Choice !== undefined) {
        if (selectedPublishV2Choice !== command.applyAiProhibitFilter) {
          await reject(publicationSelectionConflictError());
        } else if (publishV2Failure) {
          await sendPublishUploadV2Reply(validatedInput.id, command.replyWorkflowId, {
            requestId: command.requestId,
            error: publishV2Failure,
          });
        } else if (selectedPublishV2Choice) {
          await sendPublishUploadV2Reply(validatedInput.id, command.replyWorkflowId, {
            requestId: command.requestId,
            result: { status: "processing", id: validatedInput.id },
          });
        } else {
          pendingPublishV2Results.push(command);
        }
        return;
      }
      if (publishV2Failure) {
        await sendPublishUploadV2Reply(validatedInput.id, command.replyWorkflowId, {
          requestId: command.requestId,
          error: publishV2Failure,
        });
        return;
      }
      if (publicationActivityStarted && selectedPublishV2Choice === undefined) {
        await reject(publicationSelectionConflictError());
        return;
      }
      if (workflowEnding) {
        await reject(hopeUpdateError("Upload workflow ended"));
        return;
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        await reject(uploadExpiredError());
        return;
      }
      if (hopeRequestsEnabled === false) {
        await reject(hopeUpdateError("Hope updates are not supported for this upload"));
        return;
      }
      if (pendingPublishV2Choice !== undefined) {
        if (pendingPublishV2Choice !== command.applyAiProhibitFilter) {
          await reject(publicationSelectionConflictError());
        } else {
          pendingPublishV2Requests.push(command);
        }
        return;
      }
      if (published && command.applyAiProhibitFilter) {
        await reject(publicationSelectionConflictError());
        return;
      }

      pendingPublishV2Choice = command.applyAiProhibitFilter;
      pendingPublishV2Requests = [command];
    });

    // Register before the first activity so an immediate Hope request can be buffered.
    setHandler(applyHopeRequestSignal, async (rawRequest) => {
      const envelope = parseApplyHopeRequestEnvelope(validatedInput.id, rawRequest);
      if (!envelope) {
        log.warn("Invalid Hope request was dropped", {
          event: "hope_request_dropped",
          uploadId: validatedInput.id,
        });
        return;
      }

      const command = parseApplyHopeRequestSignal(validatedInput.id, rawRequest);
      const reject = async (error: unknown) => {
        await sendApplyHopeReply(validatedInput.id, envelope.replyWorkflowId, {
          requestId: envelope.requestId,
          error: safeApplyHopeFailure(error),
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
      if (pendingPublishV2Choice !== undefined || selectedPublishV2Choice !== undefined) {
        await reject(hopeUpdateError("Upload publication has started"));
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
      await sendApplyHopeReply(validatedInput.id, command.replyWorkflowId, {
        requestId: command.requestId,
        error: safeApplyHopeFailure(hopeUpdateError("Hope updates are not supported for this upload")),
      });
      await CancellationScope.nonCancellable(() => condition(allHandlersFinished));
    }

    if (usePreparedPublication) {
      await prepareUploadImage(validatedInput);
      if (Date.now() >= deadline) throw uploadExpiredError();
    }

    if (!useHopeRequests && pendingPublishV2Choice !== undefined) {
      const requests = pendingPublishV2Requests;
      pendingPublishV2Choice = undefined;
      pendingPublishV2Requests = [];
      await sendPublishUploadV2Replies(
        validatedInput.id,
        requests,
        { error: safePublishUploadV2Failure(hopeUpdateError("Hope updates are not supported for this upload")) },
      );
    }

    if (useHopeRequests) {
      while (true) {
        if (pendingHopeCommand) {
          const command = pendingHopeCommand;
          pendingHopeCommand = undefined;
          try {
            if (Date.now() >= deadline) throw uploadExpiredError();

            if (command.hope !== null) {
              await runHopePreparation(
                validatedInput,
                command.requestId,
                command.hope,
                deadline,
              );
              selectedHopeRequestId = command.requestId;
            } else {
              if (Date.now() >= deadline) throw uploadExpiredError();
              selectedHopeRequestId = undefined;
            }

            hopeFailed = false;
            await sendApplyHopeReply(validatedInput.id, command.replyWorkflowId, {
              requestId: command.requestId,
              result: { id: validatedInput.id, hope: command.hope },
            });
            hopeCommandBusy = false;
          } catch (error) {
            // A failed attempt never publishes the last successful Hope artifact by accident.
            hopeFailed = true;
            published = false;
            await sendApplyHopeReply(validatedInput.id, command.replyWorkflowId, {
              requestId: command.requestId,
              error: safeApplyHopeFailure(error),
            });
            hopeCommandBusy = false;
          }
          continue;
        }

        if (pendingPublishV2Choice !== undefined) {
          if (Date.now() >= deadline) throw uploadExpiredError();
          const choice = pendingPublishV2Choice;
          const requests = pendingPublishV2Requests;
          pendingPublishV2Choice = undefined;
          pendingPublishV2Requests = [];
          selectedPublishV2Choice = choice;
          published = true;
          if (choice) {
            const requestId = uuid4();
            hopeRequestIds.push(requestId);
            const hope = { algorithm: "glaze", iterations: 450, intensity: 0.3 } as const;
            const preparationOutcome = runHopePreparation(
              validatedInput,
              requestId,
              hope,
              deadline,
            ).then(
              () => ({ succeeded: true as const }),
              (error: unknown) => ({ succeeded: false as const, error }),
            );
            await sendPublishUploadV2Replies(validatedInput.id, requests, {
              result: { status: "processing", id: validatedInput.id },
            });
            try {
              const outcome = await preparationOutcome;
              if (!outcome.succeeded) throw outcome.error;
              selectedHopeRequestId = requestId;
              hopeFailed = false;
            } catch (error) {
              hopeFailed = true;
              published = false;
              throw error;
            }
          } else {
            selectedHopeRequestId = undefined;
            hopeFailed = false;
            pendingPublishV2Results.push(...requests);
          }
          continue;
        }

        if (published && !hopeFailed) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw uploadExpiredError();
        if (!(await condition(
          () => pendingHopeCommand !== undefined || pendingPublishV2Choice !== undefined ||
            (published && !hopeFailed),
          remaining,
        ))) {
          throw uploadExpiredError();
        }
      }

      publicationActivityStarted = true;
      await CancellationScope.nonCancellable(() => condition(allHandlersFinished));
      if (Date.now() >= deadline) throw uploadExpiredError();
      const result = await publishPreparedUpload({
        ...validatedInput,
        ...(selectedHopeRequestId ? { hopeRequestId: selectedHopeRequestId } : {}),
      });
      completedPublishV2Result = { status: "completed", ...result };
      await sendPublishUploadV2Replies(
        validatedInput.id,
        pendingPublishV2Results,
        { result: completedPublishV2Result },
      );
      pendingPublishV2Results = [];
      return result;
    }

    if (!published) {
      if (!(await condition(() => published, Math.max(0, deadline - Date.now())))) {
        throw uploadExpiredError();
      }
      if (Date.now() >= deadline) throw uploadExpiredError();
    }

    publicationActivityStarted = true;
    const result = usePreparedPublication
      ? await publishPreparedUpload(validatedInput)
      : await processUploadImage(validatedInput);
    return result;
  } catch (error) {
    workflowFailure = error;
    publishV2Failure = safePublishUploadV2Failure(error);
    throw error;
  } finally {
    try {
      workflowEnding = true;
      if (pendingHopeCommand) {
        const command = pendingHopeCommand;
        pendingHopeCommand = undefined;
        hopeCommandBusy = false;
        await sendApplyHopeReply(validatedInput.id, command.replyWorkflowId, {
          requestId: command.requestId,
          error: safeApplyHopeFailure(workflowFailure ?? hopeUpdateError("Upload workflow ended")),
        });
      }
      const pendingRequests = pendingPublishV2Requests;
      pendingPublishV2Requests = [];
      pendingPublishV2Choice = undefined;
      const waitingForResult = pendingPublishV2Results;
      pendingPublishV2Results = [];
      const pendingReplies = [...pendingRequests, ...waitingForResult];
      const failure = publishV2Failure ?? safePublishUploadV2Failure(
        workflowFailure ?? hopeUpdateError("Upload workflow ended"),
      );
      await sendPublishUploadV2Replies(validatedInput.id, pendingReplies, { error: failure });
      await CancellationScope.nonCancellable(async () => {
        await condition(allHandlersFinished);
        await deleteUploadSource({
          id: validatedInput.id,
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
