import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import decodePng, { init as initPngDecode } from "@jsquash/png/decode.js";
import resize, { initResize } from "@jsquash/resize";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";
import { rgbaToThumbHash } from "thumbhash";

import jpegDecodeWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
// @ts-expect-error Wrangler exposes imported Wasm files as default WebAssembly.Module values.
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
// @ts-expect-error Wrangler exposes imported Wasm files as default WebAssembly.Module values.
import resizeWasm from "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm";
import webpDecodeWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import webpEncodeWasm from "@jsquash/webp/codec/enc/webp_enc_simd.wasm";

import { WEBP_QUALITY } from "./constants";
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
  initResize(resizeWasm),
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

export async function makeThumbHash(image: ImageData): Promise<string> {
  await ready;
  const scale = Math.min(1, 100 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  try {
    const input =
      width === image.width && height === image.height
        ? image
        : await resize(image, {
            width,
            height,
            method: "lanczos3",
            fitMethod: "stretch",
            premultiply: true,
            linearRGB: true,
          });
    const hash = rgbaToThumbHash(width, height, input.data);
    return btoa(String.fromCharCode(...hash));
  } catch (error) {
    throw new HttpError(
      422,
      "encoding_failed",
      error instanceof Error
        ? `ThumbHash encoding failed: ${error.message}`
        : "ThumbHash encoding failed",
    );
  }
}

export async function transcodeOriginal(
  buffer: ArrayBuffer,
  format: ImageFormat,
): Promise<{ bytes: ArrayBuffer; width: number; height: number; thumbhash: string }> {
  const image = await decode(buffer, format);
  const [bytes, thumbhash] = await Promise.all([encode(image), makeThumbHash(image)]);
  return { bytes, width: image.width, height: image.height, thumbhash };
}
