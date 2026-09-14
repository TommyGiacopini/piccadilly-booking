import "dotenv/config";

import { pathToFileURL } from "node:url";

import type {
  NotificationWorkerEvent,
  NotificationWorkerRuntime,
} from "@/modules/notifications/application/ports";
import {
  NotificationWorkerPhaseError,
  processDueNotificationBatch,
  runNotificationWorkerLoop,
  type NotificationWorkerDependencies,
} from "@/modules/notifications/application/worker";
import { createNotificationWorkerDependencies } from "@/modules/notifications/infrastructure/notification-composition";
import { createNotificationWorkerRuntime } from "@/modules/notifications/infrastructure/notification-worker-runtime";
import { prisma } from "@/server/db/prisma";

type WorkerSignal = "SIGINT" | "SIGTERM";

export interface NotificationWorkerCliOptions {
  args?: string[];
  runtime?: NotificationWorkerRuntime;
  createDependencies?: (
    runtime: NotificationWorkerRuntime,
  ) => NotificationWorkerDependencies;
  disconnect?: () => Promise<void>;
  writeResult?: (line: string) => void;
  addSignalListener?: (signal: WorkerSignal, listener: () => void) => void;
  removeSignalListener?: (signal: WorkerSignal, listener: () => void) => void;
}

function safeTimestamp(runtime: NotificationWorkerRuntime): string {
  try {
    return runtime.timestamp();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

function safeEmit(
  runtime: NotificationWorkerRuntime,
  event: NotificationWorkerEvent,
): void {
  try {
    runtime.emit(event);
  } catch {
    // A custom logger must not alter process lifecycle.
  }
}

function safeClassification(runtime: NotificationWorkerRuntime, error: unknown) {
  try {
    return runtime.classifyFailure(error);
  } catch {
    return {
      classification: "RUNTIME_FATAL" as const,
      code: "WORKER_RUNTIME_UNCLASSIFIED" as const,
    };
  }
}

function failurePhase(error: unknown) {
  return error instanceof NotificationWorkerPhaseError
    ? error.phase
    : ("STARTUP" as const);
}

export async function runNotificationWorkerCli(
  options: NotificationWorkerCliOptions = {},
): Promise<0 | 1> {
  const runtime = options.runtime ?? createNotificationWorkerRuntime();
  const createDependencies =
    options.createDependencies ??
    ((injectedRuntime: NotificationWorkerRuntime) =>
      createNotificationWorkerDependencies({ runtime: injectedRuntime }));
  const disconnect = options.disconnect ?? (() => prisma.$disconnect());
  const writeResult =
    options.writeResult ?? ((line: string) => process.stdout.write(line));
  const addSignalListener =
    options.addSignalListener ??
    ((signal: WorkerSignal, listener: () => void) =>
      process.once(signal, listener));
  const removeSignalListener =
    options.removeSignalListener ??
    ((signal: WorkerSignal, listener: () => void) =>
      process.removeListener(signal, listener));
  const controller = new AbortController();
  const stop = () => controller.abort();
  let exitCode: 0 | 1 = 0;
  let dependencies: NotificationWorkerDependencies | null = null;
  let listenersInstalled = false;

  try {
    dependencies = createDependencies(runtime);
    addSignalListener("SIGINT", stop);
    addSignalListener("SIGTERM", stop);
    listenersInstalled = true;

    if ((options.args ?? process.argv.slice(2)).includes("--once")) {
      const result = await processDueNotificationBatch(
        dependencies,
        controller.signal,
      );
      writeResult(`${JSON.stringify(result)}\n`);
    } else {
      await runNotificationWorkerLoop(dependencies, controller.signal);
      if (controller.signal.aborted) {
        safeEmit(runtime, {
          event: "notification_worker_stopped",
          reason: "ABORTED",
          phase: "SHUTDOWN",
          code: "WORKER_RUNTIME_UNCLASSIFIED",
          exitCode: 0,
          timestamp: safeTimestamp(runtime),
        });
      }
    }
  } catch (error) {
    exitCode = 1;
    const failure = safeClassification(runtime, error);
    safeEmit(runtime, {
      event: "notification_worker_stopped",
      reason: (options.args ?? process.argv.slice(2)).includes("--once")
        ? "ONE_SHOT_FAILURE"
        : "RUNTIME_FATAL",
      phase: failurePhase(error),
      code: failure.code,
      exitCode,
      timestamp: safeTimestamp(runtime),
    });
  } finally {
    if (listenersInstalled) {
      removeSignalListener("SIGINT", stop);
      removeSignalListener("SIGTERM", stop);
    }
    try {
      await disconnect();
    } catch (error) {
      exitCode = 1;
      const failure = safeClassification(runtime, error);
      safeEmit(runtime, {
        event: "notification_worker_stopped",
        reason: "SHUTDOWN_FAILURE",
        phase: "SHUTDOWN",
        code: failure.code,
        exitCode,
        timestamp: safeTimestamp(runtime),
      });
    }
  }

  return exitCode;
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entryPoint === import.meta.url) {
  runNotificationWorkerCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.stderr.write(
        `${JSON.stringify({
          event: "notification_worker_stopped",
          reason: "RUNTIME_FATAL",
          phase: "STARTUP",
          code: "WORKER_RUNTIME_UNCLASSIFIED",
          exitCode: 1,
          timestamp: new Date().toISOString(),
        })}\n`,
      );
      process.exitCode = 1;
    });
}
