import { once } from "node:events";
import sharp from "sharp";

import { MAX_PIXELS, WEBP_QUALITY } from "../constants";
import { HttpError } from "../errors";
import { HOPE_MAX_EDGE } from "./types";

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

export async function encodeHopeInput(
  buffer: ArrayBuffer,
): Promise<{
  stream: ReturnType<typeof sharp>;
  size: number;
}> {
  let stream: ReturnType<typeof sharp> | undefined;
  try {
    stream = sharp(Buffer.from(buffer), { limitInputPixels: MAX_PIXELS });
    stream
      .rotate()
      .resize({
        width: HOPE_MAX_EDGE,
        height: HOPE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png();
    const infoPromise = once(stream, "info");
    stream.read(0);
    const [info] = (await infoPromise) as [sharp.OutputInfo];
    if (
      !Number.isSafeInteger(info.size) ||
      info.size <= 0 ||
      info.width > HOPE_MAX_EDGE ||
      info.height > HOPE_MAX_EDGE
    ) {
      throw new Error("Hope input dimensions are invalid");
    }
    return { stream, size: info.size };
  } catch {
    stream?.destroy();
    throw new HttpError(422, "invalid_image", "image processing failed");
  }
}

export async function validateHopeWebp(buffer: Buffer): Promise<void> {
  try {
    const metadata = await sharp(buffer, {
      limitInputPixels: HOPE_MAX_EDGE * HOPE_MAX_EDGE,
    }).metadata();
    if (
      metadata.format !== "webp" ||
      !Number.isSafeInteger(metadata.width) ||
      !Number.isSafeInteger(metadata.height) ||
      metadata.width! <= 0 ||
      metadata.height! <= 0 ||
      metadata.width! > HOPE_MAX_EDGE ||
      metadata.height! > HOPE_MAX_EDGE ||
      (metadata.pages !== undefined && metadata.pages > 1)
    ) {
      throw new Error("invalid Hope output");
    }

    // Decode the bounded image fully without changing the bytes that will be stored.
    await sharp(buffer, {
      limitInputPixels: HOPE_MAX_EDGE * HOPE_MAX_EDGE,
    }).stats();
  } catch {
    throw new Error("Hope returned an invalid WebP image");
  }
}
