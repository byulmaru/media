declare module 'bun' {
  interface Env {
    CDN_DOMAIN: string;
    R2_ENDPOINT: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
    R2_BUCKET: string;
  }
}
