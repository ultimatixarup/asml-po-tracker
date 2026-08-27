import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageConfig } from "./config.ts";

/**
 * Content-addressed blob storage on any S3-compatible service (Tigris on
 * Fly.io in production). Keys are derived from the content hash, so a blob can
 * never be overwritten with different bytes.
 */

export interface BlobStore {
  put(sha256: string, bytes: Uint8Array, mime: string): Promise<string>;
  get(key: string): Promise<Uint8Array>;
  /** Short-lived read URL for the audit view. */
  presignGet(key: string, expiresInSeconds?: number): Promise<string>;
}

export function blobKeyFor(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256}`;
}

export function createBlobStore(config: StorageConfig): BlobStore {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async put(sha256, bytes, mime) {
      const key = blobKeyFor(sha256);
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: bytes,
          ContentType: mime,
        }),
      );
      return key;
    },

    async get(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
      );
      if (!result.Body) throw new Error(`Blob ${key} has no body`);
      return result.Body.transformToByteArray();
    },

    async presignGet(key, expiresInSeconds = 300) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
    },
  };
}
