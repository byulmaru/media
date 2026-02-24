import { Readable } from 'node:stream';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { sValidator } from '@hono/standard-validator';
import { Hono } from 'hono';
import sharp from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';
import { ulid } from 'ulidx';
import { z } from 'zod';
import { ALLOWED_IMAGE_MIME_TYPES } from '../const';
import { r2 } from '../lib/r2';

const app = new Hono();

app.post(
  '/',
  sValidator(
    'form',
    z.object({
      file: z
        .file()
        .max(32 * 1024 * 1024)
        .mime([...ALLOWED_IMAGE_MIME_TYPES]),
    }),
  ),
  async (c) => {
    const { file } = c.req.valid('form');

    const image = sharp({ animated: true });
    Readable.fromWeb(file.stream()).pipe(image);
    const upload = Readable.toWeb(
      image
        .resize({
          width: 1024,
          height: 1024,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp(),
    );

    const id = ulid();
    const [, placeholder] = await Promise.all([
      r2.send(
        new PutObjectCommand({
          Bucket: Bun.env.R2_BUCKET,
          Key: `uploads/${id}`,
          Body: upload,
          ContentType: 'image/webp',
        }),
      ),
      image
        .clone()
        .resize({
          width: 100,
          height: 100,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
        .then((raw) => rgbaToThumbHash(raw.info.width, raw.info.height, raw.data).toBase64()),
    ]).catch((e) => {
      console.error(e);
      return c.json({ error: 'Failed to upload file' }, 500);
    });

    return c.json({ id, url: `${Bun.env.CDN_DOMAIN}/uploads/${id}`, placeholder });
  },
);

export default app;
