import { createMiddleware } from "hono/factory";

import { HttpError } from "../errors";
import type { AppEnv, Env } from "../types";
import { runtimeConfigSchema } from "../validation";

export function assertConfig(env: Env): void {
  if (!runtimeConfigSchema.safeParse(env).success) {
    throw new HttpError(500, "configuration_error", "service configuration is incomplete");
  }
}

export const requireConfig = createMiddleware<AppEnv>(async (c, next) => {
  assertConfig(c.env);
  await next();
});
