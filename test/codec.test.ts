import { describe, expect, it } from "vitest";

import { makeThumbHash } from "../src/codec";

describe("ThumbHash encoding", () => {
  it("resizes images larger than the ThumbHash input limit", async () => {
    const image = new ImageData(new Uint8ClampedArray(200 * 50 * 4).fill(255), 200, 50);

    await expect(makeThumbHash(image)).resolves.toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});
