import { describe, expect, it } from "vitest";

import { HttpError } from "../src/errors";
import { assertImageWithinLimits, inspectImage } from "../src/image-info";
import { uploadRequestSchema } from "../src/validation";
import { PNG_1X1 } from "./helpers";

describe("image inspection and limits", () => {
  it("reads PNG dimensions without decoding", () => {
    expect(inspectImage(PNG_1X1.buffer as ArrayBuffer)).toEqual({
      format: "png",
      width: 1,
      height: 1,
    });
  });

  it("rejects unsupported bytes", () => {
    expect(() => inspectImage(new Uint8Array([1, 2, 3]).buffer)).toThrowError(HttpError);
  });

  it("rejects animated WebP before decoding", () => {
    const bytes = new Uint8Array(30);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WEBP"), 8);
    bytes.set(new TextEncoder().encode("VP8X"), 12);
    bytes[20] = 0x02;
    expect(() => inspectImage(bytes.buffer)).toThrowError(HttpError);
  });

  it("applies defaults and rejects limits above the service cap", () => {
    expect(uploadRequestSchema.parse({})).toEqual({
      maxBytes: 16 * 1024 * 1024,
      maxDimension: 8192,
    });
    expect(() =>
      uploadRequestSchema.parse({ maxBytes: 16 * 1024 * 1024 + 1 }),
    ).toThrow();
    expect(uploadRequestSchema.parse({
      maxBytes: 16 * 1024 * 1024,
      maxDimension: 8192,
    })).toEqual({
      maxBytes: 16 * 1024 * 1024,
      maxDimension: 8192,
    });
  });

  it("enforces the long-edge and total-pixel limits", () => {
    expect(() =>
      assertImageWithinLimits(8192, 1, { maxBytes: 1024, maxDimension: 8192 }),
    ).not.toThrow();
    expect(() =>
      assertImageWithinLimits(4096, 2048, { maxBytes: 1024, maxDimension: 8192 }),
    ).not.toThrow();
    expect(() =>
      assertImageWithinLimits(801, 600, { maxBytes: 1024, maxDimension: 800 }),
    ).toThrowError(HttpError);
    expect(() =>
      assertImageWithinLimits(8193, 1, { maxBytes: 1024, maxDimension: 8192 }),
    ).toThrowError(HttpError);
    expect(() =>
      assertImageWithinLimits(4097, 2048, { maxBytes: 1024, maxDimension: 8192 }),
    ).toThrowError(HttpError);
  });
});
