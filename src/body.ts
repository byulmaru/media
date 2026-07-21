import { HttpError } from "./errors";

export async function readBodyLimited(response: Request | Response, maxBytes: number): Promise<ArrayBuffer> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new HttpError(400, "invalid_content_length", "invalid Content-Length header");
    }
    if (parsed > maxBytes) {
      throw new HttpError(413, "size_limit_exceeded", `image exceeds ${maxBytes} bytes`);
    }
  }
  if (!response.body) throw new HttpError(400, "missing_body", "image body required");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("size limit exceeded");
        throw new HttpError(413, "size_limit_exceeded", `image exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}
