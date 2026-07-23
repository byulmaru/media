import { describe, expect, it } from "vitest";

import { readBodyLimited } from "../src/body";
import { DEFAULT_MAX_BYTES } from "../src/constants";

describe("bounded request bodies", () => {
  it("accepts the 16 MiB boundary", async () => {
    const body = new Uint8Array(DEFAULT_MAX_BYTES);
    await expect(readBodyLimited(new Response(body), DEFAULT_MAX_BYTES)).resolves.toHaveProperty(
      "byteLength",
      DEFAULT_MAX_BYTES,
    );
  });

  it("rejects a declared body above the limit before reading it", async () => {
    const response = new Response(new Uint8Array(1), {
      headers: { "Content-Length": String(DEFAULT_MAX_BYTES + 1) },
    });
    await expect(readBodyLimited(response, DEFAULT_MAX_BYTES)).rejects.toMatchObject({
      status: 413,
      code: "size_limit_exceeded",
    });
  });
});
