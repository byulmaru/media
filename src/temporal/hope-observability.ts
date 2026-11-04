import * as Sentry from "@sentry/node";
import { request as httpsRequest } from "node:https";
import { performance } from "node:perf_hooks";

import type { HopeProcessingInput } from "./types";

const progressPollIntervalMs = 5_000;
const progressRequestTimeoutMs = 2_000;
const maxProgressResponseBytes = 16 * 1024;
const progressStages = ["processing", "encoding"] as const;

export interface HopeProgressSnapshot {
  stage: typeof progressStages[number];
  tileCurrent: number;
  tileTotal: number;
  iterationCurrent: number;
  iterationTotal: number;
  completedIterations: number;
  totalIterations: number;
  elapsedMs: number;
  estimatedRemainingMs: number | null;
}

export interface HopeObservedProgress extends HopeProgressSnapshot {
  observedAt: number;
  observedAtMonotonic: number;
}

export interface HopeActivityInfo {
  workflowId?: string;
  runId?: string;
  activityId?: string;
  attempt?: number;
}

export interface HopeProgressResponse {
  status: number;
  body: Uint8Array;
}

export type HopeProgressRequest = (
  url: URL,
  requestId: string,
  signal: AbortSignal,
) => Promise<HopeProgressResponse>;

export type HopeFailure = {
  type: "aborted" | "processing" | "validation" | "expired" | "source" | "unexpected";
  code: "activity_aborted" | "hope_processing" | "upload_validation" | "upload_expired" | "upload_source" | "activity_failed";
  status?: number;
};

export interface HopeProgressPoller {
  fail(): Promise<void>;
  stop(): Promise<void>;
}

export interface HopeAttemptTelemetry {
  setImageMetadata(bytes: number, width: number, height: number): void;
  startProgressPolling(apiUrl: string, requestId: string, iterations: number): HopeProgressPoller | undefined;
  recordFailure(failure: HopeFailure): void;
}

export interface HopeObservability {
  runAttempt<T>(
    input: HopeProcessingInput,
    activityInfo: HopeActivityInfo,
    operation: (telemetry: HopeAttemptTelemetry) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

type ProgressParseResult =
  | { kind: "valid"; progress: HopeProgressSnapshot }
  | { kind: "empty" }
  | {
    kind: "invalid";
    code: "invalid_response" | "request_mismatch" | "invalid_counters" | "inconsistent_total" | "stale_snapshot";
  };

const noopAttemptTelemetry: HopeAttemptTelemetry = {
  setImageMetadata() {},
  startProgressPolling() { return undefined; },
  recordFailure() {},
};

const noopObservability: HopeObservability = {
  async runAttempt<T>(_input: HopeProcessingInput, _activityInfo: HopeActivityInfo, operation: (telemetry: HopeAttemptTelemetry) => Promise<T>) {
    return operation(noopAttemptTelemetry);
  },
  async close() {},
};

function safeId(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9:._/-]+$/.test(value)
    ? value
    : undefined;
}

function parseHopeProgress(payload: unknown, requestId: string, iterations: number): ProgressParseResult {
  if (typeof payload !== "object" || payload === null || !("progress" in payload)) {
    return { kind: "invalid", code: "invalid_response" };
  }
  const raw = Reflect.get(payload, "progress");
  if (raw === null) return { kind: "empty" };
  if (typeof raw !== "object" || raw === null) return { kind: "invalid", code: "invalid_response" };

  const request = Reflect.get(raw, "requestId");
  if (request !== requestId) return { kind: "invalid", code: "request_mismatch" };

  const stage = Reflect.get(raw, "stage");
  const tileCurrent = Reflect.get(raw, "tileCurrent");
  const tileTotal = Reflect.get(raw, "tileTotal");
  const iterationCurrent = Reflect.get(raw, "iterationCurrent");
  const iterationTotal = Reflect.get(raw, "iterationTotal");
  const completedIterations = Reflect.get(raw, "completedIterations");
  const totalIterations = Reflect.get(raw, "totalIterations");
  const elapsedMs = Reflect.get(raw, "elapsedMs");
  const estimatedRemainingMs = Reflect.get(raw, "estimatedRemainingMs");
  if (
    typeof stage !== "string" || !progressStages.includes(stage as typeof progressStages[number]) ||
    typeof tileCurrent !== "number" || !Number.isSafeInteger(tileCurrent) ||
    typeof tileTotal !== "number" || !Number.isSafeInteger(tileTotal) ||
    typeof iterationCurrent !== "number" || !Number.isSafeInteger(iterationCurrent) ||
    typeof iterationTotal !== "number" || !Number.isSafeInteger(iterationTotal) ||
    typeof completedIterations !== "number" || !Number.isSafeInteger(completedIterations) ||
    typeof totalIterations !== "number" || !Number.isSafeInteger(totalIterations) ||
    typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0 ||
    !(estimatedRemainingMs === null || (
      typeof estimatedRemainingMs === "number" && Number.isFinite(estimatedRemainingMs) && estimatedRemainingMs >= 0
    ))
  ) {
    return { kind: "invalid", code: "invalid_counters" };
  }

  if (
    tileCurrent < 1 || tileCurrent > tileTotal || tileTotal < 1 ||
    iterationCurrent < 1 || iterationCurrent > iterationTotal ||
    iterationTotal !== iterations ||
    totalIterations !== tileTotal * iterationTotal ||
    !Number.isSafeInteger(totalIterations) ||
    completedIterations !== (tileCurrent - 1) * iterationTotal + iterationCurrent ||
    completedIterations < 1 || completedIterations > totalIterations
  ) {
    return { kind: "invalid", code: "invalid_counters" };
  }

  return {
    kind: "valid",
    progress: {
      stage: stage as HopeProgressSnapshot["stage"],
      tileCurrent,
      tileTotal,
      iterationCurrent,
      iterationTotal,
      completedIterations,
      totalIterations,
      elapsedMs,
      estimatedRemainingMs,
    },
  };
}

function progressAttributes(progress: HopeObservedProgress): Record<string, string | number | boolean | undefined> {
  return {
    "hope.progress.available": true,
    "hope.progress.stage": progress.stage,
    "hope.progress.tile_current": progress.tileCurrent,
    "hope.progress.tile_total": progress.tileTotal,
    "hope.progress.iteration_current": progress.iterationCurrent,
    "hope.progress.iteration_total": progress.iterationTotal,
    "hope.progress.completed_iterations": progress.completedIterations,
    "hope.progress.total_iterations": progress.totalIterations,
    "hope.progress.native_elapsed_ms": progress.elapsedMs,
    "hope.progress.observed_at_ms": progress.observedAt,
    "hope.progress.age_ms": Math.max(0, performance.now() - progress.observedAtMonotonic),
    ...(progress.estimatedRemainingMs === null
      ? {
        "hope.progress.remaining_available": false,
        "hope.progress.estimated_remaining_ms": undefined,
      }
      : {
        "hope.progress.remaining_available": true,
        "hope.progress.estimated_remaining_ms": progress.estimatedRemainingMs,
      }),
  };
}

function errorAttributes(code?: string): Record<string, string | number | boolean> {
  return code === undefined
    ? { "hope.progress.available": false, "hope.progress.error": false }
    : {
      "hope.progress.available": false,
      "hope.progress.error": true,
      "hope.progress.error_code": code,
    };
}

function requestHopeProgress(url: URL, requestId: string, signal: AbortSignal): Promise<HopeProgressResponse> {
  return new Promise((resolve, reject) => {
    const combinedSignal = AbortSignal.any([signal, AbortSignal.timeout(progressRequestTimeoutMs)]);
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      reject(new Error("Hope progress request failed"));
    };
    const request = httpsRequest(url, {
      method: "GET",
      headers: { "X-Hope-Request-Id": requestId },
      agent: false,
      signal: combinedSignal,
    }, (response) => {
      const contentLength = response.headers["content-length"];
      if (contentLength !== undefined) {
        if (typeof contentLength !== "string" || !/^\d+$/.test(contentLength)) {
          response.destroy();
          fail();
          return;
        }
        const length = Number(contentLength);
        if (!Number.isSafeInteger(length) || length > maxProgressResponseBytes) {
          response.destroy();
          fail();
          return;
        }
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | Uint8Array) => {
        size += chunk.byteLength;
        if (size > maxProgressResponseBytes) {
          response.destroy();
          fail();
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("error", fail);
      response.once("end", () => {
        if (settled) return;
        if (contentLength !== undefined && Number(contentLength) !== size) {
          fail();
          return;
        }
        settled = true;
        resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks, size) });
      });
    });
    request.once("error", fail);
    request.end();
  });
}

function isPublicDsn(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username.length > 0 && url.password === "" &&
      /^\/[0-9]+$/.test(url.pathname) && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function warnTelemetryFailure(): void {
  try {
    console.warn("Hope telemetry is unavailable; continuing without telemetry");
  } catch {
    return;
  }
}

export function createHopeObservability(
  enabled: boolean,
  progressRequest: HopeProgressRequest = requestHopeProgress,
  startNewTrace: typeof Sentry.startNewTrace = Sentry.startNewTrace,
): HopeObservability {
  if (!enabled) return noopObservability;

  return {
    async runAttempt<T>(
      input: HopeProcessingInput,
      activityInfo: HopeActivityInfo,
      operation: (telemetry: HopeAttemptTelemetry) => Promise<T>,
    ) {
      let businessPromise: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> | undefined;
      let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
      const runWithoutTrace = async () => {
        businessPromise ??= (async () => {
          try {
            return { ok: true as const, value: await operation(noopAttemptTelemetry) };
          } catch (error) {
            return { ok: false as const, error };
          }
        })();
        outcome = await businessPromise;
      };
      const workflowId = safeId(activityInfo.workflowId);
      const runId = safeId(activityInfo.runId);
      const activityId = safeId(activityInfo.activityId);

      try {
        outcome = await startNewTrace(() => Sentry.withIsolationScope(() => Sentry.startSpan({
          name: "hope.prepare",
          op: "task",
          attributes: {
            ...(workflowId ? { "temporal.workflow_id": workflowId } : {}),
            ...(runId ? { "temporal.run_id": runId } : {}),
            ...(activityId ? { "temporal.activity_id": activityId } : {}),
            ...(Number.isSafeInteger(activityInfo.attempt) && activityInfo.attempt! > 0
              ? { "temporal.activity_attempt": activityInfo.attempt! }
              : {}),
            "hope.request_id": input.requestId,
            "hope.algorithm": input.hope.algorithm,
            "hope.iterations": input.hope.iterations,
            "hope.intensity": input.hope.intensity,
            "hope.max_edge": input.maxEdge,
          },
        }, async (rootSpan) => {
          let lastProgress: HopeObservedProgress | undefined;
          let lastProgressErrorCode: string | undefined;
          let pollFailureWarned = false;
          let lastCheckpointAt: number | undefined;
          let lastCheckpointProgress: HopeObservedProgress | undefined;
          let lastFailure: HopeFailure | undefined;
          let failureCaptured = false;
          const activityStartedAt = performance.now();
          const applyAttributes = (
            attributes: Record<string, string | number | boolean | undefined>,
            span = rootSpan,
          ) => {
            try {
              for (const [key, value] of Object.entries(attributes)) span.setAttribute(key, value);
            } catch {
              warnTelemetryFailure();
            }
          };
          const snapshotAttributes = () => lastProgress
            ? {
              ...progressAttributes(lastProgress),
              "hope.progress.error": lastProgressErrorCode !== undefined,
              "hope.progress.poll_error": lastProgressErrorCode !== undefined,
              ...(lastProgressErrorCode ? { "hope.progress.error_code": lastProgressErrorCode } : {}),
            }
            : {
              ...errorAttributes(lastProgressErrorCode),
              "hope.progress.poll_error": lastProgressErrorCode !== undefined,
            };
          const checkpoint = (kind: "first" | "changed" | "tile_boundary" | "stage_boundary" | "terminal") => {
            try {
              Sentry.startSpan({
                name: "hope.progress",
                op: "hope.checkpoint",
                attributes: {
                  "hope.progress.checkpoint": kind,
                  ...snapshotAttributes(),
                  "hope.activity_elapsed_ms": Math.max(0, performance.now() - activityStartedAt),
                  "hope.progress.poll_error": lastProgressErrorCode !== undefined,
                  ...(lastFailure ? {
                    "hope.failure.type": lastFailure.type,
                    "hope.failure.code": lastFailure.code,
                    ...(lastFailure.status === undefined ? {} : { "hope.failure.status": lastFailure.status }),
                  } : {}),
                },
              }, () => undefined);
              lastCheckpointAt = performance.now();
              lastCheckpointProgress = lastProgress;
            } catch {
              warnTelemetryFailure();
            }
          };
          const telemetry: HopeAttemptTelemetry = {
            setImageMetadata(bytes, width, height) {
              if (![bytes, width, height].every(Number.isSafeInteger) || bytes < 0 || width < 1 || height < 1) return;
              applyAttributes({
                "hope.image.bytes": bytes,
                "hope.image.width": width,
                "hope.image.height": height,
              });
            },
            startProgressPolling(apiUrl, requestId, iterations) {
              let stopped = false;
              let interval: ReturnType<typeof setInterval> | undefined;
              let requestController: AbortController | undefined;
              let inFlight: Promise<void> | undefined;
              let progressUrl: URL;
              try {
                progressUrl = new URL("/progress", apiUrl);
              } catch {
                warnTelemetryFailure();
                return undefined;
              }
              const applyPollError = (code: string) => {
                if (!pollFailureWarned) {
                  pollFailureWarned = true;
                  warnTelemetryFailure();
                }
                lastProgressErrorCode = code;
                applyAttributes({
                  ...snapshotAttributes(),
                  "hope.progress.error": true,
                  "hope.progress.error_code": code,
                  "hope.progress.poll_error": true,
                });
              };
              const clearPollError = () => {
                lastProgressErrorCode = undefined;
                applyAttributes({
                  ...snapshotAttributes(),
                  "hope.progress.error": false,
                  "hope.progress.poll_error": false,
                });
                try {
                  rootSpan.setAttribute("hope.progress.error_code", undefined);
                  if (lastProgress?.estimatedRemainingMs === null) {
                    rootSpan.setAttribute("hope.progress.estimated_remaining_ms", undefined);
                  }
                } catch {
                  warnTelemetryFailure();
                }
              };
              const poll = async (final: boolean) => {
                if (stopped && !final) return;
                let controller: AbortController | undefined;
                try {
                  controller = new AbortController();
                  if (!final) requestController = controller;
                  const response = await progressRequest(progressUrl, requestId, controller.signal);
                  if (stopped && !final) return;
                  if (response.status !== 200 || response.body.byteLength > maxProgressResponseBytes) {
                    applyPollError(response.body.byteLength > maxProgressResponseBytes
                      ? "response_too_large"
                      : "request_failed");
                    return;
                  }
                  let payload: unknown;
                  try {
                    payload = JSON.parse(Buffer.from(response.body).toString("utf8"));
                  } catch {
                    applyPollError("invalid_response");
                    return;
                  }
                  const parsed = parseHopeProgress(payload, requestId, iterations);
                  if (parsed.kind === "empty") {
                    clearPollError();
                    return;
                  }
                  if (parsed.kind === "invalid") {
                    applyPollError(parsed.code);
                    return;
                  }
                  if (lastProgress && (
                    parsed.progress.tileTotal !== lastProgress.tileTotal ||
                    parsed.progress.totalIterations !== lastProgress.totalIterations
                  )) {
                    applyPollError("inconsistent_total");
                    return;
                  }
                  if (lastProgress && (
                    parsed.progress.completedIterations < lastProgress.completedIterations ||
                    parsed.progress.elapsedMs < lastProgress.elapsedMs
                  )) {
                    applyPollError("stale_snapshot");
                    return;
                  }
                  lastProgress = {
                    ...parsed.progress,
                    observedAt: Date.now(),
                    observedAtMonotonic: performance.now(),
                  };
                  clearPollError();

                  let kind: "first" | "changed" | "tile_boundary" | "stage_boundary" | undefined;
                  if (!lastCheckpointProgress) {
                    kind = "first";
                  } else if (
                    lastCheckpointProgress.completedIterations !== lastProgress.completedIterations ||
                    lastCheckpointProgress.tileTotal !== lastProgress.tileTotal ||
                    lastCheckpointProgress.elapsedMs !== lastProgress.elapsedMs ||
                    lastCheckpointProgress.estimatedRemainingMs !== lastProgress.estimatedRemainingMs ||
                    lastCheckpointProgress.stage !== lastProgress.stage ||
                    lastCheckpointProgress.tileCurrent !== lastProgress.tileCurrent
                  ) {
                    if (lastCheckpointProgress.tileCurrent !== lastProgress.tileCurrent) kind = "tile_boundary";
                    else if (lastCheckpointProgress.stage !== lastProgress.stage) kind = "stage_boundary";
                    else if (lastCheckpointAt !== undefined && performance.now() - lastCheckpointAt >= 30_000) kind = "changed";
                  }
                  if (kind) checkpoint(kind);
                } catch {
                  if (!final && stopped) return;
                  applyPollError("request_failed");
                } finally {
                  if (controller && requestController === controller) requestController = undefined;
                }
              };
              try {
                interval = setInterval(() => {
                  if (stopped || inFlight) return;
                  inFlight = poll(false).finally(() => { inFlight = undefined; });
                }, progressPollIntervalMs);
              } catch {
                warnTelemetryFailure();
                return undefined;
              }
              return {
                async stop() {
                  stopped = true;
                  try {
                    if (interval !== undefined) clearInterval(interval);
                    requestController?.abort();
                  } catch {
                    warnTelemetryFailure();
                  }
                  await inFlight?.catch(() => undefined);
                },
                async fail() {
                  await this.stop();
                  await poll(true);
                },
              };
            },
            recordFailure(failure) {
              if (failureCaptured) return;
              failureCaptured = true;
              lastFailure = failure;
              const details = {
                "hope.failure.type": failure.type,
                "hope.failure.code": failure.code,
                ...(failure.status === undefined ? {} : { "hope.failure.status": failure.status }),
                ...snapshotAttributes(),
              };
              applyAttributes(details);
            },
          };

          businessPromise = (async () => {
            try {
              return { ok: true as const, value: await operation(telemetry) };
            } catch (error) {
              if (!failureCaptured) {
                telemetry.recordFailure({ type: "unexpected", code: "activity_failed" });
              }
              return { ok: false as const, error };
            } finally {
              applyAttributes({
                ...snapshotAttributes(),
                "hope.activity_elapsed_ms": Math.max(0, performance.now() - activityStartedAt),
              });
              checkpoint("terminal");
            }
          })();
          const operationOutcome = await businessPromise;
          outcome = operationOutcome;
          if (!operationOutcome.ok) {
            rootSpan.setStatus({ code: 2 });
            const failure = lastFailure ?? { type: "unexpected", code: "activity_failed" };
            const details = {
              "hope.failure.type": failure.type,
              "hope.failure.code": failure.code,
              ...(failure.status === undefined ? {} : { "hope.failure.status": failure.status }),
              ...snapshotAttributes(),
              "hope.activity_elapsed_ms": Math.max(0, performance.now() - activityStartedAt),
            };
            try {
              Sentry.captureException(new Error("Hope processing failed"), {
                tags: { hope_failure_type: failure.type, hope_failure_code: failure.code },
                extra: details,
              });
            } catch {
              warnTelemetryFailure();
            }
          }
          return operationOutcome;
        })));
      } catch {
        warnTelemetryFailure();
        if (businessPromise) outcome = await businessPromise;
        else await runWithoutTrace();
      }
      if (!outcome) {
        if (businessPromise) outcome = await businessPromise;
        else await runWithoutTrace();
      }
      if (!outcome) throw new Error("Hope activity outcome unavailable");
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
    async close() {
      try {
        if (!await Sentry.close(2_000)) warnTelemetryFailure();
      } catch {
        warnTelemetryFailure();
      }
    },
  };
}

export function initializeHopeObservability(config: {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
}): HopeObservability {
  if (!config.SENTRY_DSN) return noopObservability;
  if (
    !isPublicDsn(config.SENTRY_DSN) ||
    (config.SENTRY_ENVIRONMENT !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(config.SENTRY_ENVIRONMENT)) ||
    (config.SENTRY_RELEASE !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(config.SENTRY_RELEASE))
  ) {
    warnTelemetryFailure();
    return noopObservability;
  }
  try {
    Sentry.init({
      dsn: config.SENTRY_DSN,
      environment: config.SENTRY_ENVIRONMENT,
      release: config.SENTRY_RELEASE,
      defaultIntegrations: false,
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
      tracesSampleRate: 1,
      traceLifecycle: "stream",
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
    });
    if (!Sentry.isInitialized()) {
      warnTelemetryFailure();
      return noopObservability;
    }
    return createHopeObservability(true);
  } catch {
    warnTelemetryFailure();
    return noopObservability;
  }
}

export { parseHopeProgress };
