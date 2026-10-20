import { operation, service } from "nexus-rpc";

import type {
  ProcessUploadInput,
  ProcessUploadResult,
  PublishUploadInput,
  PublishUploadResult,
} from "./types";

export const mediaService = service("media", {
  startUpload: operation<ProcessUploadInput, ProcessUploadResult>(),
  publishUpload: operation<PublishUploadInput, PublishUploadResult>(),
});
