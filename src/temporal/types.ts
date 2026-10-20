export const PROCESS_UPLOAD_WORKFLOW_TYPE = "processUploadWorkflow";
export const UPLOAD_VALIDATION_ERROR_TYPE = "UploadValidationError";
export const UPLOAD_PROCESSING_INPUT_ERROR_TYPE = "UploadProcessingInputError";
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

export interface UploadSourceCleanupInput {
  id: string;
  sourceKey: string;
}
