import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import type { MediaObject, MediaPutOptions, MediaStorage } from "../storage";

export interface R2S3StorageConfig {
  endpoint: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
}

export class R2S3MediaStorage implements MediaStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucketName: string,
  ) {}

  async head(key: string): Promise<MediaObject | null> {
    try {
      const object = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      return {
        httpMetadata: { contentType: object.ContentType },
      };
    } catch (error) {
      if (statusCode(error) === 404) return null;
      throw error;
    }
  }

  async put(
    key: string,
    value: ArrayBuffer,
    options: MediaPutOptions,
  ): Promise<MediaObject | null> {
    const ifNoneMatch = options.onlyIf.get("If-None-Match");
    if (ifNoneMatch !== "*") {
      throw new Error('R2 media writes require If-None-Match: "*"');
    }

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: new Uint8Array(value),
          IfNoneMatch: ifNoneMatch,
          ContentType: options.httpMetadata.contentType,
          CacheControl: options.httpMetadata.cacheControl,
        }),
      );
      return {};
    } catch (error) {
      if (statusCode(error) === 412) return null;
      throw error;
    }
  }
}

export function createR2S3MediaStorage(config: R2S3StorageConfig): R2S3MediaStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return new R2S3MediaStorage(client, config.bucketName);
}
