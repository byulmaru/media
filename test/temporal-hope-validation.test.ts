import { describe, expect, it } from "vitest";

import {
  parseApplyHopeInput,
  parseApplyHopeRequestEnvelope,
  parseApplyHopeRequestSignal,
  parseApplyHopeWorkflowReply,
  parseHopeProcessingInput,
  parseProcessUploadInput,
  parsePublishPreparedUploadInput,
  parsePublishUploadV2WorkflowReply,
  parseUploadSourceCleanupInput,
} from "../src/temporal/validation";

const uploadId = "u_00000000-0000-4000-8000-000000000000";
const otherUploadId = "u_00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000001";
const replyWorkflowId = `media-apply-hope:${uploadId}:${requestId}`;
const processUploadInput = { id: uploadId };
const hopeProcessingInput = {
  ...processUploadInput,
  requestId,
  maxEdge: 1024,
  hope: { algorithm: "nightshade", iterations: 750, intensity: 0.3 },
};

describe("Temporal upload input validation", () => {
  const parsers = [
    ["process upload", parseProcessUploadInput, processUploadInput],
    ["prepared publish", parsePublishPreparedUploadInput, processUploadInput],
    ["Hope processing", parseHopeProcessingInput, hopeProcessingInput],
  ] as const;

  it.each(parsers)("accepts %s input", (_name, parse, input) => {
    expect(parse(input)).toEqual(input);
  });

  it.each(parsers)("strips legacy source fields from %s input", (_name, parse, input) => {
    expect(parse({
      ...input,
      sourceKey: `uploads/${otherUploadId}/00000000-0000-4000-8000-000000000002`,
      contentType: "image/jpeg",
      maxBytes: 1,
      maxDimension: 1,
    })).toEqual(input);
  });

  it("keeps ALT generation opt-in and rejects non-boolean values", () => {
    expect(parseProcessUploadInput({ id: uploadId })).toEqual({ id: uploadId });
    expect(parseProcessUploadInput({ id: uploadId, generateAltText: false })).toEqual({
      id: uploadId,
      generateAltText: false,
    });
    expect(parseProcessUploadInput({ id: uploadId, generateAltText: true })).toEqual({
      id: uploadId,
      generateAltText: true,
    });
    expect(parseProcessUploadInput({ id: uploadId, generateAltText: "true" })).toBeUndefined();
  });
});

describe("publishUploadV2 ALT result validation", () => {
  const requestId = "00000000-0000-4000-8000-000000000001";

  it.each(["산책로에서 걷는 사람", null])("preserves optional ALT result %s", (altText) => {
    expect(parsePublishUploadV2WorkflowReply(uploadId, requestId, {
      requestId,
      result: {
        status: "completed",
        id: uploadId,
        url: "https://media.example.com/original/upload.webp",
        mediaType: "image/webp",
        altText,
      },
    })).toEqual({
      requestId,
      result: {
        status: "completed",
        id: uploadId,
        url: "https://media.example.com/original/upload.webp",
        mediaType: "image/webp",
        altText,
      },
    });
  });
});

describe("applyHope request validation", () => {
  it("defaults intensity and accepts clearing to the unprotected variant", () => {
    expect(parseApplyHopeInput({ id: uploadId, hope: { algorithm: "glaze", iterations: 29 } }))
      .toEqual({ id: uploadId, hope: { algorithm: "glaze", iterations: 29, intensity: 0.3 } });
    expect(parseApplyHopeInput({ id: uploadId, hope: null })).toEqual({ id: uploadId, hope: null });
  });

  it.each([
    ["unsupported algorithm", { algorithm: "watermark", iterations: 10 }],
    ["zero iterations", { algorithm: "noise", iterations: 0 }],
    ["iterations above algorithm limit", { algorithm: "glaze", iterations: 601 }],
    ["zero intensity", { algorithm: "nightshade", iterations: 10, intensity: 0 }],
    ["unknown option", { algorithm: "noise", iterations: 10, extra: true }],
  ] as const)("rejects %s", (_name, hope) => {
    expect(parseApplyHopeInput({ id: uploadId, hope })).toBeUndefined();
  });

  it("rejects malformed upload IDs", () => {
    expect(parseApplyHopeInput({ id: "not-an-upload-id", hope: null })).toBeUndefined();
    expect(parseProcessUploadInput({ id: "not-an-upload-id" })).toBeUndefined();
    expect(parseHopeProcessingInput({ ...hopeProcessingInput, id: "not-an-upload-id" })).toBeUndefined();
  });

  it("derives cleanup references from id and strips a mismatched legacy source key", () => {
    expect(parseUploadSourceCleanupInput({
      id: uploadId,
      hopeRequestIds: [requestId],
      sourceKey: `uploads/${otherUploadId}/00000000-0000-4000-8000-000000000002`,
    })).toEqual({ id: uploadId, hopeRequestIds: [requestId] });
    expect(parseUploadSourceCleanupInput({ id: uploadId })).toEqual({ id: uploadId });
  });
});

describe("prepareHopeUpload input validation", () => {
  it("accepts the normalized id-only request", () => {
    expect(parseHopeProcessingInput({
      id: uploadId,
      requestId,
      maxEdge: 1024,
      hope: { algorithm: "nightshade", iterations: 750, intensity: 0.3 },
    })).toEqual({
      id: uploadId,
      requestId,
      maxEdge: 1024,
      hope: { algorithm: "nightshade", iterations: 750, intensity: 0.3 },
    });
  });

  it("ignores a legacy source key even when it names a different upload", () => {
    expect(parseHopeProcessingInput({
      ...hopeProcessingInput,
      sourceKey: `uploads/${otherUploadId}/00000000-0000-4000-8000-000000000002`,
    })).toEqual(hopeProcessingInput);
  });

  it.each([
    ["unsupported edge limit", { maxEdge: 2048 }],
    ["unnormalized Hope options", { hope: { algorithm: "noise", iterations: 10 } }],
    ["undefined normalized intensity", { hope: { algorithm: "noise", iterations: 10, intensity: undefined } }],
  ] as const)("rejects %s", (_name, patch) => {
    expect(parseHopeProcessingInput({
      id: uploadId,
      requestId,
      maxEdge: 1024,
      hope: { algorithm: "noise", iterations: 10, intensity: 0.3 },
      ...patch,
    })).toBeUndefined();
  });
});

describe("internal applyHope request and reply validation", () => {
  it.each([
    ["correlated request envelope", { requestId, replyWorkflowId }, true],
    ["cross-upload reply workflow", {
      requestId,
      replyWorkflowId: `media-apply-hope:${otherUploadId}:${requestId}`,
    }, false],
    ["invalid request UUID", { requestId: "not-a-uuid", replyWorkflowId }, false],
  ] as const)("validates %s", (_name, envelope, valid) => {
    expect(parseApplyHopeRequestEnvelope(uploadId, envelope) !== undefined).toBe(valid);
  });

  it.each([
    ["normalized Hope options", { algorithm: "noise", iterations: 10, intensity: 0.3 }, true],
    ["unnormalized Hope options", { algorithm: "noise", iterations: 10 }, false],
    ["malformed Hope options", { algorithm: "noise", iterations: 10, intensity: 0.3, extra: true }, false],
  ] as const)("validates %s", (_name, hope, valid) => {
    const signal = { requestId, replyWorkflowId, hope };
    expect(parseApplyHopeRequestSignal(uploadId, signal) !== undefined).toBe(valid);
  });

  it.each([
    ["correlated normalized result", {
      requestId,
      result: { id: uploadId, hope: { algorithm: "noise", iterations: 10, intensity: 0.3 } },
    }, true],
    ["typed failure", {
      requestId,
      error: { type: "HopeProcessingError", message: "Hope processing failed" },
    }, true],
    ["mismatched request ID", {
      requestId: "00000000-0000-4000-8000-000000000002",
      result: { id: uploadId, hope: { algorithm: "noise", iterations: 10, intensity: 0.3 } },
    }, false],
    ["mismatched result upload ID", {
      requestId,
      result: { id: otherUploadId, hope: { algorithm: "noise", iterations: 10, intensity: 0.3 } },
    }, false],
  ] as const)("validates %s", (_name, reply, valid) => {
    expect(parseApplyHopeWorkflowReply(uploadId, requestId, reply) !== undefined).toBe(valid);
  });
});
