export const PROCESS_UPLOAD_WORKFLOW_TYPE = "processUploadWorkflow";
export const PUBLISH_UPLOAD_SIGNAL_NAME = "publishUpload";
export const APPLY_HOPE_WORKFLOW_TYPE = "applyHopeWorkflow";
export const APPLY_HOPE_WORKFLOW_ID_PREFIX = "media-apply-hope:";
export const APPLY_HOPE_REQUEST_SIGNAL_NAME = "applyHopeRequest";
export const APPLY_HOPE_RESULT_SIGNAL_NAME = "applyHopeResult";
export const HOPE_REPLY_WORKFLOW_ID_MAX_LENGTH = 512;
export const UPLOAD_VALIDATION_ERROR_TYPE = "UploadValidationError";
export const UPLOAD_PROCESSING_INPUT_ERROR_TYPE = "UploadProcessingInputError";
export const UPLOAD_SOURCE_ERROR_TYPE = "UploadSourceError";
export const UPLOAD_EXPIRED_ERROR_TYPE = "UploadExpiredError";
export const HOPE_PROCESSING_ERROR_TYPE = "HopeProcessingError";
export const APPLY_HOPE_REPLY_ERROR_TYPES = [
  HOPE_PROCESSING_ERROR_TYPE,
  UPLOAD_EXPIRED_ERROR_TYPE,
  UPLOAD_PROCESSING_INPUT_ERROR_TYPE,
  UPLOAD_SOURCE_ERROR_TYPE,
  UPLOAD_VALIDATION_ERROR_TYPE,
  "HopeHttpError",
  "HopeNetworkError",
  "HopeOutputError",
] as const;
export const UPLOAD_EXPIRATION_MS = 24 * 60 * 60 * 1000;
export const HOPE_TASK_QUEUE = "media-hope";
export const HOPE_MAX_EDGE = 1024;
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

export interface PublishPreparedUploadInput extends ProcessUploadInput {
  hopeRequestId?: string;
}

export interface UploadSourceCleanupInput {
  id: string;
  sourceKey: string;
  hopeRequestIds?: string[];
}

export interface HopeOptions {
  algorithm: "noise" | "glaze" | "nightshade";
  iterations: number;
  intensity?: number;
}

export interface NormalizedHopeOptions extends HopeOptions {
  intensity: number;
}

export interface ApplyHopeInput {
  id: string;
  hope: HopeOptions | null;
}

export interface ApplyHopeResult {
  id: string;
  hope: NormalizedHopeOptions | null;
}

export interface HopeProcessingInput extends ProcessUploadInput {
  requestId: string;
  hope: NormalizedHopeOptions;
}

export interface ApplyHopeRequestSignal {
  requestId: string;
  replyWorkflowId: string;
  hope: NormalizedHopeOptions | null;
}

export type ApplyHopeWorkflowReply =
  | { requestId: string; result: ApplyHopeResult }
  | {
      requestId: string;
      error: ApplyHopeWorkflowFailure;
    };

export interface ApplyHopeWorkflowFailure {
  type: typeof APPLY_HOPE_REPLY_ERROR_TYPES[number];
  message: string;
}

export interface ApplyHopeRequestEnvelope {
  requestId: string;
  replyWorkflowId: string;
}
