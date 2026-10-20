import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import type { Readable as NodeReadable } from "node:stream";

import type { MediaObject, MediaPutOptions, MediaStorage } from "../storage";

export interface R2S3StorageConfig {
  endpoint: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
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
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async put(
    key: string,
    value: ArrayBuffer,
    options: MediaPutOptions,
  ): Promise<MediaObject | null> {
    return this.putObject(key, new Uint8Array(value), options);
  }

  async putStream(
    key: string,
    body: NodeReadable,
    contentLength: number,
    options: MediaPutOptions,
  ): Promise<MediaObject | null> {
    return this.putObject(key, body, options, contentLength);
  }

  private async putObject(
    key: string,
    body: PutObjectCommandInput["Body"],
    options: MediaPutOptions,
    contentLength?: number,
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
          Body: body,
          ContentLength: contentLength,
          IfNoneMatch: ifNoneMatch,
          ContentType: options.httpMetadata.contentType,
          CacheControl: options.httpMetadata.cacheControl,
        }),
      );
      return {};
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
        return null;
      }
      throw error;
    }
  }
}

export function createR2S3MediaStorage(config: R2S3StorageConfig): R2S3MediaStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return new R2S3MediaStorage(client, config.bucketName);
}
