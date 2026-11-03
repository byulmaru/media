export interface MediaObject {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  size?: number;
  uploaded?: Date;
}

export interface MediaPutOptions {
  onlyIf: Headers;
  httpMetadata: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
}

export interface MediaStorage {
  head(key: string): Promise<MediaObject | null>;
  put(key: string, value: ArrayBuffer, options: MediaPutOptions): Promise<MediaObject | null>;
}
