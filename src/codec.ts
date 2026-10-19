import decodeJpeg, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import decodePng, { init as initPngDecode } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebpDecode } from "@jsquash/webp/decode.js";
import encodeWebp, { init as initWebpEncode } from "@jsquash/webp/encode.js";

import { WEBP_QUALITY } from "./constants";
import { HttpError } from "./errors";
import type { ImageFormat } from "./types";

export interface CodecWasmModules {
  jpegDecode: WebAssembly.Module;
  pngDecode: WebAssembly.Module;
  webpDecode: WebAssembly.Module;
  webpEncode: WebAssembly.Module;
}

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

let ready: Promise<void> | undefined;

export function initializeCodec(modules: CodecWasmModules): Promise<void> {
  if (!ready) {
    ready = Promise.all([
      (initJpegDecode as unknown as (module: WebAssembly.Module) => Promise<void>)(
        modules.jpegDecode,
      ),
      initPngDecode(modules.pngDecode),
      (initWebpDecode as unknown as (module: WebAssembly.Module) => Promise<void>)(
        modules.webpDecode,
      ),
      (initWebpEncode as unknown as (module: WebAssembly.Module) => Promise<void>)(
        modules.webpEncode,
      ),
    ]).then(() => undefined);
  }
  return ready;
}

function codecReady(): Promise<void> {
  if (!ready) throw new Error("image codec has not been initialized");
  return ready;
}

async function decode(buffer: ArrayBuffer, format: ImageFormat): Promise<ImageData> {
  await codecReady();
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
  await codecReady();
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

export async function transcodeOriginal(
  buffer: ArrayBuffer,
  format: ImageFormat,
): Promise<{ bytes: ArrayBuffer; width: number; height: number }> {
  const image = await decode(buffer, format);
  return { bytes: await encode(image), width: image.width, height: image.height };
}
