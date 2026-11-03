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
  let input: ReturnType<typeof sharp> | undefined;
  let stream: ReturnType<typeof sharp> | undefined;
  let thumbnail: ReturnType<typeof sharp> | undefined;
  try {
    input = sharp(Buffer.from(buffer), { limitInputPixels: MAX_PIXELS })
      .rotate()
      .toColourspace("srgb")
      .ensureAlpha();
    stream = input.clone().webp({
      quality: WEBP_QUALITY,
      alphaQuality: 100,
      effort: 4,
    });
    thumbnail = input.clone()
      .resize({ width: 100, height: 100, fit: "inside", withoutEnlargement: true })
      .raw();

    const infoPromise = once(stream, "info");
    const thumbhashPromise = thumbnail.toBuffer({ resolveWithObject: true }).then(({ data, info }) =>
      Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString("base64"),
    );
    // Start processing without putting the readable side into flowing mode.
    stream.read(0);
    const [infoEvents, thumbhash] = await Promise.all([infoPromise, thumbhashPromise]);
    const [info] = infoEvents as [sharp.OutputInfo];
    return { stream, size: info.size, width: info.width, height: info.height, thumbhash };
  } catch (error) {
    stream?.destroy();
    thumbnail?.destroy();
    input?.destroy();
    throw new HttpError(
      422,
      "invalid_image",
      error instanceof Error
        ? `image processing failed: ${error.message}`
        : "image processing failed",
    );
  }
}
