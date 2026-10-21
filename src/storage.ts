export interface MediaObject {
  httpMetadata?: { contentType?: string };
  size?: number;
  uploaded?: Date;
}

export interface MediaPutOptions {
  onlyIf: Headers;
  httpMetadata: { contentType?: string; cacheControl?: string };
}

export interface MediaStorage {
  head(key: string): Promise<MediaObject | null>;
  put(key: string, value: ArrayBuffer, options: MediaPutOptions): Promise<MediaObject | null>;
}
