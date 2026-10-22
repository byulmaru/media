import { operation, service } from "nexus-rpc";

import type {
  ProcessUploadInput,
  ProcessUploadResult,
  SetHopeInput,
  SetHopeResult,
  PublishUploadInput,
  PublishUploadResult,
} from "./types";

const uploadOperations = {
  startUpload: operation<ProcessUploadInput, ProcessUploadResult>(),
  publishUpload: operation<PublishUploadInput, PublishUploadResult>(),
};

export const mediaServiceWithoutHope = service("media", uploadOperations);
export const mediaService = service("media", {
  ...uploadOperations,
  setHope: operation<SetHopeInput, SetHopeResult>(),
});
