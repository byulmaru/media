import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "./app";
import { initializeNodeCodec } from "./codec.node";
import { assertConfig } from "./middleware/config";
import { createR2S3MediaStorage } from "./storage/r2-s3";
import type { MediaStorage } from "./storage";
import type { Env } from "./types";

export { R2S3MediaStorage } from "./storage/r2-s3";

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string | undefined): number {
  const portText = value ?? "3000";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parseR2Endpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("R2_ENDPOINT must be an HTTPS origin");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("R2_ENDPOINT must be an HTTPS origin");
  }
  return endpoint.origin;
}

export async function startServer(
  source: NodeJS.ProcessEnv = process.env,
  mediaStorage?: MediaStorage,
): Promise<ReturnType<typeof serve>> {
  const port = parsePort(source.PORT);
  const r2Endpoint = parseR2Endpoint(required(source, "R2_ENDPOINT"));
  const bucketName = required(source, "R2_BUCKET_NAME");
  const apiKey = required(source, "API_KEY");
  const signingSecret = required(source, "UPLOAD_SIGNING_SECRET");
  const allowedOrigins = required(source, "ALLOWED_ORIGINS");
  const publicBaseUrl = required(source, "PUBLIC_BASE_URL");
  const publicApiBaseUrl = required(source, "PUBLIC_API_BASE_URL");
  const accessKeyId = required(source, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = required(source, "AWS_SECRET_ACCESS_KEY");

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
