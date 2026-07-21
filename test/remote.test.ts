import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError } from "../src/errors";
import { fetchRemoteImage, setRemoteRuntimeForTest, validateRemoteUrl } from "../src/remote";

describe("remote URL validation", () => {
  afterEach(() => {
    setRemoteRuntimeForTest();
    vi.restoreAllMocks();
  });
  it("accepts public HTTPS URLs and removes fragments", () => {
    expect(validateRemoteUrl("https://images.example.com/a.png#fragment").href).toBe(
      "https://images.example.com/a.png",
    );
  });

  it.each([
    "http://images.example.com/a.png",
    "https://localhost/a.png",
    "https://127.0.0.1/a.png",
    "https://[::1]/a.png",
    "https://user:password@images.example.com/a.png",
    "https://images.example.com:8443/a.png",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validateRemoteUrl(url)).toThrowError(HttpError);
  });

  it("rejects hostnames resolving to private addresses before fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setRemoteRuntimeForTest({
      resolve4: async () => ["10.0.0.1"],
      resolve6: async () => [],
      fetch: fetchSpy,
    });
    await expect(fetchRemoteImage("https://images.example.com/a.png", 1024)).rejects.toMatchObject({
      code: "unsafe_remote_url",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
