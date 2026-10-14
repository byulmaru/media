import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import decodePng, { init as initPngDecode } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";

import jpegDecodeWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
// @ts-expect-error Wrangler exposes imported Wasm files as default WebAssembly.Module values.
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import webpDecodeWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import webpEncodeWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";

import {
  MAX_REMOTE_AVATAR_BYTES,
  REMOTE_AVATAR_MAX_EDGE,
  WEBP_QUALITY,
} from "./constants";
import { HttpError } from "./errors";
import type { ImageFormat } from "./types";

type ImageDataConstructor = new (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => ImageData;

if (!(globalThis as unknown as { ImageData?: ImageDataConstructor }).ImageData) {
  (globalThis as unknown as { ImageData: ImageDataConstructor }).ImageData = class ImageDataPolyfill {
    readonly colorSpace = "srgb" as PredefinedColorSpace;
    constructor(
      public readonly data: Uint8ClampedArray,
      public readonly width: number,
      public readonly height: number,
    ) {}
  } as unknown as ImageDataConstructor;
}

const ready = Promise.all([
  (initJpegDecode as unknown as (module: WebAssembly.Module) => Promise<void>)(jpegDecodeWasm),
  initPngDecode(pngWasm),
  (initWebpDecode as unknown as (module: WebAssembly.Module) => Promise<void>)(webpDecodeWasm),
  (initWebpEncode as unknown as (module: WebAssembly.Module) => Promise<void>)(webpEncodeWasm),
]);

async function decode(buffer: ArrayBuffer, format: ImageFormat): Promise<ImageData> {
  await ready;
  try {
    switch (format) {
      case "jpeg":
        return await decodeJpeg(buffer, { preserveOrientation: true });
      case "png":
        return await decodePng(buffer);
      case "webp":
        return await decodeWebp(buffer);
    }
  } catch (error) {
    throw new HttpError(
      422,
      "invalid_image",
      error instanceof Error ? `image decode failed: ${error.message}` : "image decode failed",
    );
  }
}

async function encode(image: ImageData): Promise<ArrayBuffer> {
  await ready;
  try {
    return await encodeWebp(image, {
      quality: WEBP_QUALITY,
      method: 4,
      alpha_quality: 100,
      thread_level: 0,
    });
  } catch (error) {
    throw new HttpError(
      422,
      "encoding_failed",
      error instanceof Error ? `WebP encode failed: ${error.message}` : "WebP encode failed",
    );
  }
}

function resizeToMaxEdge(image: ImageData, maxEdge: number): ImageData {
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  if (scale === 1) return image;

  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  const source = image.data;

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, (y + 0.5) * image.height / height - 0.5);
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, (x + 0.5) * image.width / width - 0.5);
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const outputOffset = (y * width + x) * 4;
      const topLeft = (y0 * image.width + x0) * 4;
      const topRight = (y0 * image.width + x1) * 4;
      const bottomLeft = (y1 * image.width + x0) * 4;
      const bottomRight = (y1 * image.width + x1) * 4;
      // Premultiply colors so hidden RGB cannot darken transparent edges.
      const topLeftAlpha = source[topLeft + 3]! * (1 - xWeight) * (1 - yWeight);
      const topRightAlpha = source[topRight + 3]! * xWeight * (1 - yWeight);
      const bottomLeftAlpha = source[bottomLeft + 3]! * (1 - xWeight) * yWeight;
      const bottomRightAlpha = source[bottomRight + 3]! * xWeight * yWeight;
      const alpha = topLeftAlpha + topRightAlpha + bottomLeftAlpha + bottomRightAlpha;
      data[outputOffset + 3] = alpha;
      for (let channel = 0; channel < 3; channel += 1) {
        const color = source[topLeft + channel]! * topLeftAlpha
          + source[topRight + channel]! * topRightAlpha
          + source[bottomLeft + channel]! * bottomLeftAlpha
          + source[bottomRight + channel]! * bottomRightAlpha;
        data[outputOffset + channel] = alpha === 0 ? 0 : color / alpha;
      }
    }
  }

  return new ImageData(data, width, height);
}

export async function transcodeOriginal(
  buffer: ArrayBuffer,
  format: ImageFormat,
): Promise<{ bytes: ArrayBuffer; width: number; height: number }> {
  const image = await decode(buffer, format);
  return { bytes: await encode(image), width: image.width, height: image.height };
}

export async function transcodeAvatar(
  buffer: ArrayBuffer,
  format: ImageFormat,
): Promise<{ bytes: ArrayBuffer; width: number; height: number }> {
  const image = resizeToMaxEdge(await decode(buffer, format), REMOTE_AVATAR_MAX_EDGE);
  const bytes = await encode(image);
  if (bytes.byteLength > MAX_REMOTE_AVATAR_BYTES) {
    throw new HttpError(
      413,
      "size_limit_exceeded",
      `avatar exceeds ${MAX_REMOTE_AVATAR_BYTES} bytes`,
    );
  }
  return { bytes, width: image.width, height: image.height };
}
