import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_DIMENSION } from "../src/constants";
import { HttpError } from "../src/errors";
import { signUploadToken, verifyUploadToken } from "../src/token";
import type { UploadTokenPayload } from "../src/types";

const secret = "a-long-test-signing-secret";
const payload = {
  version: 1 as const,
  id: "u_00000000-0000-4000-8000-000000000000",
  expiresAt: 2_000_000_000,
  maxBytes: 1024,
  maxDimension: 800,
};
const stagingPayload = {
  version: 2 as const,
  id: "u_00000000-0000-4000-8000-000000000000",
  expiresAt: 2_000_000_000,
  maxBytes: DEFAULT_MAX_BYTES,
  maxDimension: DEFAULT_MAX_DIMENSION,
};

describe("upload tokens", () => {
  it("round trips signed constraints", async () => {
    const token = await signUploadToken(payload, secret);
    await expect(verifyUploadToken(token, secret, 1_000)).resolves.toEqual(payload);
  });

  it("round trips the fixed staging token limits", async () => {
    const token = await signUploadToken(stagingPayload, secret);
    await expect(verifyUploadToken(token, secret, 1_000)).resolves.toEqual(stagingPayload);
  });

  it.each([
    { ...stagingPayload, maxBytes: DEFAULT_MAX_BYTES - 1 },
    { ...stagingPayload, extra: true },
  ])("rejects a noncanonical staging token", async (invalidPayload) => {
    const token = await signUploadToken(
      invalidPayload as unknown as UploadTokenPayload,
      secret,
    );
    await expect(verifyUploadToken(token, secret, 1_000)).rejects.toMatchObject({
      status: 401,
      code: "invalid_upload_token",
    });
  });

  it("rejects tampering", async () => {
    const token = await signUploadToken(payload, secret);
    await expect(verifyUploadToken(`${token}x`, secret, 1_000)).rejects.toMatchObject({
      status: 401,
      code: "invalid_upload_token",
    });
  });

  it("rejects expired tokens", async () => {
    const token = await signUploadToken(payload, secret);
    await expect(verifyUploadToken(token, secret, payload.expiresAt * 1000)).rejects.toMatchObject({
      status: 410,
      code: "upload_token_expired",
    });
  });
});
