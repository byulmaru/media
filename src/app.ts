import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { HttpError } from "./errors";
import { requireConfig } from "./middleware/config";
import { images } from "./routes/images";
import { remotes } from "./routes/remotes";
import { uploads } from "./routes/uploads";
import type { AppEnv } from "./types";

export const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
  const started = Date.now();
  c.header("X-Request-Id", requestId);
  try {
    await next();
  } finally {
    console.log(
      JSON.stringify({
        requestId,
        method: c.req.method,
        route: c.req.routePath || "unmatched",
        status: c.res.status,
        durationMs: Date.now() - started,
      }),
    );
  }
});

app.use("*", requireConfig);

app.route("/v1/uploads", uploads);
app.route("/v1/remotes", remotes);
app.route("/images", images);

app.notFound((c) => c.json({ error: { code: "not_found", message: "route not found" } }, 404));

app.onError((error, c) => {
  const httpError = error instanceof HttpError
    ? error
    : error instanceof HTTPException
      ? new HttpError(error.status, "invalid_request", error.message)
      : new HttpError(500, "internal_error", "internal server error");
  if (!(error instanceof HttpError) && !(error instanceof HTTPException)) console.error(error);
  const response = c.json(
    { error: { code: httpError.code, message: httpError.message } },
    httpError.status as 400,
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
});
