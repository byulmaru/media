import { describe, expect, it } from "vitest";

import {
  parseApplyHopeInput,
  parseApplyHopeRequestEnvelope,
  parseApplyHopeRequestSignal,
  parseApplyHopeWorkflowReply,
  parseHopeProcessingInput,
} from "../src/temporal/validation";

const uploadId = "u_00000000-0000-4000-8000-000000000000";
const otherUploadId = "u_00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000001";
const replyWorkflowId = `media-apply-hope:${uploadId}:${requestId}`;
const sourceKey = `uploads/${uploadId}/00000000-0000-4000-8000-000000000002`;

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
  });
});

describe("prepareHopeUpload input validation", () => {
  it("accepts a normalized request for the matching source key", () => {
    expect(parseHopeProcessingInput({
      id: uploadId,
      sourceKey,
      contentType: "image/png",
      maxBytes: 16 * 1024 * 1024,
      maxDimension: 8192,
      requestId,
      maxEdge: 1024,
      hope: { algorithm: "nightshade", iterations: 750, intensity: 0.3 },
    })).toEqual({
      id: uploadId,
      sourceKey,
      contentType: "image/png",
      maxBytes: 16 * 1024 * 1024,
      maxDimension: 8192,
      requestId,
      maxEdge: 1024,
      hope: { algorithm: "nightshade", iterations: 750, intensity: 0.3 },
    });
  });

  it.each([
    ["different source upload", { sourceKey: `uploads/${otherUploadId}/00000000-0000-4000-8000-000000000002` }],
    ["unsupported edge limit", { maxEdge: 2048 }],
    ["unknown activity field", { extra: true }],
    ["unnormalized Hope options", { hope: { algorithm: "noise", iterations: 10 } }],
    ["undefined normalized intensity", { hope: { algorithm: "noise", iterations: 10, intensity: undefined } }],
  ] as const)("rejects %s", (_name, patch) => {
    expect(parseHopeProcessingInput({
      id: uploadId,
      sourceKey,
      contentType: "image/png",
      maxBytes: 16 * 1024 * 1024,
      maxDimension: 8192,
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
