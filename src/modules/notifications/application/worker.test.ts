import { describe, expect, it } from "vitest";

import type {
  ClaimedNotification,
  NotificationProvider,
  NotificationProviderResult,
  NotificationWorkerRepository,
  Sleeper,
} from "@/modules/notifications/application/ports";
import {
  NOTIFICATION_POLL_MS,
  NOTIFICATION_PROCESSING_CONCURRENCY,
  processDueNotificationBatch,
  runNotificationWorkerLoop,
} from "@/modules/notifications/application/worker";

const now = new Date("2028-01-01T10:00:00.000Z");

function claimed(
  channel: "WHATSAPP" | "EMAIL",
  index: number,
): ClaimedNotification {
  return {
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    restaurantId: "20000000-0000-4000-8000-000000000001",
    reservationId: "20000000-0000-4000-8000-000000000002",
    reservationVersion: 1,
    eventGroupId: "20000000-0000-4000-8000-000000000003",
    eventType: "RESERVATION_CONFIRMED",
    channel,
    strategy: "WHATSAPP_AND_EMAIL_PARALLEL",
    destination: channel === "WHATSAPP" ? "+39000000000" : "ada@example.test",
    payload: {
      schemaVersion: 1,
      templateKey: "RESERVATION_CONFIRMED",
      templateVersion: 1,
      locale: "IT",
      params: {
        customerFirstName: "Ada",
        restaurantName: "Piccadilly",
        localDate: "2028-01-02",
        serviceType: "DINNER",
        arrivalTime: "20:00",
        partySize: 2,
      },
    },
    expiresAt: new Date("2028-01-02T10:00:00.000Z"),
    attemptCount: 0,
    maxAttempts: 4,
    idempotencyKey: String(index).padStart(64, "a"),
    originCorrelationId: "20000000-0000-4000-8000-000000000004",
    leaseToken: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function passiveSleeper(): Sleeper {
  return {
    wait: async (_milliseconds, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  };
}

function repositoryFor(
  notifications: ClaimedNotification[],
  onFinalize?: (notification: ClaimedNotification) => void,
): NotificationWorkerRepository {
  return {
    expirePending: async () => 0,
    recoverExpiredLeases: async () => 0,
    claimDue: async () => notifications,
    startAttempt: async (input) => ({
      notification: { ...input.notification, attemptCount: 1 },
      attemptNumber: 1,
      attemptCorrelationId: input.attemptCorrelationId,
      providerKind:
        input.notification.channel === "WHATSAPP"
          ? "SIMULATED_WHATSAPP"
          : "SIMULATED_EMAIL",
    }),
    confirmProviderCall: async () => true,
    finalizeAttempt: async (input) => {
      onFinalize?.(input.attempt.notification);
      return input.result.type === "SUCCESS" ? "SUCCEEDED" : "PENDING";
    },
  };
}

function workerDependencies(input: {
  repository: NotificationWorkerRepository;
  whatsappProvider: NotificationProvider;
  emailProvider: NotificationProvider;
}) {
  let id = 0;
  return {
    ...input,
    clock: { now: () => now },
    sleeper: passiveSleeper(),
    ids: {
      generate: () =>
        `40000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    },
  };
}

const success: NotificationProviderResult = {
  type: "SUCCESS",
  providerReference: "sim-success",
  deduplicated: false,
};

describe("notification worker loop", () => {
  it("uses the injected sleeper and stops before another claim after abort", async () => {
    const controller = new AbortController();
    let expireCalls = 0;
    let recoverCalls = 0;
    let claimCalls = 0;
    let sleeperCalls = 0;
    const repository: NotificationWorkerRepository = {
      expirePending: async () => {
        expireCalls += 1;
        return 0;
      },
      recoverExpiredLeases: async () => {
        recoverCalls += 1;
        return 0;
      },
      claimDue: async () => {
        claimCalls += 1;
        return [];
      },
      startAttempt: async () => null,
      confirmProviderCall: async () => false,
      finalizeAttempt: async () => "STALE",
    };

    await runNotificationWorkerLoop(
      {
        repository,
        whatsappProvider: { send: async () => success },
        emailProvider: { send: async () => success },
        clock: { now: () => now },
        sleeper: {
          wait: async (milliseconds, signal) => {
            sleeperCalls += 1;
            expect(milliseconds).toBe(NOTIFICATION_POLL_MS);
            expect(signal).toBe(controller.signal);
            controller.abort();
          },
        },
        ids: { generate: () => "40000000-0000-4000-8000-000000000001" },
      },
      controller.signal,
    );

    expect({ expireCalls, recoverCalls, claimCalls, sleeperCalls }).toEqual({
      expireCalls: 1,
      recoverCalls: 1,
      claimCalls: 1,
      sleeperCalls: 1,
    });
  });

  it("starts email before a slow parallel WhatsApp leg completes", async () => {
    const whatsapp = deferred<NotificationProviderResult>();
    const emailFinalized = deferred<void>();
    let whatsappStarted = false;
    let emailStarted = false;
    const repository = repositoryFor(
      [claimed("WHATSAPP", 1), claimed("EMAIL", 2)],
      (notification) => {
        if (notification.channel === "EMAIL") emailFinalized.resolve();
      },
    );
    const processing = processDueNotificationBatch(
      workerDependencies({
        repository,
        whatsappProvider: {
          send: async () => {
            whatsappStarted = true;
            return whatsapp.promise;
          },
        },
        emailProvider: {
          send: async () => {
            emailStarted = true;
            return success;
          },
        },
      }),
    );

    await emailFinalized.promise;
    expect({ whatsappStarted, emailStarted }).toEqual({
      whatsappStarted: true,
      emailStarted: true,
    });
    whatsapp.resolve(success);
    await expect(processing).resolves.toEqual({
      expired: 0,
      recovered: 0,
      claimed: 2,
      processed: 2,
      failed: 0,
    });
  });

  it("starts WhatsApp before a slow parallel email leg completes", async () => {
    const email = deferred<NotificationProviderResult>();
    const whatsappFinalized = deferred<void>();
    let whatsappStarted = false;
    let emailStarted = false;
    const repository = repositoryFor(
      [claimed("EMAIL", 2), claimed("WHATSAPP", 1)],
      (notification) => {
        if (notification.channel === "WHATSAPP") whatsappFinalized.resolve();
      },
    );
    const processing = processDueNotificationBatch(
      workerDependencies({
        repository,
        whatsappProvider: {
          send: async () => {
            whatsappStarted = true;
            return success;
          },
        },
        emailProvider: {
          send: async () => {
            emailStarted = true;
            return email.promise;
          },
        },
      }),
    );

    await whatsappFinalized.promise;
    expect({ whatsappStarted, emailStarted }).toEqual({
      whatsappStarted: true,
      emailStarted: true,
    });
    email.resolve(success);
    await expect(processing).resolves.toMatchObject({
      claimed: 2,
      processed: 2,
      failed: 0,
    });
  });

  it("aborts active calls and does not start queued work after shutdown", async () => {
    expect(NOTIFICATION_PROCESSING_CONCURRENCY).toBe(5);
    const controller = new AbortController();
    const notifications = Array.from({ length: 6 }, (_, index) =>
      claimed("WHATSAPP", index + 1),
    );
    let claimCalls = 0;
    let startedAttempts = 0;
    let finalizedAttempts = 0;
    const providerSignals: AbortSignal[] = [];
    const repository: NotificationWorkerRepository = {
      ...repositoryFor(notifications),
      claimDue: async () => {
        claimCalls += 1;
        return notifications;
      },
      startAttempt: async (input) => {
        startedAttempts += 1;
        return {
          notification: { ...input.notification, attemptCount: 1 },
          attemptNumber: 1,
          attemptCorrelationId: input.attemptCorrelationId,
          providerKind: "SIMULATED_WHATSAPP",
        };
      },
      finalizeAttempt: async () => {
        finalizedAttempts += 1;
        return "STALE";
      },
    };
    const provider: NotificationProvider = {
      send: async (_request, options) => {
        providerSignals.push(options.signal);
        if (providerSignals.length === NOTIFICATION_PROCESSING_CONCURRENCY) {
          controller.abort();
        }
        return new Promise<NotificationProviderResult>(() => undefined);
      },
    };

    await runNotificationWorkerLoop(
      workerDependencies({
        repository,
        whatsappProvider: provider,
        emailProvider: provider,
      }),
      controller.signal,
    );

    expect(controller.signal.aborted).toBe(true);
    expect(providerSignals).toHaveLength(NOTIFICATION_PROCESSING_CONCURRENCY);
    expect(providerSignals.every((signal) => signal.aborted)).toBe(true);
    expect(startedAttempts).toBe(NOTIFICATION_PROCESSING_CONCURRENCY);
    expect(finalizedAttempts).toBe(0);
    expect(claimCalls).toBe(1);
  });
});
