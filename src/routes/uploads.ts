import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { readBodyLimited } from "../body";
import { transcodeOriginal } from "../codec";
import { IMMUTABLE_CACHE_CONTROL, UPLOAD_TOKEN_TTL_SECONDS } from "../constants";
import { HttpError } from "../errors";
import { assertImageWithinLimits, inspectImage } from "../image-info";
import { apiKeyAuth } from "../middleware/auth";
import { signUploadToken, verifyUploadToken } from "../token";
import type { AppEnv } from "../types";
import { throwOnValidationError, uploadRequestSchema } from "../validation";

const acceptedContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export const uploads = new Hono<AppEnv>();

uploads.use("/:token", async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed =
    origin &&
    c.env.ALLOWED_ORIGINS.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .includes(origin);
  if (origin && !allowed) {
    throw new HttpError(403, "origin_not_allowed", "origin is not allowed to upload");
  }
  if (c.req.method === "OPTIONS" && !origin) {
    throw new HttpError(400, "missing_origin", "CORS preflight requires Origin");
  }

  await next();
  if (origin) {
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.set("Access-Control-Allow-Methods", "PUT, OPTIONS");
    c.res.headers.set("Access-Control-Allow-Headers", "Content-Type");
    c.res.headers.set("Access-Control-Max-Age", "600");
    c.res.headers.append("Vary", "Origin");
  }
});

uploads.options("/:token", (c) => c.body(null, 204));

uploads.post(
  "/",
  apiKeyAuth,
  zValidator("json", uploadRequestSchema, throwOnValidationError),
  async (c) => {
    const limits = c.req.valid("json");
    const id = `u_${crypto.randomUUID()}`;
    const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
    const token = await signUploadToken(
      { version: 1, id, expiresAt, ...limits },
      c.env.UPLOAD_SIGNING_SECRET,
    );
    return c.json(
      {
        id,
        uploadUrl: new URL(`/v1/uploads/${token}`, c.req.url).href,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
      },
      201,
    );
  },
);

uploads.put("/:token", async (c) => {
  const payload = await verifyUploadToken(c.req.param("token"), c.env.UPLOAD_SIGNING_SECRET);
  const key = `original/${payload.id}.webp`;
  if (await c.env.MEDIA.head(key)) {
    throw new HttpError(409, "already_uploaded", "upload URL has already been used");
  }

  const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !acceptedContentTypes.has(contentType)) {
    throw new HttpError(415, "unsupported_image", "Content-Type must be JPEG, PNG, or WebP");
  }

  const input = await readBodyLimited(c.req.raw, payload.maxBytes);
  const info = inspectImage(input);
  const expectedContentType = info.format === "jpeg" ? "image/jpeg" : `image/${info.format}`;
  if (contentType !== expectedContentType) {
    throw new HttpError(415, "content_type_mismatch", "Content-Type does not match image bytes");
  }
  assertImageWithinLimits(info.width, info.height, payload);

  const transformStarted = Date.now();
  const output = await transcodeOriginal(input, info.format);
  console.log(
    JSON.stringify({
      event: "image_transform",
      sourceKind: "upload",
      sourceFormat: info.format,
      inputBytes: input.byteLength,
      outputBytes: output.bytes.byteLength,
      width: output.width,
      height: output.height,
      durationMs: Date.now() - transformStarted,
    }),
  );
  const stored = await c.env.MEDIA.put(key, output.bytes, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: {
      contentType: "image/webp",
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    },
    customMetadata: {
      width: String(output.width),
      height: String(output.height),
      sourceFormat: info.format,
    },
  });
  if (!stored) throw new HttpError(409, "already_uploaded", "upload URL has already been used");
  return c.json({ id: payload.id, url: `${c.env.PUBLIC_BASE_URL}/${key}` }, 201);
});
