import { operation, service } from "nexus-rpc";

import type {
  ProcessUploadInput,
  ProcessUploadResult,
  ApplyHopeInput,
  ApplyHopeResult,
  UploadMetadataResult,
  PublishUploadInput,
  PublishUploadResult,
} from "./types";

const uploadOperations = {
  startUpload: operation<ProcessUploadInput, ProcessUploadResult>(),
  getUploadMetadata: operation<PublishUploadInput, UploadMetadataResult>(),
  publishUpload: operation<PublishUploadInput, PublishUploadResult>(),
};

export const mediaServiceWithoutHope = service("media", uploadOperations);
export const mediaService = service("media", {
  ...uploadOperations,
  applyHope: operation<ApplyHopeInput, ApplyHopeResult>(),
});
