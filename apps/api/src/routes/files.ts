import { Readable } from 'node:stream';
import { sValidator } from '@hono/standard-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import sharp from 'sharp';
import { Temporal } from 'temporal-polyfill';
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
    z
      .object({
        file: z
          .file()
          .max(32 * 1024 * 1024)
          .mime([...ALLOWED_IMAGE_MIME_TYPES]),
        width: z.coerce.number().int().positive().max(2048).optional(),
        height: z.coerce.number().int().positive().max(2048).optional(),
        force: z.coerce.boolean().default(false),
      })
      .transform((form) =>
        form.width === undefined && form.height === undefined
          ? { ...form, width: 1024, height: 1024 }
          : form,
      ),
  ),
  async (c) => {
    const { file, width, height, force } = c.req.valid('form');

    const now = Temporal.Now.plainDateTimeISO('UTC');
    const year = String(now.year);
    const month = String(now.month).padStart(2, '0');
    const key = `${year}/${month}/${ulid()}.webp`;

    const image = sharp({ animated: true });

    const uploadFile = image
      .clone()
      .resize({
        width,
        height,
        fit: force ? 'cover' : 'inside',
        withoutEnlargement: !force,
      })
      .webp()
      .toBuffer({ resolveWithObject: true })
      .then(async ({ data, info }) => {
        await r2.write(key, data, { type: 'image/webp' });
        return info;
      });

    const createPlaceholder = image
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
      .then((raw) => rgbaToThumbHash(raw.info.width, raw.info.height, raw.data).toBase64());

    Readable.fromWeb(file.stream()).pipe(image);

    const [fileInfo, placeholder] = await Promise.all([uploadFile, createPlaceholder]).catch(
      (e) => {
        console.error(e);
        throw new HTTPException(500);
      },
    );

    return c.json({
      key,
      url: `${Bun.env.CDN_DOMAIN}/${key}`,
      placeholder,
      size: fileInfo.size,
    });
  },
);

export default app;
