import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from "@temporalio/client";
import { getClient, startWorkflow, WorkflowRunOperationHandler } from "@temporalio/nexus";
import { HandlerError, serviceHandler } from "nexus-rpc";

import type { processUploadWorkflow } from "./workflow";
import {
  PROCESS_UPLOAD_WORKFLOW_TYPE,
  PUBLISH_UPLOAD_SIGNAL_NAME,
} from "./types";
import type {
  ProcessUploadInput,
  ProcessUploadResult,
  PublishUploadResult,
} from "./types";
import { parseProcessUploadInput, parsePublishUploadInput } from "./validation";
import { mediaService } from "./service";

export const mediaServiceHandler = serviceHandler(mediaService, {
  startUpload: new WorkflowRunOperationHandler<ProcessUploadInput, ProcessUploadResult>(
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
  ),
  publishUpload: async (_ctx, rawInput): Promise<PublishUploadResult> => {
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
  },
});
