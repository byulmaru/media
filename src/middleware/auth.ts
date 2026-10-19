import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "hono/utils/buffer";

import { HttpError } from "../errors";
import type { AppEnv } from "../types";

export const apiKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ") || !c.env.API_KEY) {
    throw new HttpError(401, "unauthorized", "valid bearer API key required");
  }

  if (!(await timingSafeEqual(authorization.slice("Bearer ".length), c.env.API_KEY))) {
    throw new HttpError(401, "unauthorized", "valid bearer API key required");
  }

  await next();
});
