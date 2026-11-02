import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import {
  getClient,
  startWorkflow,
  WorkflowRunOperationHandler,
} from "@temporalio/nexus";
import { HandlerError, serviceHandler } from "nexus-rpc";

import type { processUploadWorkflow, applyHopeWorkflow } from "./workflow";
import {
  HOPE_REPLY_WORKFLOW_ID_MAX_LENGTH,
  PROCESS_UPLOAD_WORKFLOW_TYPE,
  PUBLISH_UPLOAD_SIGNAL_NAME,
  APPLY_HOPE_WORKFLOW_ID_PREFIX,
  APPLY_HOPE_WORKFLOW_TYPE,
} from "./types";
import type {
  ProcessUploadInput,
  ProcessUploadResult,
  PublishUploadResult,
  ApplyHopeInput,
  ApplyHopeResult,
} from "./types";
import { parseProcessUploadInput, parsePublishUploadInput, parseApplyHopeInput } from "./validation";
import { mediaService, mediaServiceWithoutHope } from "./service";

const startUploadHandler = new WorkflowRunOperationHandler<ProcessUploadInput, ProcessUploadResult>(
  async (ctx, rawInput) => {
    const input = parseProcessUploadInput(rawInput);
    if (!input) {
      throw new HandlerError("BAD_REQUEST", "upload input is invalid", {
        retryableOverride: false,
      });
    }

    try {
      return await startWorkflow<typeof processUploadWorkflow>(
        ctx,
        PROCESS_UPLOAD_WORKFLOW_TYPE,
        {
          args: [input],
          workflowId: `media-upload:${input.id}`,
          workflowIdConflictPolicy: "FAIL",
          workflowIdReusePolicy: "REJECT_DUPLICATE",
          workflowExecutionTimeout: "25 hours",
        },
      );
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        throw new HandlerError("CONFLICT", "upload ID has already been used", {
          cause: error,
          retryableOverride: false,
        });
      }
      throw error;
    }
  },
);

async function publishUpload(_ctx: unknown, rawInput: unknown): Promise<PublishUploadResult> {
  const input = parsePublishUploadInput(rawInput);
  if (!input) {
    throw new HandlerError("BAD_REQUEST", "upload ID is invalid", {
      retryableOverride: false,
    });
  }

  try {
    await getClient().workflow
      .getHandle(`media-upload:${input.id}`)
      .signal(PUBLISH_UPLOAD_SIGNAL_NAME);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      throw new HandlerError("NOT_FOUND", "upload workflow was not found", {
        cause: error,
        retryableOverride: false,
      });
    }
    throw error;
  }
  return { id: input.id };
}

const applyHopeHandler = new WorkflowRunOperationHandler<ApplyHopeInput, ApplyHopeResult>(
  async (ctx, rawInput) => {
    const input = parseApplyHopeInput(rawInput);
    if (!input) {
      throw new HandlerError("BAD_REQUEST", "Hope options are invalid", {
        retryableOverride: false,
      });
    }

    let requestId: string;
    try {
      requestId = encodeURIComponent(ctx.requestId);
    } catch {
      throw new HandlerError("BAD_REQUEST", "Hope request ID is invalid", {
        retryableOverride: false,
      });
    }
    const workflowId = `${APPLY_HOPE_WORKFLOW_ID_PREFIX}${input.id}:${requestId}`;
    if (!ctx.requestId || workflowId.length > HOPE_REPLY_WORKFLOW_ID_MAX_LENGTH) {
      throw new HandlerError("BAD_REQUEST", "Hope request ID is invalid", {
        retryableOverride: false,
      });
    }
    return await startWorkflow<typeof applyHopeWorkflow>(ctx, APPLY_HOPE_WORKFLOW_TYPE, {
      args: [input],
      workflowId,
      workflowIdConflictPolicy: "USE_EXISTING",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      workflowExecutionTimeout: "25 hours",
    });
  },
);

export function createMediaServiceHandler(options: { hopeEnabled?: boolean } = {}) {
  if (options.hopeEnabled) {
    return serviceHandler(mediaService, {
      startUpload: startUploadHandler,
      publishUpload,
      applyHope: applyHopeHandler,
    });
  }
  return serviceHandler(mediaServiceWithoutHope, {
    startUpload: startUploadHandler,
    publishUpload,
  });
}

export const mediaServiceHandler = createMediaServiceHandler();
