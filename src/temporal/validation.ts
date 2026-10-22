import { z } from "zod";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_DIMENSION } from "../constants";
import type {
  ProcessUploadInput,
  PublishPreparedUploadInput,
  PublishUploadInput,
  HopeProcessingInput,
  NormalizedHopeOptions,
  SetHopeResult,
  SetHopeRequestEnvelope,
  SetHopeRequestSignal,
  SetHopeWorkflowReply,
  UploadSourceCleanupInput,
} from "./types";
import {
  HOPE_REPLY_WORKFLOW_ID_MAX_LENGTH,
  SET_HOPE_REPLY_ERROR_TYPES,
  SET_HOPE_WORKFLOW_ID_PREFIX,
} from "./types";

const uploadIdSchema = z.string().regex(
  /^u_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
export const uploadStagingKeySchema = z.string().regex(
  /^uploads\/u_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

const processUploadFields = {
  id: uploadIdSchema,
  sourceKey: uploadStagingKeySchema,
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  maxBytes: z.number().int().positive().max(DEFAULT_MAX_BYTES),
  maxDimension: z.number().int().positive().max(DEFAULT_MAX_DIMENSION),
};

export const processUploadInputSchema = z.strictObject(processUploadFields)
  .refine((input) => input.sourceKey.split("/")[1] === input.id);

export const publishPreparedUploadInputSchema = z.strictObject({
  ...processUploadFields,
  hopeRequestId: uuidSchema.optional(),
}).refine((input) => input.sourceKey.split("/")[1] === input.id);

export const publishUploadInputSchema = z.strictObject({
  id: uploadIdSchema,
});

export const uploadSourceCleanupInputSchema = z.strictObject({
  id: uploadIdSchema,
  sourceKey: uploadStagingKeySchema,
  hopeRequestIds: z.array(uuidSchema).optional(),
}).refine((input) => input.sourceKey.split("/")[1] === input.id);

export const hopeOptionsSchema = z.discriminatedUnion("algorithm", [
  z.strictObject({
    algorithm: z.literal("noise"),
    iterations: z.number().int().min(1).max(500),
    intensity: z.number().gt(0).max(1).default(0.3),
  }),
  z.strictObject({
    algorithm: z.literal("glaze"),
    iterations: z.number().int().min(1).max(600),
    intensity: z.number().gt(0).max(1).default(0.3),
  }),
  z.strictObject({
    algorithm: z.literal("nightshade"),
    iterations: z.number().int().min(1).max(750),
    intensity: z.number().gt(0).max(1).default(0.3),
  }),
]);

export const setHopeInputSchema = z.strictObject({
  id: uploadIdSchema,
  hope: hopeOptionsSchema.nullable(),
});

const setHopeRequestEnvelopeSchema = z.object({
  requestId: uuidSchema,
  replyWorkflowId: z.string().min(1).max(HOPE_REPLY_WORKFLOW_ID_MAX_LENGTH),
});

const setHopeRequestSignalSchema = z.strictObject({
  requestId: uuidSchema,
  replyWorkflowId: z.string().min(1).max(HOPE_REPLY_WORKFLOW_ID_MAX_LENGTH),
  hope: z.unknown(),
});

const setHopeWorkflowReplySchema = z.union([
  z.strictObject({ requestId: uuidSchema, result: z.unknown() }),
  z.strictObject({
    requestId: uuidSchema,
    error: z.strictObject({
      type: z.enum(SET_HOPE_REPLY_ERROR_TYPES),
      message: z.string().min(1).max(200),
    }),
  }),
]);

export const hopeProcessingInputSchema = z.strictObject({
  ...processUploadFields,
  requestId: uuidSchema,
  hope: hopeOptionsSchema,
}).refine((input) => input.sourceKey.split("/")[1] === input.id);

export function parseProcessUploadInput(input: unknown): ProcessUploadInput | undefined {
  const parsed = processUploadInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function parsePublishPreparedUploadInput(
  input: unknown,
): PublishPreparedUploadInput | undefined {
  const parsed = publishPreparedUploadInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function parsePublishUploadInput(input: unknown): PublishUploadInput | undefined {
  const parsed = publishUploadInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function parseUploadSourceCleanupInput(
  input: unknown,
): UploadSourceCleanupInput | undefined {
  const parsed = uploadSourceCleanupInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function parseHopeOptions(input: unknown): NormalizedHopeOptions | undefined {
  const parsed = hopeOptionsSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function parseSetHopeInput(input: unknown): SetHopeResult | undefined {
  const parsed = setHopeInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

function isSetHopeReplyWorkflowId(uploadId: string, workflowId: string): boolean {
  const prefix = `${SET_HOPE_WORKFLOW_ID_PREFIX}${uploadId}:`;
  const suffix = workflowId.slice(prefix.length);
  return workflowId.startsWith(prefix) && suffix.length > 0 &&
    /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9a-f]{2})+$/i.test(suffix);
}

export function parseSetHopeRequestEnvelope(
  uploadId: string,
  input: unknown,
): SetHopeRequestEnvelope | undefined {
  const parsed = setHopeRequestEnvelopeSchema.safeParse(input);
  return parsed.success && isSetHopeReplyWorkflowId(uploadId, parsed.data.replyWorkflowId)
    ? parsed.data
    : undefined;
}

export function parseSetHopeRequestSignal(
  uploadId: string,
  input: unknown,
): SetHopeRequestSignal | undefined {
  const parsed = setHopeRequestSignalSchema.safeParse(input);
  if (!parsed.success || !isSetHopeReplyWorkflowId(uploadId, parsed.data.replyWorkflowId)) {
    return undefined;
  }
  if (parsed.data.hope === null) return { ...parsed.data, hope: null };
  if (
    typeof parsed.data.hope !== "object" || parsed.data.hope === null ||
    !("intensity" in parsed.data.hope)
  ) {
    return undefined;
  }
  const hope = parseHopeOptions(parsed.data.hope);
  return hope ? { ...parsed.data, hope } : undefined;
}

export function parseSetHopeWorkflowReply(
  uploadId: string,
  requestId: string,
  input: unknown,
): SetHopeWorkflowReply | undefined {
  const parsed = setHopeWorkflowReplySchema.safeParse(input);
  if (!parsed.success || parsed.data.requestId !== requestId) return undefined;
  if ("error" in parsed.data) return parsed.data;

  const result = parsed.data.result;
  if (
    typeof result !== "object" || result === null ||
    !("hope" in result) ||
    (result.hope !== null && (
      typeof result.hope !== "object" || result.hope === null ||
      !("intensity" in result.hope)
    ))
  ) {
    return undefined;
  }
  const normalizedResult = parseSetHopeInput(result);
  return normalizedResult?.id === uploadId
    ? { requestId, result: normalizedResult }
    : undefined;
}

export function parseHopeProcessingInput(input: unknown): HopeProcessingInput | undefined {
  const parsed = hopeProcessingInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
