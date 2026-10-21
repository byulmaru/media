import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { readBodyLimited } from "../body";
import { transcodeOriginal } from "../codec";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DIMENSION,
  IMMUTABLE_CACHE_CONTROL,
  UPLOAD_TOKEN_TTL_SECONDS,
} from "../constants";
import { HttpError } from "../errors";
import { validateImageUpload } from "../image-info";
import { apiKeyAuth } from "../middleware/auth";
import { signUploadToken, verifyUploadToken } from "../token";
import type { AppEnv } from "../types";
import {
  throwOnValidationError,
  uploadIdParamSchema,
  uploadRequestSchema,
} from "../validation";

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
    const request = c.req.valid("json");
    if ("staging" in request && !c.env.STAGING) {
      throw new HttpError(
        503,
        "staging_storage_unavailable",
        "private upload storage is unavailable",
      );
    }
    const limits = "staging" in request
      ? { maxBytes: DEFAULT_MAX_BYTES, maxDimension: DEFAULT_MAX_DIMENSION }
      : request;
    const id = `u_${crypto.randomUUID()}`;
    const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
    const token = await signUploadToken(
      {
        version: "staging" in request ? 2 : 1,
        id,
        expiresAt,
        maxBytes: limits.maxBytes,
        maxDimension: limits.maxDimension,
      },
      c.env.UPLOAD_SIGNING_SECRET,
    );
    return c.json(
      {
        id,
        uploadUrl: new URL(
          `/v1/uploads/${token}`,
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
    if (c.req.query("staging") === "true") {
      c.header("Cache-Control", "no-store");
      if (c.req.method !== "HEAD") {
        c.header("Allow", "HEAD");
        return c.body(null, 405);
      }
      if (!c.env.STAGING) {
        throw new HttpError(
          503,
          "staging_storage_unavailable",
          "private upload storage is unavailable",
        );
      }

      const object = await c.env.STAGING.head(`uploads/${id}/${id.slice(2)}`);
      if (!object) return c.body(null, 404);

      const size = object.size;
      if (size !== undefined && Number.isSafeInteger(size) && size >= 0) {
        c.header("Content-Length", String(size));
      }
      const contentType = object.httpMetadata?.contentType;
      let safeContentType: string | undefined;
      if (typeof contentType === "string" && contentType.trim()) {
        try {
          new Headers({ "Content-Type": contentType });
          safeContentType = contentType;
        } catch {
          // Omit unusable metadata so Kosmo rejects the incomplete HEAD response.
        }
      }
      if (safeContentType) c.header("Content-Type", safeContentType);
      if (object.uploaded instanceof Date && Number.isFinite(object.uploaded.getTime())) {
        c.header("Last-Modified", object.uploaded.toUTCString());
      }
      return c.body(null, 200);
    }

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
  const uploadStorage = payload.version === 2 ? c.env.STAGING : c.env.MEDIA;
  if (!uploadStorage) {
    throw new HttpError(
      503,
      "staging_storage_unavailable",
      "private upload storage is unavailable",
    );
  }
  if (await c.env.MEDIA.head(key)) {
    throw new HttpError(409, "already_uploaded", "upload URL has already been used");
  }
  const sourceKey = `uploads/${payload.id}/${payload.id.slice(2)}`;
  if (payload.version === 2 && await uploadStorage.head(sourceKey)) {
    throw new HttpError(409, "already_uploaded", "upload URL has already been used");
  }

  const contentType = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !acceptedContentTypes.has(contentType)) {
    throw new HttpError(415, "unsupported_image", "Content-Type must be JPEG, PNG, or WebP");
  }

  const input = await readBodyLimited(c.req.raw, payload.maxBytes);
  if (payload.version === 2) {
    const stored = await uploadStorage.put(sourceKey, input, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType },
    });
    if (!stored) throw new HttpError(409, "already_uploaded", "upload URL has already been used");
    return c.json({ id: payload.id }, 201);
  }

  const info = validateImageUpload(input, contentType, payload);

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
  });
  if (!stored) throw new HttpError(409, "already_uploaded", "upload URL has already been used");
  return c.json({ id: payload.id, url: `${c.env.PUBLIC_BASE_URL}/${key}` }, 201);
});
