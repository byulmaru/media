import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { apiKeyAuth } from "../middleware/auth";
import { remoteRecordKey } from "../storage";
import type { AppEnv, RemoteImageRecord } from "../types";
import { remoteRequestSchema, throwOnValidationError } from "../validation";

export const remotes = new Hono<AppEnv>();

remotes.post(
  "/",
  apiKeyAuth,
  zValidator("json", remoteRequestSchema, throwOnValidationError),
  async (c) => {
    const body = c.req.valid("json");
    const id = `r_${crypto.randomUUID()}`;
    const record: RemoteImageRecord = { ...body, createdAt: new Date().toISOString() };
    await c.env.REMOTE_IMAGES.put(remoteRecordKey(id), JSON.stringify(record));
    return c.json({ id }, 201);
  },
);
