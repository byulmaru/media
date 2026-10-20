import { once } from "node:events";
import sharp from "sharp";

import { MAX_PIXELS, WEBP_QUALITY } from "../constants";
import { HttpError } from "../errors";

export async function transcodeUploadImage(
  buffer: ArrayBuffer,
): Promise<{
  stream: ReturnType<typeof sharp>;
  size: number;
  width: number;
  height: number;
}> {
  let stream: ReturnType<typeof sharp> | undefined;
  try {
    stream = sharp(Buffer.from(buffer), { limitInputPixels: MAX_PIXELS });
    stream.rotate().webp({ quality: WEBP_QUALITY, alphaQuality: 100, effort: 4 });
    const infoPromise = once(stream, "info");
    // Start processing without putting the readable side into flowing mode.
    stream.read(0);
    const [info] = (await infoPromise) as [sharp.OutputInfo];
    return { stream, size: info.size, width: info.width, height: info.height };
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
