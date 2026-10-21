import type { MediaObject } from "./storage";

export function preparedUploadKey(sourceKey: string): string {
  return `${sourceKey}.webp`;
}

export function isPreparedUpload(object: MediaObject | null): boolean {
  return object?.httpMetadata?.contentType === "image/webp" &&
    Number.isSafeInteger(object.size) && object.size! > 0;
}
