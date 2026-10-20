import {
  ApplicationFailure,
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { HttpError } from "../errors";
import type { UploadInput, UploadProcessor } from "../upload-processing";
import type { UploadStagingStorage } from "../storage/staging";
import type { processUploadWorkflow } from "./workflow";
import type { ProcessUploadInput } from "./types";
import {
  PROCESS_UPLOAD_WORKFLOW_TYPE,
  UPLOAD_VALIDATION_CODES,
  UPLOAD_VALIDATION_ERROR_TYPE,
} from "./types";

const RESULT_TIMEOUT_MS = 100_000;
const uploadValidationFailureSchema = z.object({
  status: z.number().int().min(400).max(499),
  code: z.enum(UPLOAD_VALIDATION_CODES),
}).strict();

export interface TemporalUploadProcessorConfig {
  address: string;
  namespace: string;
  taskQueue: string;
}

function uploadValidationFailure(error: unknown) {
  let cause: unknown = error;
  const seen = new Set<unknown>();
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof ApplicationFailure && cause.type === UPLOAD_VALIDATION_ERROR_TYPE) {
      const detail = uploadValidationFailureSchema.safeParse(cause.details?.[0]);
      return detail.success ? detail.data : undefined;
    }
    cause = "cause" in cause ? Reflect.get(cause, "cause") : undefined;
  }
  return undefined;
}

function waitForResult(result: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new HttpError(503, "processing_pending", "upload processing is continuing")),
      RESULT_TIMEOUT_MS,
    );
  });
  return Promise.race([result, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function createTemporalUploadProcessor(
  config: TemporalUploadProcessorConfig,
  staging: UploadStagingStorage,
): { process: UploadProcessor; close(): Promise<void> } {
  let connection: Connection | undefined;
  let clientPromise: Promise<Client> | undefined;

  function getClient(): Promise<Client> {
    if (!clientPromise) {
      clientPromise = Connection.connect({ address: config.address })
        .then((connected) => {
          connection = connected;
          return new Client({ connection: connected, namespace: config.namespace });
        })
        .catch((error: unknown) => {
          clientPromise = undefined;
          throw error;
        });
    }
    return clientPromise;
  }

  async function deleteCandidate(sourceKey: string): Promise<void> {
    try {
      await staging.delete(sourceKey);
    } catch {
      throw new HttpError(503, "processing_unavailable", "upload processing is unavailable");
    }
  }

  const process: UploadProcessor = async (input: UploadInput): Promise<void> => {
    const sourceKey = `uploads/${input.id}/${randomUUID()}`;
    try {
      await staging.put(sourceKey, input.bytes);
    } catch {
      try {
        await staging.delete(sourceKey);
      } catch {
        // The staging bucket's lifecycle rule removes an object when an uncertain Put cannot be cleaned up.
      }
      throw new HttpError(503, "processing_unavailable", "upload processing is unavailable");
    }

    let temporalClient: Client;
    try {
      temporalClient = await getClient();
    } catch {
      await deleteCandidate(sourceKey);
      throw new HttpError(503, "processing_unavailable", "upload processing is unavailable");
    }

    const workflowInput: ProcessUploadInput = {
      id: input.id,
      sourceKey,
      contentType: input.contentType,
      maxBytes: input.limits.maxBytes,
      maxDimension: input.limits.maxDimension,
    };
    let handle: Awaited<ReturnType<Client["workflow"]["start"]>>;
    try {
      handle = await temporalClient.workflow.start<typeof processUploadWorkflow>(
        PROCESS_UPLOAD_WORKFLOW_TYPE,
        {
          workflowId: `media-upload:${input.id}`,
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
          workflowExecutionTimeout: "10 minutes",
          taskQueue: config.taskQueue,
          args: [workflowInput],
        },
      );
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        await deleteCandidate(sourceKey);
        throw new HttpError(409, "already_uploaded", "upload URL has already been used");
      }
      throw new HttpError(503, "processing_unavailable", "upload processing is unavailable");
    }

    try {
      await waitForResult(handle.result());
    } catch (error) {
      if (error instanceof HttpError && error.code === "processing_pending") throw error;
      const failure = uploadValidationFailure(error);
      if (failure) throw new HttpError(failure.status, failure.code, "image validation failed");
      throw new HttpError(503, "processing_unavailable", "upload processing is unavailable");
    }
  };

  return {
    process,
    async close(): Promise<void> {
      if (clientPromise) await clientPromise.catch(() => undefined);
      await connection?.close();
      connection = undefined;
      clientPromise = undefined;
    },
  };
}
