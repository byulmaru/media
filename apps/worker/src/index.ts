import { Hono } from "hono";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/files/:id", async (c) => {
  const id = c.req.param("id");
  const object = await c.env.BUCKET.get(id);

  if (!object) {
    return c.notFound();
  }

  const headers = new Headers();
  headers.set("etag", object.httpEtag);
  if (object.size) {
    headers.set("content-length", String(object.size));
  }
  if (object.httpMetadata?.contentType) {
    headers.set("content-type", object.httpMetadata.contentType);
  }
  if (object.httpMetadata?.contentDisposition) {
    headers.set("content-disposition", object.httpMetadata.contentDisposition);
  }
  if (object.httpMetadata?.cacheControl) {
    headers.set("cache-control", object.httpMetadata.cacheControl);
  }

  return new Response(object.body, { headers });
});

export default app;
