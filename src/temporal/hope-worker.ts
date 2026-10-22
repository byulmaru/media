import { NativeConnection, Worker } from "@temporalio/worker";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createR2S3StagingStorage } from "../storage/staging";
import { createHopeProcessingActivities } from "./hope-activities";
import { parseHopeWorkerConfig } from "./hope-config";
import { HOPE_TASK_QUEUE } from "./types";

export async function startHopeWorker(source: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseHopeWorkerConfig(source);
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
      taskQueue: HOPE_TASK_QUEUE,
      activities: createHopeProcessingActivities(staging, config),
      maxConcurrentActivityTaskExecutions: 1,
      maxHeartbeatThrottleInterval: 5_000,
    });
    await worker.run();
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void startHopeWorker().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
