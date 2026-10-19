import { createMiddleware } from "hono/factory";

import { HttpError } from "../errors";
import type { AppEnv, Env } from "../types";

export function assertConfig(env: Env): void {
  const origins = env.ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const validOrigins = origins?.every((origin) => {
    try {
      return new URL(origin).origin === origin;
    } catch {
      return false;
    }
  });
  let validPublicBaseUrl = false;
  try {
    validPublicBaseUrl = new URL(env.PUBLIC_BASE_URL).origin === env.PUBLIC_BASE_URL;
  } catch {
    // Handled by the fail-closed check below.
  }
  let validPublicApiBaseUrl = true;
  if (env.PUBLIC_API_BASE_URL !== undefined) {
    try {
      const publicApiBaseUrl = new URL(env.PUBLIC_API_BASE_URL);
      validPublicApiBaseUrl =
        (publicApiBaseUrl.protocol === "http:" || publicApiBaseUrl.protocol === "https:") &&
        publicApiBaseUrl.origin === env.PUBLIC_API_BASE_URL;
    } catch {
      validPublicApiBaseUrl = false;
    }
  }
  if (
    !env.API_KEY ||
    !env.UPLOAD_SIGNING_SECRET ||
    env.UPLOAD_SIGNING_SECRET.length < 32 ||
    !validOrigins ||
    origins.length === 0 ||
    !validPublicBaseUrl ||
    !validPublicApiBaseUrl ||
    typeof env.MEDIA?.head !== "function" ||
    typeof env.MEDIA?.put !== "function"
  ) {
    throw new HttpError(500, "configuration_error", "service configuration is incomplete");
  }
}

export const requireConfig = createMiddleware<AppEnv>(async (c, next) => {
  assertConfig(c.env);
  await next();
});
