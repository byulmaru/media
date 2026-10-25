import { z } from "zod";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_DIMENSION } from "./constants";
import { HttpError } from "./errors";
import type { MediaStorage } from "./storage";

// Zod's z.url() trims successful output, so exact raw-origin checks need a precheck.
const untrimmedUrlSchema = z.string().refine((value) => value === value.trim());

const exactOriginSchema = untrimmedUrlSchema
  .pipe(z.url())
  .pipe(z.string().refine((value) => new URL(value).origin === value));

const allowedOriginsSchema = z.string().refine((value) => {
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean);
  return origins.length > 0 && origins.every((origin) => exactOriginSchema.safeParse(origin).success);
});

const publicApiBaseUrlSchema = untrimmedUrlSchema
  .pipe(z.url({ protocol: /^https?$/ }))
  .pipe(z.string().refine((value) => {
    const url = new URL(value);
    return url.origin === value && (
      url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  }));

const r2EndpointSchema = z
  .url({ protocol: /^https$/ })
  .pipe(z.string().refine((value) => {
    const endpoint = new URL(value);
    return endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.pathname === "/" &&
      endpoint.search === "" &&
      endpoint.hash === "";
  }))
  .transform((value) => new URL(value).origin);

const mediaStorageSchema = z.custom<MediaStorage>((value) =>
  value !== null &&
  typeof value === "object" &&
  typeof Reflect.get(value, "head") === "function" &&
  typeof Reflect.get(value, "put") === "function",
);

export const runtimeConfigSchema = z.object({
  API_KEY: z.string().min(1),
  UPLOAD_SIGNING_SECRET: z.string().min(32),
  ALLOWED_ORIGINS: allowedOriginsSchema,
  PUBLIC_BASE_URL: exactOriginSchema,
  PUBLIC_API_BASE_URL: publicApiBaseUrlSchema.optional(),
  MEDIA: mediaStorageSchema,
  STAGING: mediaStorageSchema.optional(),
});

const nonWhitespaceNodeValueSchema = z.string().refine((value) => value.trim().length > 0);

const hopeApiUrlSchema = untrimmedUrlSchema
  .pipe(z.url({ protocol: /^https$/ }))
  .pipe(z.string().refine((value) => new URL(value).origin === value));

const digitsOnlyPortSchema = z
  .string()
  .regex(/^\d+$/)
  .default("3000")
  .transform(Number)
  .pipe(z.number().int().min(1).max(65535));

export const nodeServerConfigSchema = z.object({
  API_KEY: nonWhitespaceNodeValueSchema,
  UPLOAD_SIGNING_SECRET: nonWhitespaceNodeValueSchema.pipe(z.string().min(32)),
  ALLOWED_ORIGINS: nonWhitespaceNodeValueSchema.pipe(allowedOriginsSchema),
  PUBLIC_BASE_URL: nonWhitespaceNodeValueSchema.pipe(exactOriginSchema),
  PUBLIC_API_BASE_URL: nonWhitespaceNodeValueSchema.pipe(publicApiBaseUrlSchema),
  PORT: digitsOnlyPortSchema,
  R2_ENDPOINT: nonWhitespaceNodeValueSchema.pipe(r2EndpointSchema),
  R2_BUCKET_NAME: nonWhitespaceNodeValueSchema,
  R2_STAGING_BUCKET_NAME: nonWhitespaceNodeValueSchema,
  AWS_ACCESS_KEY_ID: nonWhitespaceNodeValueSchema,
  AWS_SECRET_ACCESS_KEY: nonWhitespaceNodeValueSchema,
}).refine((config) => config.R2_BUCKET_NAME !== config.R2_STAGING_BUCKET_NAME);

export const temporalUploadConfigSchema = z.object({
  HOPE_ENABLED: z.stringbool().default(false),
  TEMPORAL_ADDRESS: nonWhitespaceNodeValueSchema,
  TEMPORAL_NAMESPACE: nonWhitespaceNodeValueSchema,
  TEMPORAL_TASK_QUEUE: nonWhitespaceNodeValueSchema,
  PUBLIC_BASE_URL: nonWhitespaceNodeValueSchema.pipe(publicApiBaseUrlSchema),
  R2_ENDPOINT: nonWhitespaceNodeValueSchema.pipe(r2EndpointSchema),
  R2_BUCKET_NAME: nonWhitespaceNodeValueSchema,
  AWS_ACCESS_KEY_ID: nonWhitespaceNodeValueSchema,
  AWS_SECRET_ACCESS_KEY: nonWhitespaceNodeValueSchema,
  R2_STAGING_BUCKET_NAME: nonWhitespaceNodeValueSchema,
  HOPE_API_URL: hopeApiUrlSchema.optional(),
})
  .refine((config) => config.R2_BUCKET_NAME !== config.R2_STAGING_BUCKET_NAME);

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

export const uploadRequestSchema = z.union([
  z.strictObject({ staging: z.literal(true) }),
  z.strictObject(limits),
]);

export const uploadIdParamSchema = z.strictObject({
  id: z.string().regex(
    /^u_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "upload ID must be a u_-prefixed UUIDv4",
  ),
});

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
