import { NativeConnection, Worker } from "@temporalio/worker";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createR2S3MediaStorage } from "../storage/r2-s3";
import { createR2S3StagingStorage } from "../storage/staging";
import { temporalUploadConfigSchema } from "../validation";
import { createUploadProcessingActivities } from "./activities";
import { createMediaServiceHandler } from "./nexus";

function readWorkerConfig(source: NodeJS.ProcessEnv) {
  const temporal = temporalUploadConfigSchema.safeParse(source);
  if (!temporal.success) {
    throw new Error("Temporal upload worker configuration is incomplete");
  }
  return temporal.data;
}

export async function startWorker(source: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = readWorkerConfig(source);
  const media = createR2S3MediaStorage({
    endpoint: config.R2_ENDPOINT,
    bucketName: config.R2_BUCKET_NAME,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  });
  const staging = createR2S3StagingStorage({
    endpoint: config.R2_ENDPOINT,
    bucketName: config.R2_STAGING_BUCKET_NAME,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
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
      activities: createUploadProcessingActivities(staging, media, config.PUBLIC_BASE_URL),
      nexusServices: [createMediaServiceHandler({ hopeEnabled: config.HOPE_ENABLED })],
      maxConcurrentActivityTaskExecutions: 4,
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
