import { NativeConnection, Worker } from "@temporalio/worker";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { createR2S3MediaStorage } from "../storage/r2-s3";
import { createR2S3StagingStorage } from "../storage/staging";
import { temporalUploadConfigSchema } from "../validation";
import { createUploadProcessingActivities, initializeUploadProcessingCodec } from "./activities";

const publicCredentialsSchema = z.object({
  AWS_ACCESS_KEY_ID: z.string().refine((value) => value.trim().length > 0),
  AWS_SECRET_ACCESS_KEY: z.string().refine((value) => value.trim().length > 0),
});

function readWorkerConfig(source: NodeJS.ProcessEnv) {
  const temporal = temporalUploadConfigSchema.safeParse(source);
  const publicCredentials = publicCredentialsSchema.safeParse(source);
  if (!temporal.success || !publicCredentials.success) {
    throw new Error("Temporal upload worker configuration is incomplete");
  }
  return { ...temporal.data, ...publicCredentials.data };
}

export async function startWorker(source: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = readWorkerConfig(source);
  await initializeUploadProcessingCodec();

  const media = createR2S3MediaStorage({
    endpoint: config.R2_ENDPOINT,
    bucketName: config.R2_BUCKET_NAME,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  });
  const staging = createR2S3StagingStorage({
    endpoint: config.R2_ENDPOINT,
    bucketName: config.R2_STAGING_BUCKET_NAME,
    accessKeyId: config.R2_STAGING_ACCESS_KEY_ID,
    secretAccessKey: config.R2_STAGING_SECRET_ACCESS_KEY,
  });
  const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
  try {
    const worker = await Worker.create({
      connection,
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      workflowBundle: {
        codePath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
      },
      activities: createUploadProcessingActivities(staging, media),
      maxConcurrentActivityTaskExecutions: 1,
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void startWorker().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
