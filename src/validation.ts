import { z } from "zod";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_DIMENSION } from "./constants";
import { HttpError } from "./errors";

const limits = {
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_MAX_BYTES)
    .default(DEFAULT_MAX_BYTES),
  maxDimension: z
    .number()
    .int()
    .positive()
    .max(DEFAULT_MAX_DIMENSION)
    .default(DEFAULT_MAX_DIMENSION),
};

export const uploadRequestSchema = z.strictObject(limits);

export function throwOnValidationError(result: {
  success: boolean;
  error?: { issues: readonly { message: string }[] };
}): void {
  if (!result.success) {
    throw new HttpError(
      400,
      "invalid_body",
      result.error?.issues[0]?.message ?? "request body is invalid",
    );
  }
}
