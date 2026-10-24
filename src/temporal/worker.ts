import { NativeConnection, Worker } from "@temporalio/worker";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createR2S3MediaStorage } from "../storage/r2-s3";
import { createR2S3StagingStorage } from "../storage/staging";
import { temporalUploadConfigSchema } from "../validation";
import { createHopeProcessingActivities, createUploadProcessingActivities } from "./activities";
import { createMediaServiceHandler } from "./nexus";
import { HOPE_TASK_QUEUE } from "./types";

type WorkerLifecycle = Pick<Worker, "run" | "runUntil" | "shutdown">;

export async function runWorkerGroup(
  createWorkers: (workers: WorkerLifecycle[]) => Promise<void>,
  closeConnection: () => Promise<void>,
): Promise<void> {
  const workers: WorkerLifecycle[] = [];
  try {
    try {
      await createWorkers(workers);
    } catch (error) {
      await Promise.allSettled(
        workers.map((worker) => worker.runUntil(Promise.reject(error))),
      );
      throw error;
    }

    const runs = workers.map((worker) => worker.run());
    const first = await Promise.race(runs.map((run, index) =>
      run.then(
        () => workers[index]!,
        () => workers[index]!,
      )
    ));
    for (const worker of workers) {
      if (worker === first) continue;
      try {
        worker.shutdown();
      } catch {
        continue;
      }
    }
    const outcomes = await Promise.allSettled(runs);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } finally {
    await closeConnection();
  }
}

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
  await runWorkerGroup(async (workers) => {
    workers.push(await Worker.create({
      connection,
      namespace: config.TEMPORAL_NAMESPACE,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      workflowBundle: {
        codePath: fileURLToPath(new URL("./workflows.js", import.meta.url)),
      },
      activities: createUploadProcessingActivities(staging, media, config.PUBLIC_BASE_URL),
      nexusServices: [createMediaServiceHandler({ hopeEnabled: config.HOPE_ENABLED })],
      maxConcurrentActivityTaskExecutions: 4,
    }));
    if (config.HOPE_API_URL && config.HOPE_API_TOKEN) {
      workers.push(await Worker.create({
        connection,
        namespace: config.TEMPORAL_NAMESPACE,
        taskQueue: HOPE_TASK_QUEUE,
        activities: createHopeProcessingActivities(
          staging,
          config.HOPE_API_URL,
          config.HOPE_API_TOKEN,
        ),
        maxConcurrentActivityTaskExecutions: 1,
        maxHeartbeatThrottleInterval: "5 seconds",
        defaultHeartbeatThrottleInterval: "5 seconds",
      }));
    }
  }, () => connection.close());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void startWorker().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
