import { MAX_PIXELS } from "./constants";
import { HttpError } from "./errors";
import type { ImageInfo, Limits } from "./types";

function parsePng(bytes: Uint8Array): ImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const chunkLength = view.getUint32(offset);
    const chunkType = ascii(bytes, offset + 4, 4);
    if (chunkType === "acTL") {
      throw new HttpError(415, "unsupported_image", "animated PNG is not supported");
    }
    if (chunkType === "IDAT" || chunkType === "IEND") break;
    offset += 12 + chunkLength;
  }
  return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
}

function parseJpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new HttpError(422, "invalid_image", "invalid JPEG marker");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) {
      throw new HttpError(422, "invalid_image", "invalid JPEG segment");
    }
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (length < 7) throw new HttpError(422, "invalid_image", "invalid JPEG frame");
      return {
        format: "jpeg",
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5),
      };
    }
    offset += length;
  }
  throw new HttpError(422, "invalid_image", "JPEG dimensions not found");
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function parseWebp(bytes: Uint8Array): ImageInfo | null {
  if (
    bytes.length < 21 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = ascii(bytes, 12, 4);
  if (kind === "VP8X") {
    if (bytes.length < 30) throw new HttpError(422, "invalid_image", "truncated WebP header");
    if ((bytes[20]! & 0x02) !== 0) {
      throw new HttpError(415, "unsupported_image", "animated WebP is not supported");
    }
    const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
    const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    return { format: "webp", width, height };
  }
  if (kind === "VP8 ") {
    if (bytes.length < 30) throw new HttpError(422, "invalid_image", "truncated WebP header");
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new HttpError(422, "invalid_image", "invalid lossy WebP frame");
    }
    return {
      format: "webp",
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (kind === "VP8L") {
    if (bytes.length < 25) throw new HttpError(422, "invalid_image", "truncated WebP header");
    if (bytes[20] !== 0x2f) throw new HttpError(422, "invalid_image", "invalid lossless WebP frame");
    const bits = view.getUint32(21, true);
    return {
      format: "webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  throw new HttpError(415, "unsupported_image", "unsupported animated or malformed WebP");
}

export function inspectImage(buffer: ArrayBuffer): ImageInfo {
  const bytes = new Uint8Array(buffer);
  const info = parsePng(bytes) ?? parseJpeg(bytes) ?? parseWebp(bytes);
  if (!info) throw new HttpError(415, "unsupported_image", "only JPEG, PNG, and WebP are supported");
  if (info.width <= 0 || info.height <= 0) {
    throw new HttpError(422, "invalid_image", "invalid image dimensions");
  }
  return info;
}

export function assertImageWithinLimits(
  width: number,
  height: number,
  limits: Limits,
): void {
  if (Math.max(width, height) > limits.maxDimension) {
    throw new HttpError(
      422,
      "dimension_limit_exceeded",
      `image dimensions exceed maxDimension ${limits.maxDimension}`,
    );
  }
  if (width * height > MAX_PIXELS) {
    throw new HttpError(422, "pixel_limit_exceeded", `image exceeds ${MAX_PIXELS} pixels`);
  }
}
