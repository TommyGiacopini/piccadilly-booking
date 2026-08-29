import type {
  Clock,
  NotificationIdGenerator,
  NotificationWorkerRepository,
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
  const now = dependencies.clock.now();
  const expired = await dependencies.repository.expirePending({
    now,
    limit: NOTIFICATION_EXPIRED_SWEEP_LIMIT,
  });
  if (signal.aborted) {
    return { expired, recovered: 0, claimed: 0, processed: 0, failed: 0 };
  }
  const recovered = await dependencies.repository.recoverExpiredLeases(now);
  if (signal.aborted) {
    return { expired, recovered, claimed: 0, processed: 0, failed: 0 };
  }
  const claimed = await dependencies.repository.claimDue({
    now,
    batchSize: NOTIFICATION_BATCH_SIZE,
    maxPerTenant: NOTIFICATION_MAX_PER_TENANT,
    leaseMilliseconds: NOTIFICATION_LEASE_MS,
  });
  let nextIndex = 0;
  let processed = 0;
  let failed = 0;

  async function processQueue(): Promise<void> {
    while (!signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const notification = claimed[index];
      if (!notification || signal.aborted) return;
      try {
        await processClaimedNotification({
          dependencies,
          notification,
          attemptCorrelationId: dependencies.ids.generate(),
          signal,
        });
      } catch {
        failed += 1;
      } finally {
        processed += 1;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(NOTIFICATION_PROCESSING_CONCURRENCY, claimed.length) },
    processQueue,
  );
  await Promise.allSettled(workers);
  return { expired, recovered, claimed: claimed.length, processed, failed };
}

export async function runNotificationWorkerLoop(
  dependencies: NotificationWorkerDependencies,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const result = await processDueNotificationBatch(dependencies, signal);
    if (signal.aborted) return;
    if (result.claimed === 0) {
      await dependencies.sleeper.wait(NOTIFICATION_POLL_MS, signal);
    }
  }
}
