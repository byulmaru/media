import type { MediaStorage } from "./storage";
import type { ProcessUploadInput } from "./temporal/types";

export interface Env {
  MEDIA: MediaStorage;
  STAGING?: MediaStorage;
  PREPARE_UPLOAD?: (
    input: ProcessUploadInput,
    bytes: ArrayBuffer,
  ) => Promise<string | undefined>;
  API_KEY: string;
  UPLOAD_SIGNING_SECRET: string;
  ALLOWED_ORIGINS: string;
  PUBLIC_BASE_URL: string;
  PUBLIC_API_BASE_URL?: string;
}

export type AppEnv = { Bindings: Env };

export interface Limits {
  maxBytes: number;
  maxDimension: number;
}

export interface UploadTokenPayload extends Limits {
  version: 1 | 2;
  id: string;
  expiresAt: number;
}

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
}
