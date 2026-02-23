import { PutObjectCommand } from '@aws-sdk/client-s3';
import { sValidator } from '@hono/standard-validator';
import { Hono } from 'hono';
import sharp from 'sharp';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { ALLOWED_IMAGE_MIME_TYPES } from '../const';
import { r2 } from '../lib/r2';

const app = new Hono();

app.post(
  '/',
  sValidator('form', z.object({ file: z.file().mime([...ALLOWED_IMAGE_MIME_TYPES]) })),
  async (c) => {
    const { file } = c.req.valid('form');

    let transform = sharp({ animated: true });
    let mime: string;

    if (file.type !== 'image/svg+xml') {
      mime = 'image/webp';
      transform = transform
        .resize({
          width: 1024,
          height: 1024,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp();
    }
    else {
      mime = 'image/svg+xml';
    }

    const id = ulid();

    await r2.send(
      new PutObjectCommand({
        Bucket: Bun.env.R2_BUCKET,
        Key: `uploads/${id}`,
        Body: transform,
        ContentType: mime,
      }),
    );

    return c.json({ id, url: `${Bun.env.CDN_DOMAIN}/uploads/${id}` });
  },
);

export default app;
