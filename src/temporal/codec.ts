import { once } from "node:events";
import sharp from "sharp";
import { rgbaToThumbHash } from "thumbhash";

import { MAX_PIXELS, WEBP_QUALITY } from "../constants";
import { HttpError } from "../errors";

export async function transcodeUploadImage(
  buffer: ArrayBuffer,
): Promise<{
  stream: ReturnType<typeof sharp>;
  size: number;
  width: number;
  height: number;
  thumbhash: string;
}> {
  let stream: ReturnType<typeof sharp> | undefined;
  try {
    const decoded = await sharp(Buffer.from(buffer), { limitInputPixels: MAX_PIXELS })
      .rotate()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const raw = { width: decoded.info.width, height: decoded.info.height, channels: 4 as const };
    const thumbnail = await sharp(decoded.data, { raw })
      .resize({ width: 100, height: 100, fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const thumbhash = Buffer.from(
      rgbaToThumbHash(thumbnail.info.width, thumbnail.info.height, thumbnail.data),
    ).toString("base64");

    stream = sharp(decoded.data, { raw }).webp({
      quality: WEBP_QUALITY,
      alphaQuality: 100,
      effort: 4,
    });
    const infoPromise = once(stream, "info");
    // Start processing without putting the readable side into flowing mode.
    stream.read(0);
    const [info] = (await infoPromise) as [sharp.OutputInfo];
    return { stream, size: info.size, width: info.width, height: info.height, thumbhash };
  } catch (error) {
    stream?.destroy();
    throw new HttpError(
      422,
      "invalid_image",
      error instanceof Error
        ? `image processing failed: ${error.message}`
        : "image processing failed",
    );
  }
}
