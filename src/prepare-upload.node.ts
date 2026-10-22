import { HttpError } from "./errors";
import { validateImageUpload } from "./image-info";
import { isPreparedUpload, preparedUploadKey } from "./prepared-upload";
import type { UploadStagingStorage } from "./storage/staging";
import type { ProcessUploadInput } from "./temporal/types";
import { transcodeUploadImage } from "./temporal/codec";

type PreparedUploadStorage = Pick<UploadStagingStorage, "head" | "get" | "putStream">;

export async function ensurePreparedUpload(
  storage: PreparedUploadStorage,
  input: ProcessUploadInput,
): Promise<void> {
  const key = preparedUploadKey(input.sourceKey);
  const existing = await storage.head(key);
  if (existing) {
    if (isPreparedUpload(existing)) return;
    throw new Error("prepared upload metadata is invalid");
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await storage.get(input.sourceKey, input.maxBytes);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new HttpError(413, "size_limit_exceeded", "image exceeds maxBytes");
    }
    throw error;
  }
  if (bytes.byteLength > input.maxBytes) {
    throw new HttpError(413, "size_limit_exceeded", "image exceeds maxBytes");
  }
  const info = validateImageUpload(bytes, input.contentType, input);

  const transformStarted = Date.now();
  const output = await transcodeUploadImage(bytes);
  try {
    if (!Number.isSafeInteger(output.size) || output.size <= 0) {
      throw new Error("prepared WebP size is invalid");
    }
    console.log(
      JSON.stringify({
        event: "image_transform",
        sourceKind: "upload",
        sourceFormat: info.format,
        inputBytes: bytes.byteLength,
        outputBytes: output.size,
        width: output.width,
        height: output.height,
        durationMs: Date.now() - transformStarted,
      }),
    );

    const stored = await storage.putStream(
      key,
      output.stream,
      output.size,
      {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: { contentType: "image/webp" },
      },
    );
    if (!stored && !isPreparedUpload(await storage.head(key))) {
      throw new Error("conditional prepared upload write could not be confirmed");
    }
  } finally {
    output.stream.destroy();
  }
}
