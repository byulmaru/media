import { z } from "zod";

const nonWhitespaceNodeValueSchema = z.string().refine((value) => value.trim().length > 0);

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

const hopeBaseUrlSchema = nonWhitespaceNodeValueSchema
  .pipe(z.url({ protocol: /^https?$/ }))
  .pipe(z.string().refine((value) => {
    const url = new URL(value);
    const isLoopback = url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      url.hostname === "127.0.0.1";
    return url.origin === value && (url.protocol === "https:" || isLoopback);
  }));

export const hopeWorkerConfigSchema = z.object({
  TEMPORAL_ADDRESS: nonWhitespaceNodeValueSchema,
  TEMPORAL_NAMESPACE: nonWhitespaceNodeValueSchema,
  R2_ENDPOINT: nonWhitespaceNodeValueSchema.pipe(r2EndpointSchema),
  R2_BUCKET_NAME: nonWhitespaceNodeValueSchema,
  R2_STAGING_BUCKET_NAME: nonWhitespaceNodeValueSchema,
  AWS_ACCESS_KEY_ID: nonWhitespaceNodeValueSchema,
  AWS_SECRET_ACCESS_KEY: nonWhitespaceNodeValueSchema,
  HOPE_BASE_URL: hopeBaseUrlSchema,
  HOPE_API_TOKEN: nonWhitespaceNodeValueSchema,
}).refine((config) => config.R2_BUCKET_NAME !== config.R2_STAGING_BUCKET_NAME);

export type HopeWorkerConfig = z.infer<typeof hopeWorkerConfigSchema>;
export type HopeApiConfig = Pick<HopeWorkerConfig, "HOPE_BASE_URL" | "HOPE_API_TOKEN">;

export function parseHopeWorkerConfig(
  source: NodeJS.ProcessEnv = process.env,
): HopeWorkerConfig {
  const parsed = hopeWorkerConfigSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error("Hope worker configuration is incomplete");
  }
  return parsed.data;
}
