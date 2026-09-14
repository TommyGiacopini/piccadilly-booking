import type {
  Clock,
  NotificationIdGenerator,
  NotificationWorkerEvent,
  NotificationWorkerFailureClassification,
  NotificationWorkerFailureCode,
  NotificationWorkerPhase,
  NotificationWorkerRepository,
  NotificationWorkerRuntime,
  Sleeper,
} from "@/modules/notifications/application/ports";
import {
  processClaimedNotification,
  type NotificationProcessorDependencies,
} from "@/modules/notifications/application/processor";

export const NOTIFICATION_BATCH_SIZE = 25;
export const NOTIFICATION_MAX_PER_TENANT = 5;
export const NOTIFICATION_LEASE_MS = 2 * 60_000;
export const NOTIFICATION_POLL_MS = 5_000;
export const NOTIFICATION_PROCESSING_CONCURRENCY = 5;
export const NOTIFICATION_EXPIRED_SWEEP_LIMIT = 100;

export interface NotificationWorkerDependencies
  extends NotificationProcessorDependencies {
  repository: NotificationWorkerRepository;
  clock: Clock;
  sleeper: Sleeper;
  ids: NotificationIdGenerator;
  runtime: NotificationWorkerRuntime;
}

export class NotificationWorkerPhaseError extends Error {
  readonly phase: NotificationWorkerPhase;
  readonly cause: unknown;

  constructor(phase: NotificationWorkerPhase, cause: unknown) {
    super("A notification worker phase failed.");
    this.name = "NotificationWorkerPhaseError";
    this.phase = phase;
    this.cause = cause;
  }
}

async function runWorkerPhase<T>(
  phase: NotificationWorkerPhase,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new NotificationWorkerPhaseError(phase, error);
  }
}

function safeEmit(
  runtime: NotificationWorkerRuntime,
  event: NotificationWorkerEvent,
): void {
  try {
    runtime.emit(event);
  } catch {
    // Observability must never alter worker control flow.
  }
}

function safeTimestamp(runtime: NotificationWorkerRuntime): string {
  try {
    return runtime.timestamp();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

function safeClassifyFailure(
  runtime: NotificationWorkerRuntime,
  error: unknown,
): {
  classification: NotificationWorkerFailureClassification;
  code: NotificationWorkerFailureCode;
} {
  try {
    return runtime.classifyFailure(error);
  } catch {
    return {
      classification: "RUNTIME_FATAL",
      code: "WORKER_RUNTIME_UNCLASSIFIED",
    };
  }
}

export async function processDueNotificationBatch(
  dependencies: NotificationWorkerDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<{
  expired: number;
  recovered: number;
  claimed: number;
  processed: number;
  failed: number;
}> {
  if (signal.aborted) {
    return { expired: 0, recovered: 0, claimed: 0, processed: 0, failed: 0 };
  }
  const now = await runWorkerPhase("CLOCK", () => dependencies.clock.now());
  const expired = await runWorkerPhase("EXPIRE_PENDING", () =>
    dependencies.repository.expirePending({
      now,
      limit: NOTIFICATION_EXPIRED_SWEEP_LIMIT,
    }),
  );
  if (signal.aborted) {
    return { expired, recovered: 0, claimed: 0, processed: 0, failed: 0 };
  }
  const recovered = await runWorkerPhase("RECOVER_EXPIRED_LEASES", () =>
    dependencies.repository.recoverExpiredLeases(now),
  );
  if (signal.aborted) {
    return { expired, recovered, claimed: 0, processed: 0, failed: 0 };
  }
  const claimed = await runWorkerPhase("CLAIM_DUE", () =>
    dependencies.repository.claimDue({
      now,
      batchSize: NOTIFICATION_BATCH_SIZE,
      maxPerTenant: NOTIFICATION_MAX_PER_TENANT,
      leaseMilliseconds: NOTIFICATION_LEASE_MS,
    }),
  );
  let nextIndex = 0;
  let processed = 0;
  let failed = 0;

  async function processQueue(): Promise<void> {
    while (!signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const notification = claimed[index];
      if (!notification || signal.aborted) return;
      let attemptCorrelationId: string | undefined;
      try {
        attemptCorrelationId = dependencies.ids.generate();
        await processClaimedNotification({
          dependencies,
          notification,
          attemptCorrelationId,
          signal,
        });
      } catch {
        if (signal.aborted) return;
        failed += 1;
        safeEmit(dependencies.runtime, {
          event: "notification_worker_item_failure",
          phase: "PROCESS_NOTIFICATION",
          code: "NOTIFICATION_PROCESSING_FAILED",
          outboxId: notification.id,
          ...(attemptCorrelationId === undefined
            ? {}
            : { attemptCorrelationId }),
          timestamp: safeTimestamp(dependencies.runtime),
        });
      } finally {
        processed += 1;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(NOTIFICATION_PROCESSING_CONCURRENCY, claimed.length) },
    processQueue,
  );
  const settlements = await Promise.allSettled(workers);
  const rejected = settlements.find(
    (settlement): settlement is PromiseRejectedResult =>
      settlement.status === "rejected",
  );
  if (rejected) {
    throw new NotificationWorkerPhaseError(
      "PROCESS_NOTIFICATION",
      rejected.reason,
    );
  }
  return { expired, recovered, claimed: claimed.length, processed, failed };
}

export async function runNotificationWorkerLoop(
  dependencies: NotificationWorkerDependencies,
  signal: AbortSignal,
): Promise<void> {
  let consecutiveFailures = 0;
  let pendingBackoff: number | null = null;

  while (!signal.aborted) {
    try {
      if (pendingBackoff !== null) {
        const backoff = pendingBackoff;
        pendingBackoff = null;
        await runWorkerPhase("POLL_WAIT", () =>
          dependencies.sleeper.wait(backoff, signal),
        );
        if (signal.aborted) return;
      }

      const result = await processDueNotificationBatch(dependencies, signal);
      if (signal.aborted) return;
      if (consecutiveFailures > 0) {
        safeEmit(dependencies.runtime, {
          event: "notification_worker_recovered",
          previousFailures: consecutiveFailures,
          timestamp: safeTimestamp(dependencies.runtime),
        });
        consecutiveFailures = 0;
      }
      if (result.claimed === 0) {
        await runWorkerPhase("POLL_WAIT", () =>
          dependencies.sleeper.wait(NOTIFICATION_POLL_MS, signal),
        );
      }
    } catch (error) {
      if (signal.aborted) return;
      const phase =
        error instanceof NotificationWorkerPhaseError
          ? error.phase
          : "STARTUP";
      const failure = safeClassifyFailure(dependencies.runtime, error);
      if (failure.classification === "RUNTIME_FATAL") {
        safeEmit(dependencies.runtime, {
          event: "notification_worker_runtime_failure",
          phase,
          classification: failure.classification,
          code: failure.code,
          consecutiveFailures: consecutiveFailures + 1,
          backoffMs: 0,
          timestamp: safeTimestamp(dependencies.runtime),
        });
        throw error;
      }

      consecutiveFailures += 1;
      pendingBackoff = dependencies.runtime.backoffMilliseconds(
        consecutiveFailures,
      );
      safeEmit(dependencies.runtime, {
        event: "notification_worker_runtime_failure",
        phase,
        classification: failure.classification,
        code: failure.code,
        consecutiveFailures,
        backoffMs: pendingBackoff,
        timestamp: safeTimestamp(dependencies.runtime),
      });
    }
  }
}
