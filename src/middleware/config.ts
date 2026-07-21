import { createMiddleware } from "hono/factory";

import { HttpError } from "../errors";
import type { AppEnv } from "../types";

export const requireConfig = createMiddleware<AppEnv>(async (c, next) => {
  const origins = c.env.ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const validOrigins = origins?.every((origin) => {
    try {
      return new URL(origin).origin === origin;
    } catch {
      return false;
    }
  });
  if (
    !c.env.API_KEY ||
    !c.env.UPLOAD_SIGNING_SECRET ||
    c.env.UPLOAD_SIGNING_SECRET.length < 32 ||
    !validOrigins ||
    origins.length === 0 ||
    typeof c.env.MEDIA?.get !== "function" ||
    typeof c.env.MEDIA?.head !== "function" ||
    typeof c.env.MEDIA?.put !== "function" ||
    typeof c.env.REMOTE_IMAGES?.get !== "function" ||
    typeof c.env.REMOTE_IMAGES?.put !== "function"
  ) {
    throw new HttpError(500, "configuration_error", "service configuration is incomplete");
  }
  await next();
});
