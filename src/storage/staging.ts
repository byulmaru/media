import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { Readable as NodeReadable } from "node:stream";
import { R2S3MediaStorage } from "./r2-s3";
import type { MediaObject, MediaPutOptions } from "../storage";
import type { R2S3StorageConfig } from "./r2-s3";

export interface UploadStagingStorage {
  head(key: string): Promise<MediaObject | null>;
  headLastModified(key: string): Promise<Date | null>;
  get(key: string, maxBytes: number): Promise<ArrayBuffer>;
  getStream(
    key: string,
    expectedContentType: string,
  ): Promise<{ body: NodeReadable; contentLength: number } | null>;
  putStream(
    key: string,
    body: NodeReadable,
    contentLength: number,
    options: MediaPutOptions,
  ): Promise<MediaObject | null>;
  delete(key: string): Promise<void>;
}

export class R2S3StagingStorage implements UploadStagingStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucketName: string,
  ) {
    this.media = new R2S3MediaStorage(client, bucketName);
  }

  private readonly media: R2S3MediaStorage;

  head(key: string): Promise<MediaObject | null> {
    return this.media.head(key);
  }

  async headLastModified(key: string): Promise<Date | null> {
    try {
      const object = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      return object.LastModified ?? null;
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async get(key: string, maxBytes: number): Promise<ArrayBuffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError("maxBytes must be a non-negative safe integer");
    }

    const object = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
    );
    const body = object.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    if (!body) throw new Error("staging object has no body");
    if (object.ContentLength !== undefined && object.ContentLength > maxBytes) {
      body.destroy?.();
      throw new RangeError("staging object exceeds maxBytes");
    }

    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of body) {
      length += chunk.byteLength;
      if (length > maxBytes) {
        body.destroy?.();
        throw new RangeError("staging object exceeds maxBytes");
      }
      chunks.push(chunk);
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  }

  async getStream(
    key: string,
    expectedContentType: string,
  ): Promise<{ body: NodeReadable; contentLength: number } | null> {
    let object;
    try {
      object = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }

    const body = object.Body as NodeReadable | undefined;
    const contentLength = object.ContentLength;
    if (
      !body ||
      object.ContentType !== expectedContentType ||
      !Number.isSafeInteger(contentLength) ||
      contentLength! <= 0
    ) {
      body?.destroy();
      throw new Error("staged object stream metadata is invalid");
    }
    return { body, contentLength: contentLength! };
  }

  putStream(
    key: string,
    body: NodeReadable,
    contentLength: number,
    options: MediaPutOptions,
  ): Promise<MediaObject | null> {
    return this.media.putStream(key, body, contentLength, options);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
  }
}

export function createR2S3StagingStorage(
  config: R2S3StorageConfig,
): R2S3StagingStorage {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return new R2S3StagingStorage(client, config.bucketName);
}
