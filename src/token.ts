import { HttpError } from "./errors";
import type { UploadTokenPayload } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new HttpError(401, "invalid_upload_token", "invalid upload token");
  }
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function signUploadToken(
  payload: UploadTokenPayload,
  secret: string,
): Promise<string> {
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${encodedPayload}.${base64UrlEncode(await hmac(secret, encodedPayload))}`;
}

export async function verifyUploadToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<UploadTokenPayload> {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined || !secret) {
    throw new HttpError(401, "invalid_upload_token", "invalid upload token");
  }
  const expected = await hmac(secret, encodedPayload);
  const supplied = base64UrlDecode(encodedSignature);
  if (expected.length !== supplied.length) {
    throw new HttpError(401, "invalid_upload_token", "invalid upload token");
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index]! ^ supplied[index]!;
  }
  if (difference !== 0) {
    throw new HttpError(401, "invalid_upload_token", "invalid upload token");
  }

  let payload: UploadTokenPayload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(encodedPayload))) as UploadTokenPayload;
  } catch {
    throw new HttpError(401, "invalid_upload_token", "invalid upload token");
  }
  if (
    payload.version !== 1 ||
    !/^u_[0-9a-f-]{36}$/.test(payload.id) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    !Number.isSafeInteger(payload.maxBytes) ||
    !Number.isSafeInteger(payload.maxDimension)
  ) {
    throw new HttpError(401, "invalid_upload_token", "invalid upload token");
  }
  if (payload.expiresAt * 1000 <= now) {
    throw new HttpError(410, "upload_token_expired", "upload token expired");
  }
  return payload;
}
