import { describe, expect, it } from "vitest";

import { HttpError } from "../src/errors";
import { signUploadToken, verifyUploadToken } from "../src/token";

const secret = "a-long-test-signing-secret";
const payload = {
  version: 1 as const,
  id: "u_00000000-0000-4000-8000-000000000000",
  expiresAt: 2_000_000_000,
  maxBytes: 1024,
  maxDimension: 800,
};

describe("upload tokens", () => {
  it("round trips signed constraints", async () => {
    const token = await signUploadToken(payload, secret);
    await expect(verifyUploadToken(token, secret, 1_000)).resolves.toEqual(payload);
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
