import { createMiddleware } from "hono/factory";

import { HttpError } from "../errors";
import type { AppEnv } from "../types";

const encoder = new TextEncoder();

export const apiKeyAuth = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ") || !c.env.API_KEY) {
    throw new HttpError(401, "unauthorized", "valid bearer API key required");
  }

  const [supplied, expected] = await Promise.all([
    crypto.subtle
      .digest("SHA-256", encoder.encode(authorization.slice("Bearer ".length)))
      .then((hash) => new Uint8Array(hash)),
    crypto.subtle
      .digest("SHA-256", encoder.encode(c.env.API_KEY))
      .then((hash) => new Uint8Array(hash)),
  ]);
  let difference = supplied.length ^ expected.length;
  for (let index = 0; index < Math.max(supplied.length, expected.length); index += 1) {
    difference |= (supplied[index] ?? 0) ^ (expected[index] ?? 0);
  }
  if (difference !== 0) {
    throw new HttpError(401, "unauthorized", "valid bearer API key required");
  }

  await next();
});
