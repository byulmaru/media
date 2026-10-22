import {
  CancellationScope,
  condition,
  createNexusServiceClient,
  defineSignal,
  isCancellation,
  setHandler,
} from "@temporalio/workflow";
import type {
  ProcessUploadInput,
  ProcessUploadResult,
  ApplyHopeInput,
} from "../src/temporal/types";
import { mediaService } from "../src/temporal/service";

export { processUploadWorkflow, applyHopeWorkflow } from "../src/temporal/workflow";

const finishSignal = defineSignal("finishNexusUploadTest");

function errorMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    const type = "type" in current && typeof current.type === "string" ? ` (${current.type})` : "";
    messages.push(`${current.name}${type}: ${current.message}`);
    current = "cause" in current ? current.cause : undefined;
  }
  if (current !== undefined) messages.push(String(current));
  return messages.join(" <- ");
}

async function rethrowAfterUploadCancellation(
  error: unknown,
  resultPromise: Promise<unknown>,
): Promise<never> {
  if (!isCancellation(error)) throw error;
  await CancellationScope.nonCancellable(async () => {
    try {
      await resultPromise;
    } catch (resultError) {
      if (!isCancellation(resultError)) throw resultError;
    }
  });
  throw error;
}

export async function nexusUploadCallerWorkflow(
  endpoint: string,
  input: ProcessUploadInput,
  scheduleToCloseTimeout = "25 hours",
) {
  const client = createNexusServiceClient({ service: mediaService, endpoint });
  let publishRequested = false;
  setHandler(finishSignal, () => { publishRequested = true; });

  let operation;
  try {
    operation = await client.startOperation("startUpload", input, { scheduleToCloseTimeout });
  } catch (error) {
    return { error: errorMessage(error) };
  }

  const publishResults = [];
  const resultPromise = operation.result();
  let firstCompletion:
    | { kind: "result"; upload: ProcessUploadResult }
    | { kind: "error"; error: unknown }
    | { kind: "finish" };
  try {
    firstCompletion = await Promise.race([
      resultPromise.then(
        (upload) => ({ kind: "result" as const, upload }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      condition(() => publishRequested).then(() => ({ kind: "finish" as const })),
    ]);
  } catch (error) {
    return await rethrowAfterUploadCancellation(error, resultPromise);
  }
  if (firstCompletion.kind === "result") {
    return { upload: firstCompletion.upload, publishResults };
  }
  if (firstCompletion.kind === "error") {
    return { error: errorMessage(firstCompletion.error), publishResults };
  }

  if (publishRequested) {
    try {
      publishResults.push(await client.executeOperation("publishUpload", { id: input.id }, {
        scheduleToCloseTimeout: "5 seconds",
      }));
      publishResults.push(await client.executeOperation("publishUpload", { id: input.id }, {
        scheduleToCloseTimeout: "5 seconds",
      }));
    } catch (error) {
      if (isCancellation(error)) {
        return await rethrowAfterUploadCancellation(error, resultPromise);
      }
      return { error: errorMessage(error), publishResults };
    }
  }

  try {
    return { upload: await resultPromise, publishResults };
  } catch (error) {
    if (isCancellation(error)) {
      return await rethrowAfterUploadCancellation(error, resultPromise);
    }
    return { error: errorMessage(error), publishResults };
  }
}

export async function nexusApplyHopeCallerWorkflow(
  endpoint: string,
  input: ApplyHopeInput,
  scheduleToCloseTimeout = "25 hours",
) {
  const client = createNexusServiceClient({ service: mediaService, endpoint });
  try {
    return {
      result: await client.executeOperation("applyHope", input, {
        scheduleToCloseTimeout,
      }),
    };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

export async function nexusPublishCallerWorkflow(endpoint: string, id: string) {
  const client = createNexusServiceClient({ service: mediaService, endpoint });
  try {
    return {
      result: await client.executeOperation("publishUpload", { id }, {
        scheduleToCloseTimeout: "3 seconds",
      }),
    };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
