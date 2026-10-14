import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { readBodyLimited } from "../body";
import { transcodeAvatar } from "../codec";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DIMENSION,
  IMMUTABLE_CACHE_CONTROL,
  REMOTE_AVATAR_VARIANT,
  REMOTE_FETCH_TIMEOUT_MS,
} from "../constants";
import { HttpError } from "../errors";
import { assertImageWithinLimits, inspectImage } from "../image-info";
import { apiKeyAuth } from "../middleware/auth";
import type { AppEnv } from "../types";
import { remoteAvatarRequestSchema, throwOnValidationError } from "../validation";

const remoteImageAccept = "image/jpeg,image/png,image/webp";
const remoteAvatarPrefix = "remote-avatar";

export const remoteAvatars = new Hono<AppEnv>();

function canonicalizeRemoteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "invalid_url", "remote URL is invalid");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  const isIpv6 = hostname.startsWith("[") && hostname.endsWith("]");
  const isLocalName =
    hostname === "localhost" ||
    !hostname.includes(".") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal");

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hostname ||
    isIpv4 ||
    isIpv6 ||
    isLocalName
  ) {
    throw new HttpError(400, "invalid_url", "remote URL must be a public HTTPS URL");
  }

  url.hostname = hostname;
  url.hash = "";
  return url.href;
}

async function hashUrl(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function remoteAvatarKey(hash: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${remoteAvatarPrefix}/${hash}-${day}-${REMOTE_AVATAR_VARIANT}.webp`;
}

async function fetchAndTranscode(url: string): Promise<ArrayBuffer> {
  const controller = new AbortController();
  let timedOut = false;
  let response: Response | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REMOTE_FETCH_TIMEOUT_MS);

  try {
    response = await fetch(url, {
      headers: { Accept: remoteImageAccept },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new HttpError(502, "remote_fetch_failed", "remote image fetch failed");
    }

    const input = await readBodyLimited(response, DEFAULT_MAX_BYTES);
    const info = inspectImage(input);
    assertImageWithinLimits(info.width, info.height, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxDimension: DEFAULT_MAX_DIMENSION,
    });
    const output = await transcodeAvatar(input, info.format);
    return output.bytes;
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      timedOut ? 504 : 502,
      timedOut ? "remote_fetch_timeout" : "remote_fetch_failed",
      timedOut ? "remote image fetch timed out" : "remote image fetch failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

remoteAvatars.post(
  "/",
  apiKeyAuth,
  zValidator("json", remoteAvatarRequestSchema, throwOnValidationError),
  async (c) => {
    const canonicalUrl = canonicalizeRemoteUrl(c.req.valid("json").url);
    const hash = await hashUrl(canonicalUrl);
    const key = remoteAvatarKey(hash);
    const publicUrl = `${c.env.PUBLIC_BASE_URL}/${key}`;

    if (await c.env.MEDIA.head(key)) {
      return c.json({ url: publicUrl, mediaType: "image/webp" }, 200);
    }

    const bytes = await fetchAndTranscode(canonicalUrl);
    const stored = await c.env.MEDIA.put(key, bytes, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: {
        contentType: "image/webp",
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      },
    });
    if (!stored) {
      if (await c.env.MEDIA.head(key)) {
        return c.json({ url: publicUrl, mediaType: "image/webp" }, 200);
      }
      throw new HttpError(500, "storage_failed", "remote avatar was not stored");
    }
    return c.json({ url: publicUrl, mediaType: "image/webp" }, 201);
  },
);
