export interface Env {
  MEDIA: R2Bucket;
  REMOTE_IMAGES: KVNamespace;
  API_KEY: string;
  UPLOAD_SIGNING_SECRET: string;
  ALLOWED_ORIGINS: string;
}

export type AppEnv = { Bindings: Env };

export interface Limits {
  maxBytes: number;
  maxDimension: number;
}

export interface RemoteImageRecord extends Limits {
  url: string;
  createdAt: string;
}

export interface UploadTokenPayload extends Limits {
  version: 1;
  id: string;
  expiresAt: number;
}

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
}
