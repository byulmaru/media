import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("API key authentication", () => {
  const worker = (exports as unknown as { default: Fetcher }).default;

  it("rejects an invalid key and a malformed bearer scheme", async () => {
    for (const authorization of ["Bearer wrong-api-key", "bearer test-api-key"]) {
      const response = await worker.fetch("https://media.example.com/v1/uploads", {
        method: "POST",
        headers: { Authorization: authorization },
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "unauthorized",
          message: "valid bearer API key required",
        },
      });
    }
  });
});
