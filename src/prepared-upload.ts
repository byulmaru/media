import type { MediaObject } from "./storage";

export function uploadSourceKey(id: string): string {
  return `uploads/${id}/${id.slice(2)}`;
}

export function preparedUploadKey(sourceKey: string): string {
  return `${sourceKey}.webp`;
}

export function hopePreparedUploadKey(sourceKey: string, requestId: string): string {
  return `${sourceKey}.hope/${requestId}.webp`;
}

export function isPreparedUpload(object: MediaObject | null): boolean {
  return object?.httpMetadata?.contentType === "image/webp" &&
    Number.isSafeInteger(object.size) && object.size! > 0;
}
