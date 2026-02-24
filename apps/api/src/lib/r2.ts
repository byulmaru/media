import { S3Client } from 'bun';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: Bun.env.R2_ENDPOINT,
  accessKeyId: Bun.env.R2_ACCESS_KEY_ID,
  secretAccessKey: Bun.env.R2_SECRET_ACCESS_KEY,
  bucket: Bun.env.R2_BUCKET,
});
