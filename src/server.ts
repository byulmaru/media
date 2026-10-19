import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "./app";
import { initializeNodeCodec } from "./codec.node";
import { assertConfig } from "./middleware/config";
import { createR2S3MediaStorage } from "./storage/r2-s3";
import type { MediaStorage } from "./storage";
import type { Env } from "./types";
import { nodeServerConfigSchema } from "./validation";

export { R2S3MediaStorage } from "./storage/r2-s3";

function readNodeConfig(source: NodeJS.ProcessEnv) {
  const result = nodeServerConfigSchema.safeParse(source);
  if (result.success) return result.data;

  const name = result.error.issues[0]?.path[0];
  if (name === "PORT") {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  if (typeof name === "string" && !source[name]?.trim()) {
    throw new Error(`${name} is required`);
  }
  if (name === "R2_ENDPOINT") {
    throw new Error("R2_ENDPOINT must be an HTTPS origin");
  }
  throw new Error("service configuration is incomplete");
}

export async function startServer(
  source: NodeJS.ProcessEnv = process.env,
  mediaStorage?: MediaStorage,
): Promise<ReturnType<typeof serve>> {
  const {
    PORT: port,
    R2_ENDPOINT: r2Endpoint,
    R2_BUCKET_NAME: bucketName,
    API_KEY: apiKey,
    UPLOAD_SIGNING_SECRET: signingSecret,
    ALLOWED_ORIGINS: allowedOrigins,
    PUBLIC_BASE_URL: publicBaseUrl,
    PUBLIC_API_BASE_URL: publicApiBaseUrl,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
  } = readNodeConfig(source);

  const media =
    mediaStorage ??
    createR2S3MediaStorage({
      endpoint: r2Endpoint,
      bucketName,
      accessKeyId,
      secretAccessKey,
    });
  const bindings: Env = {
    MEDIA: media,
    API_KEY: apiKey,
    UPLOAD_SIGNING_SECRET: signingSecret,
    ALLOWED_ORIGINS: allowedOrigins,
    PUBLIC_BASE_URL: publicBaseUrl,
    PUBLIC_API_BASE_URL: publicApiBaseUrl,
  };
  assertConfig(bindings);
  await initializeNodeCodec();

  return serve({
    fetch: (request) => app.fetch(request, bindings),
    hostname: "0.0.0.0",
    port,
  });
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
