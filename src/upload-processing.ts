import type { Limits } from "./types";

export interface UploadInput {
  id: string;
  bytes: ArrayBuffer;
  contentType: string;
  limits: Limits;
}

export type UploadProcessor = (input: UploadInput) => Promise<void>;
