import sharp from "sharp";

import { MAX_PIXELS, WEBP_QUALITY } from "../constants";
import { HttpError } from "../errors";

export async function transcodeUploadImage(
  buffer: ArrayBuffer,
): Promise<{ bytes: ArrayBuffer; width: number; height: number }> {
  let decoded;
  try {
    decoded = await sharp(Buffer.from(buffer), { limitInputPixels: MAX_PIXELS })
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new HttpError(
      422,
      "invalid_image",
      error instanceof Error ? `image decode failed: ${error.message}` : "image decode failed",
    );
  }

  let output;
  try {
    output = await sharp(decoded.data, {
      raw: {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: decoded.info.channels,
      },
    })
      .webp({ quality: WEBP_QUALITY, alphaQuality: 100, effort: 4 })
      .toBuffer();
  } catch (error) {
    throw new HttpError(
      422,
      "encoding_failed",
      error instanceof Error ? `WebP encode failed: ${error.message}` : "WebP encode failed",
    );
  }

  return {
    bytes: Uint8Array.from(output).buffer,
    width: decoded.info.width,
    height: decoded.info.height,
  };
}
