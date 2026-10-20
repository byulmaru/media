import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { readBodyLimited } from "../body";
import { UPLOAD_TOKEN_TTL_SECONDS } from "../constants";
import { HttpError } from "../errors";
import { assertImageWithinLimits, inspectImage } from "../image-info";
import { apiKeyAuth } from "../middleware/auth";
import { signUploadToken, verifyUploadToken } from "../token";
import type { UploadProcessor } from "../upload-processing";
import type { AppEnv } from "../types";
import {
  throwOnValidationError,
  uploadIdParamSchema,
  uploadRequestSchema,
} from "../validation";

const acceptedContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function createUploadsV2(processor?: UploadProcessor) {
  const uploads = new Hono<AppEnv>();

  uploads.use("*", async (c, next) => {
    if (!processor && c.req.method !== "OPTIONS") {
      throw new HttpError(503, "processing_unavailable", "upload processing is unavailable");
    }
    await next();
  });

  uploads.use("/:token", async (c, next) => {
    const origin = c.req.header("Origin");
    const allowed = origin && c.env.ALLOWED_ORIGINS
      .split(",")
      .map((value) => value.trim())
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
          uploadUrl: new URL(
            `/v2/uploads/${token}`,
            c.env.PUBLIC_API_BASE_URL ?? c.req.url,
          ).href,
          expiresAt: new Date(expiresAt * 1000).toISOString(),
        },
        201,
      );
    },
  );

  uploads.get(
    "/:id",
    apiKeyAuth,
    zValidator("param", uploadIdParamSchema, (result) => {
      if (!result.success) {
        throw new HttpError(
          400,
          "invalid_upload_id",
          result.error.issues[0]?.message ?? "upload ID is invalid",
        );
      }
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const key = `original/${id}.webp`;
      const object = await c.env.MEDIA.head(key);
      c.header("Cache-Control", "no-store");
      if (!object) return c.body(null, 404);
      if (c.req.method === "HEAD") return c.body(null, 204);

      const mediaType = object.httpMetadata?.contentType;
      if (!mediaType) {
        throw new HttpError(500, "invalid_media_metadata", "stored media has no Content-Type");
      }
      return c.json({ url: `${c.env.PUBLIC_BASE_URL}/${key}`, mediaType });
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

    const bytes = await readBodyLimited(c.req.raw, payload.maxBytes);
    const info = inspectImage(bytes);
    const expectedContentType = info.format === "jpeg" ? "image/jpeg" : `image/${info.format}`;
    if (contentType !== expectedContentType) {
      throw new HttpError(415, "content_type_mismatch", "Content-Type does not match image bytes");
    }
    assertImageWithinLimits(info.width, info.height, payload);

    await processor!({
      id: payload.id,
      bytes,
      contentType,
      limits: { maxBytes: payload.maxBytes, maxDimension: payload.maxDimension },
    });
    return c.json(
      { id: payload.id, url: `${c.env.PUBLIC_BASE_URL}/${key}` },
      201,
    );
  });

  return uploads;
}
