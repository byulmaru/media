import { operation, service } from "nexus-rpc";

import type {
  ProcessUploadInput,
  ProcessUploadResult,
  ApplyHopeInput,
  ApplyHopeResult,
  PublishUploadInput,
  PublishUploadResult,
  PublishUploadV2Input,
  PublishUploadV2Result,
} from "./types";

const uploadOperations = {
  startUpload: operation<ProcessUploadInput, ProcessUploadResult>(),
  publishUpload: operation<PublishUploadInput, PublishUploadResult>(),
  publishUploadV2: operation<PublishUploadV2Input, PublishUploadV2Result>(),
};

export const mediaServiceWithoutHope = service("media", uploadOperations);
export const mediaService = service("media", {
  ...uploadOperations,
  applyHope: operation<ApplyHopeInput, ApplyHopeResult>(),
});
