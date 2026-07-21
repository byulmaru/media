import {
  IMMUTABLE_CACHE_CONTROL,
  REMOTE_CACHE_CONTROL,
} from "./constants";

export const originalKey = (id: string): string => `original/${id}.webp`;
export const remoteRecordKey = (id: string): string => `remote:${id}`;

export function imageResponse(
  body: BodyInit,
  etag: string,
  remote: boolean,
  status = 200,
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": remote ? REMOTE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL,
      ETag: etag,
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function notModified(etag: string, remote: boolean): Response {
  return new Response(null, {
    status: 304,
    headers: {
      "Cache-Control": remote ? REMOTE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL,
      ETag: etag,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function matchesEtag(request: Request, etag: string): boolean {
  const header = request.headers.get("If-None-Match");
  return header === "*" || header?.split(",").some((candidate) => candidate.trim() === etag) === true;
}
