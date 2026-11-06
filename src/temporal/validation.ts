import { z } from "zod";

import type {
  ProcessUploadInput,
  PublishPreparedUploadInput,
  PublishUploadInput,
  NormalizedPublishUploadV2Input,
  PublishUploadV2WorkflowInput,
  PublishUploadV2RequestEnvelope,
  PublishUploadV2RequestSignal,
  PublishUploadV2WorkflowReply,
  NormalizedHopeOptions,
  ApplyHopeResult,
  ApplyHopeRequestEnvelope,
  ApplyHopeRequestSignal,
  ApplyHopeWorkflowReply,
  PublishUploadV2WorkflowFailure,
  HopeProcessingInput,
  UploadSourceCleanupInput,
} from "./types";
import {
  HOPE_MAX_EDGE,
  HOPE_REPLY_WORKFLOW_ID_MAX_LENGTH,
  APPLY_HOPE_REPLY_ERROR_TYPES,
  PUBLISH_UPLOAD_V2_REPLY_ERROR_TYPES,
  APPLY_HOPE_WORKFLOW_ID_PREFIX,
  PUBLISH_UPLOAD_V2_REPLY_WORKFLOW_ID_MAX_LENGTH,
  PUBLISH_UPLOAD_V2_WORKFLOW_ID_PREFIX,
} from "./types";

const uploadIdSchema = z.string().regex(
  /^u_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const processUploadFields = {
  id: uploadIdSchema,
};

export const processUploadInputSchema = z.object({
  ...processUploadFields,
  generateAltText: z.boolean().optional(),
});

export const publishPreparedUploadInputSchema = z.object({
  ...processUploadFields,
  hopeRequestId: uuidSchema.optional(),
});

export const publishUploadInputSchema = z.strictObject({
  id: uploadIdSchema,
});

export const publishUploadV2InputSchema = z.object({
  id: uploadIdSchema,
  applyAiProhibitFilter: z.boolean().default(false),
});

export const publishUploadV2WorkflowInputSchema = publishUploadV2InputSchema.extend({
  hopeEnabled: z.boolean(),
});

export const uploadSourceCleanupInputSchema = z.object({
  id: uploadIdSchema,
  hopeRequestIds: z.array(uuidSchema).optional(),
});

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

export const hopeProcessingInputSchema = z.object({
  ...processUploadFields,
  requestId: uuidSchema,
  maxEdge: z.literal(HOPE_MAX_EDGE),
  hope: z.unknown()
    .refine((value) => typeof value === "object" && value !== null &&
      "intensity" in value && typeof value.intensity === "number")
    .pipe(hopeOptionsSchema),
});

export const applyHopeInputSchema = z.strictObject({
  id: uploadIdSchema,
  hope: hopeOptionsSchema.nullable(),
});

const applyHopeRequestEnvelopeSchema = z.object({
  requestId: uuidSchema,
  replyWorkflowId: z.string().min(1).max(HOPE_REPLY_WORKFLOW_ID_MAX_LENGTH),
});

const applyHopeRequestSignalSchema = z.strictObject({
  requestId: uuidSchema,
  replyWorkflowId: z.string().min(1).max(HOPE_REPLY_WORKFLOW_ID_MAX_LENGTH),
  hope: z.unknown(),
});

const applyHopeWorkflowReplySchema = z.union([
  z.strictObject({ requestId: uuidSchema, result: z.unknown() }),
  z.strictObject({
    requestId: uuidSchema,
    error: z.strictObject({
      type: z.enum(APPLY_HOPE_REPLY_ERROR_TYPES),
      message: z.string().min(1).max(200),
    }),
  }),
]);

const publishUploadV2RequestEnvelopeSchema = z.object({
  requestId: uuidSchema,
  replyWorkflowId: z.string().min(1).max(PUBLISH_UPLOAD_V2_REPLY_WORKFLOW_ID_MAX_LENGTH),
});

const publishUploadV2RequestSignalSchema = z.object({
  requestId: uuidSchema,
  replyWorkflowId: z.string().min(1).max(PUBLISH_UPLOAD_V2_REPLY_WORKFLOW_ID_MAX_LENGTH),
  applyAiProhibitFilter: z.boolean(),
});

const publishUploadV2WorkflowReplySchema = z.union([
  z.object({
    requestId: uuidSchema,
    result: z.union([
      z.object({
        status: z.literal("completed"),
        id: uploadIdSchema,
        url: z.string().min(1),
        mediaType: z.literal("image/webp"),
        altText: z.string().nullable().optional(),
      }),
      z.object({
        status: z.literal("processing"),
        id: uploadIdSchema,
      }),
    ]),
  }),
  z.object({
    requestId: uuidSchema,
    error: z.object({
      type: z.enum(PUBLISH_UPLOAD_V2_REPLY_ERROR_TYPES),
      message: z.string().min(1).max(200),
    }),
  }),
]);

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

export function parsePublishUploadV2Input(
  input: unknown,
): NormalizedPublishUploadV2Input | undefined {
  const parsed = publishUploadV2InputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function parsePublishUploadV2WorkflowInput(
  input: unknown,
): PublishUploadV2WorkflowInput | undefined {
  const parsed = publishUploadV2WorkflowInputSchema.safeParse(input);
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

export function parseHopeProcessingInput(input: unknown): HopeProcessingInput | undefined {
  const parsed = hopeProcessingInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function parseApplyHopeInput(input: unknown): ApplyHopeResult | undefined {
  const parsed = applyHopeInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

function isApplyHopeReplyWorkflowId(uploadId: string, workflowId: string): boolean {
  const prefix = `${APPLY_HOPE_WORKFLOW_ID_PREFIX}${uploadId}:`;
  const suffix = workflowId.slice(prefix.length);
  return workflowId.startsWith(prefix) && suffix.length > 0 &&
    /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9a-f]{2})+$/i.test(suffix);
}

function isPublishUploadV2ReplyWorkflowId(uploadId: string, workflowId: string): boolean {
  const prefix = `${PUBLISH_UPLOAD_V2_WORKFLOW_ID_PREFIX}${uploadId}:`;
  const suffix = workflowId.slice(prefix.length);
  return workflowId.startsWith(prefix) && suffix.length > 0 &&
    /^(?:[A-Za-z0-9_.!~*'()-]|%[0-9a-f]{2})+$/i.test(suffix);
}

export function parsePublishUploadV2RequestEnvelope(
  uploadId: string,
  input: unknown,
): PublishUploadV2RequestEnvelope | undefined {
  const parsed = publishUploadV2RequestEnvelopeSchema.safeParse(input);
  return parsed.success && isPublishUploadV2ReplyWorkflowId(uploadId, parsed.data.replyWorkflowId)
    ? parsed.data
    : undefined;
}

export function parsePublishUploadV2RequestSignal(
  uploadId: string,
  input: unknown,
): PublishUploadV2RequestSignal | undefined {
  const parsed = publishUploadV2RequestSignalSchema.safeParse(input);
  return parsed.success && isPublishUploadV2ReplyWorkflowId(uploadId, parsed.data.replyWorkflowId)
    ? parsed.data
    : undefined;
}

export function parsePublishUploadV2WorkflowReply(
  uploadId: string,
  requestId: string,
  input: unknown,
): PublishUploadV2WorkflowReply | undefined {
  const parsed = publishUploadV2WorkflowReplySchema.safeParse(input);
  if (!parsed.success || parsed.data.requestId !== requestId) return undefined;
  if ("error" in parsed.data) return parsed.data as {
    requestId: string;
    error: PublishUploadV2WorkflowFailure;
  };
  return parsed.data.result.id === uploadId ? parsed.data : undefined;
}

export function parseApplyHopeRequestEnvelope(
  uploadId: string,
  input: unknown,
): ApplyHopeRequestEnvelope | undefined {
  const parsed = applyHopeRequestEnvelopeSchema.safeParse(input);
  return parsed.success && isApplyHopeReplyWorkflowId(uploadId, parsed.data.replyWorkflowId)
    ? parsed.data
    : undefined;
}

export function parseApplyHopeRequestSignal(
  uploadId: string,
  input: unknown,
): ApplyHopeRequestSignal | undefined {
  const parsed = applyHopeRequestSignalSchema.safeParse(input);
  if (!parsed.success || !isApplyHopeReplyWorkflowId(uploadId, parsed.data.replyWorkflowId)) {
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

export function parseApplyHopeWorkflowReply(
  uploadId: string,
  requestId: string,
  input: unknown,
): ApplyHopeWorkflowReply | undefined {
  const parsed = applyHopeWorkflowReplySchema.safeParse(input);
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
  const normalizedResult = parseApplyHopeInput(result);
  return normalizedResult?.id === uploadId
    ? { requestId, result: normalizedResult }
    : undefined;
}
