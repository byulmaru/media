import { z } from "zod";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_DIMENSION } from "../constants";
import type {
  ProcessUploadInput,
  PublishUploadInput,
  UploadSourceCleanupInput,
} from "./types";

const uploadIdSchema = z.string().regex(
  /^u_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
export const uploadStagingKeySchema = z.string().regex(
  /^uploads\/u_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);

export const processUploadInputSchema = z.strictObject({
  id: uploadIdSchema,
  sourceKey: uploadStagingKeySchema,
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  maxBytes: z.number().int().positive().max(DEFAULT_MAX_BYTES),
  maxDimension: z.number().int().positive().max(DEFAULT_MAX_DIMENSION),
}).refine((input) => {
  return input.sourceKey.split("/")[1] === input.id;
});

export const publishUploadInputSchema = z.strictObject({
  id: uploadIdSchema,
});

export const uploadSourceCleanupInputSchema = z.strictObject({
  id: uploadIdSchema,
  sourceKey: uploadStagingKeySchema,
}).refine((input) => input.sourceKey.split("/")[1] === input.id);

export function parseProcessUploadInput(input: unknown): ProcessUploadInput | undefined {
  const parsed = processUploadInputSchema.safeParse(input);
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
