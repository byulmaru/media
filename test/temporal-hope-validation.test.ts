import { describe, expect, it } from "vitest";

import {
  parseSetHopeInput,
  parseSetHopeRequestEnvelope,
  parseSetHopeRequestSignal,
  parseSetHopeWorkflowReply,
} from "../src/temporal/validation";
import { hopeWorkerConfigSchema } from "../src/temporal/hope-config";

const uploadId = "u_00000000-0000-4000-8000-000000000000";
const otherUploadId = "u_00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000001";
const replyWorkflowId = `media-set-hope:${uploadId}:${requestId}`;

describe("Hope request validation", () => {
  it("defaults intensity and accepts clearing to the unprotected variant", () => {
    expect(parseSetHopeInput({ id: uploadId, hope: { algorithm: "glaze", iterations: 29 } }))
      .toEqual({ id: uploadId, hope: { algorithm: "glaze", iterations: 29, intensity: 0.3 } });
    expect(parseSetHopeInput({ id: uploadId, hope: null })).toEqual({ id: uploadId, hope: null });
  });

  it.each([
    ["unsupported algorithm", { algorithm: "watermark", iterations: 10 }],
    ["zero iterations", { algorithm: "noise", iterations: 0 }],
    ["iterations above algorithm limit", { algorithm: "glaze", iterations: 601 }],
    ["zero intensity", { algorithm: "nightshade", iterations: 10, intensity: 0 }],
    ["unknown option", { algorithm: "noise", iterations: 10, extra: true }],
  ] as const)("rejects %s", (_name, hope) => {
    expect(parseSetHopeInput({ id: uploadId, hope })).toBeUndefined();
  });

  it("rejects malformed upload IDs", () => {
    expect(parseSetHopeInput({ id: "not-an-upload-id", hope: null })).toBeUndefined();
  });
});

describe("internal Hope request and reply validation", () => {
  it.each([
    ["correlated request envelope", { requestId, replyWorkflowId }, true],
    ["cross-upload reply workflow", {
      requestId,
      replyWorkflowId: `media-set-hope:${otherUploadId}:${requestId}`,
    }, false],
    ["invalid request UUID", { requestId: "not-a-uuid", replyWorkflowId }, false],
  ] as const)("validates %s", (_name, envelope, valid) => {
    expect(parseSetHopeRequestEnvelope(uploadId, envelope) !== undefined).toBe(valid);
  });

  it.each([
    ["normalized Hope options", { algorithm: "noise", iterations: 10, intensity: 0.3 }, true],
    ["unnormalized Hope options", { algorithm: "noise", iterations: 10 }, false],
    ["malformed Hope options", { algorithm: "noise", iterations: 10, intensity: 0.3, extra: true }, false],
  ] as const)("validates %s", (_name, hope, valid) => {
    const signal = { requestId, replyWorkflowId, hope };
    expect(parseSetHopeRequestSignal(uploadId, signal) !== undefined).toBe(valid);
  });

  it.each([
    ["correlated normalized result", {
      requestId,
      result: { id: uploadId, hope: { algorithm: "noise", iterations: 10, intensity: 0.3 } },
    }, true],
    ["typed failure", {
      requestId,
      error: { type: "HopeHttpError", message: "Hope service request failed" },
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
    expect(parseSetHopeWorkflowReply(uploadId, requestId, reply) !== undefined).toBe(valid);
  });
});

describe("Hope worker configuration", () => {
  const config = {
    TEMPORAL_ADDRESS: "temporal-frontend.temporal.svc.cluster.local:7233",
    TEMPORAL_NAMESPACE: "media",
    R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    R2_BUCKET_NAME: "byulmaru-media",
    R2_STAGING_BUCKET_NAME: "byulmaru-media-staging",
    AWS_ACCESS_KEY_ID: "media-access-key",
    AWS_SECRET_ACCESS_KEY: "media-secret-key",
    HOPE_BASE_URL: "https://hope.example.com",
    HOPE_API_TOKEN: "test-token",
  };

  it("accepts a private HTTPS endpoint and local loopback HTTP for tests", () => {
    expect(hopeWorkerConfigSchema.safeParse(config).success).toBe(true);
    expect(hopeWorkerConfigSchema.safeParse({
      ...config,
      HOPE_BASE_URL: "http://127.0.0.1:8000",
    }).success).toBe(true);
  });

  it.each([
    ["remote HTTP", { HOPE_BASE_URL: "http://hope.example.com" }],
    ["URL path", { HOPE_BASE_URL: "https://hope.example.com/protect" }],
    ["blank API token", { HOPE_API_TOKEN: " " }],
    ["shared staging and public bucket", { R2_STAGING_BUCKET_NAME: "byulmaru-media" }],
  ] as const)("rejects %s", (_name, patch) => {
    expect(hopeWorkerConfigSchema.safeParse({ ...config, ...patch }).success).toBe(false);
  });
});
