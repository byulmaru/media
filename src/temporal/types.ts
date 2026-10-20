export const PROCESS_UPLOAD_WORKFLOW_TYPE = "processUploadWorkflow";
export const PUBLISH_UPLOAD_SIGNAL_NAME = "publishUpload";
export const UPLOAD_VALIDATION_ERROR_TYPE = "UploadValidationError";
export const UPLOAD_PROCESSING_INPUT_ERROR_TYPE = "UploadProcessingInputError";
export const UPLOAD_SOURCE_ERROR_TYPE = "UploadSourceError";
export const UPLOAD_EXPIRED_ERROR_TYPE = "UploadExpiredError";
export const UPLOAD_EXPIRATION_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_VALIDATION_CODES = [
  "unsupported_image",
  "content_type_mismatch",
  "invalid_image",
  "size_limit_exceeded",
  "dimension_limit_exceeded",
  "pixel_limit_exceeded",
  "encoding_failed",
] as const;

export interface ProcessUploadInput {
  id: string;
  sourceKey: string;
  contentType: string;
  maxBytes: number;
  maxDimension: number;
}

export interface ProcessUploadResult {
  id: string;
  url: string;
  mediaType: "image/webp";
}

export interface PublishUploadInput {
  id: string;
}

export interface PublishUploadResult {
  id: string;
}

export interface UploadSourceCleanupInput {
  id: string;
  sourceKey: string;
}
