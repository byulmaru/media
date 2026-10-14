export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_DIMENSION = 8192;
export const MAX_PIXELS = 16 * 1024 * 1024;
export const UPLOAD_TOKEN_TTL_SECONDS = 10 * 60;
export const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
export const WEBP_QUALITY = 80;
export const REMOTE_FETCH_TIMEOUT_MS = 3_000;
export const REMOTE_AVATAR_MAX_EDGE = 400;
export const MAX_REMOTE_AVATAR_BYTES = 512 * 1024;
export const REMOTE_AVATAR_VARIANT = "avatar-v1";

export const IMMUTABLE_CACHE_CONTROL =
  `public, max-age=${CACHE_TTL_SECONDS}, immutable`;
