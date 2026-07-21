import { Hono } from "hono";

import { makeThumbnail } from "../codec";
import {
  CACHE_TTL_SECONDS,
  IMMUTABLE_CACHE_CONTROL,
  REMOTE_CACHE_CONTROL,
} from "../constants";
import { HttpError } from "../errors";
import { assertImageWithinLimits, inspectImage } from "../image-info";
import { fetchRemoteImage } from "../remote";
import {
  imageResponse,
  matchesEtag,
  notModified,
  originalKey,
  remoteRecordKey,
} from "../storage";
import type { AppEnv, RemoteImageRecord } from "../types";

const edgeCache = (caches as CacheStorage & { default: Cache }).default;

export const images = new Hono<AppEnv>();

async function cachedResponse(request: Request): Promise<Response | undefined> {
  const response = await edgeCache.match(new Request(request.url, { method: "GET" }));
  if (!response) return undefined;
  const etag = response.headers.get("ETag");
  return etag && matchesEtag(request, etag)
    ? notModified(etag, !response.headers.get("Cache-Control")?.includes("immutable"))
    : response;
}

function responseFromR2(request: Request, object: R2ObjectBody, remote: boolean): Response {
  return matchesEtag(request, object.httpEtag)
    ? notModified(object.httpEtag, remote)
    : imageResponse(object.body, object.httpEtag, remote);
}

images.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (id.startsWith("r_")) {
    throw new HttpError(404, "variant_not_found", "remote original is not available");
  }
  if (!/^u_[0-9a-f-]{36}$/.test(id)) {
    throw new HttpError(404, "image_not_found", "image not found");
  }

  const hit = await cachedResponse(c.req.raw);
  if (hit) return hit;
  const object = await c.env.MEDIA.get(originalKey(id));
  if (!object || !("body" in object)) {
    throw new HttpError(404, "image_not_found", "image not found");
  }
  const response = responseFromR2(c.req.raw, object, false);
  if (response.status === 200) {
    c.executionCtx.waitUntil(
      edgeCache.put(new Request(c.req.url, { method: "GET" }), response.clone()),
    );
  }
  return response;
});

images.get("/:id/thumbnail", async (c) => {
  const id = c.req.param("id");
  if (!/^[ur]_[0-9a-f-]{36}$/.test(id)) {
    throw new HttpError(404, "image_not_found", "image not found");
  }

  const hit = await cachedResponse(c.req.raw);
  if (hit) return hit;
  const remote = id.startsWith("r_");
  const key = remote ? `cache/remote/${id}/800.webp` : `cache/upload/${id}/800.webp`;
  const cachedObject = await c.env.MEDIA.get(key);
  if (
    cachedObject &&
    "body" in cachedObject &&
    (!remote || Date.now() - cachedObject.uploaded.getTime() < CACHE_TTL_SECONDS * 1000)
  ) {
    const response = responseFromR2(c.req.raw, cachedObject, remote);
    if (response.status === 200) {
      c.executionCtx.waitUntil(
        edgeCache.put(new Request(c.req.url, { method: "GET" }), response.clone()),
      );
    }
    return response;
  }

  let source: ArrayBuffer;
  let sourceFormat: "jpeg" | "png" | "webp";
  if (remote) {
    const record = await c.env.REMOTE_IMAGES.get<RemoteImageRecord>(
      remoteRecordKey(id),
      "json",
    );
    if (!record) throw new HttpError(404, "image_not_found", "image not found");
    try {
      source = await fetchRemoteImage(record.url, record.maxBytes);
      const info = inspectImage(source);
      assertImageWithinLimits(info.width, info.height, record);
      sourceFormat = info.format;
    } catch (error) {
      if (error instanceof HttpError && error.status !== 504) {
        throw new HttpError(502, "invalid_remote_image", error.message);
      }
      throw error;
    }
  } else {
    const original = await c.env.MEDIA.get(originalKey(id));
    if (!original || !("body" in original)) {
      throw new HttpError(404, "image_not_found", "image not found");
    }
    source = await original.arrayBuffer();
    sourceFormat = "webp";
  }

  const transformStarted = Date.now();
  const thumbnail = await makeThumbnail(source, sourceFormat);
  console.log(
    JSON.stringify({
      event: "image_transform",
      sourceKind: remote ? "remote_thumbnail" : "upload_thumbnail",
      sourceFormat,
      inputBytes: source.byteLength,
      outputBytes: thumbnail.bytes.byteLength,
      width: thumbnail.width,
      height: thumbnail.height,
      durationMs: Date.now() - transformStarted,
    }),
  );
  const putOptions: R2PutOptions = {
    onlyIf:
      remote && cachedObject
        ? new Headers({ "If-Match": cachedObject.httpEtag })
        : new Headers({ "If-None-Match": "*" }),
    httpMetadata: {
      contentType: "image/webp",
      cacheControl: remote ? REMOTE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL,
    },
    customMetadata: {
      width: String(thumbnail.width),
      height: String(thumbnail.height),
    },
  };
  let stored: R2Object | null = await c.env.MEDIA.put(key, thumbnail.bytes, putOptions);
  if (!stored && remote && cachedObject && !(await c.env.MEDIA.head(key))) {
    stored = await c.env.MEDIA.put(key, thumbnail.bytes, {
      ...putOptions,
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
  }

  let response: Response;
  if (stored) {
    response = imageResponse(thumbnail.bytes, stored.httpEtag, remote);
  } else {
    const winner = await c.env.MEDIA.get(key);
    if (!winner || !("body" in winner)) {
      throw new HttpError(
        503,
        "storage_race",
        "stored image was temporarily unavailable",
      );
    }
    response = responseFromR2(c.req.raw, winner, remote);
  }
  if (response.status === 200) {
    c.executionCtx.waitUntil(
      edgeCache.put(new Request(c.req.url, { method: "GET" }), response.clone()),
    );
  }
  return response;
});
