import { describe, expect, it } from "vitest";

import type {
  ClaimedNotification,
  NotificationProvider,
  NotificationProviderResult,
  NotificationWorkerEvent,
  NotificationWorkerRepository,
  NotificationWorkerRuntime,
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
  runtime?: NotificationWorkerRuntime;
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
    runtime: input.runtime ?? runtimeRecorder().runtime,
  };
}

function runtimeRecorder(input?: {
  classification?: "RUNTIME_RECOVERABLE" | "RUNTIME_FATAL";
}) {
  const events: NotificationWorkerEvent[] = [];
  const runtime: NotificationWorkerRuntime = {
    classifyFailure: () => ({
      classification: input?.classification ?? "RUNTIME_RECOVERABLE",
      code:
        input?.classification === "RUNTIME_FATAL"
          ? "WORKER_RUNTIME_UNCLASSIFIED"
          : "DB_CONNECTION_UNAVAILABLE",
    }),
    backoffMilliseconds: (failure) =>
      [1_000, 2_000, 5_000, 10_000, 30_000][
        Math.min(Math.max(failure, 1), 5) - 1
      ]!,
    timestamp: () => now.toISOString(),
    emit: (event) => events.push(event),
  };
  return { events, runtime };
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
        runtime: runtimeRecorder().runtime,
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

  it("continues with later notifications after a per-item failure and emits a sanitized event", async () => {
    const notifications = [claimed("WHATSAPP", 1), claimed("EMAIL", 2)];
    const runtime = runtimeRecorder();
    const finalized: string[] = [];
    const repository = repositoryFor(notifications, (notification) => {
      finalized.push(notification.id);
    });
    const originalStartAttempt = repository.startAttempt;
    repository.startAttempt = async (input) => {
      if (input.notification.id === notifications[0]!.id) {
        throw Object.assign(new Error("hostile raw error"), {
          code: "ECONNRESET",
        });
      }
      return originalStartAttempt(input);
    };

    const result = await processDueNotificationBatch(
      workerDependencies({
        repository,
        whatsappProvider: { send: async () => success },
        emailProvider: { send: async () => success },
        runtime: runtime.runtime,
      }),
    );

    expect(result).toEqual({
      expired: 0,
      recovered: 0,
      claimed: 2,
      processed: 2,
      failed: 1,
    });
    expect(finalized).toEqual([notifications[1]!.id]);
    expect(runtime.events).toContainEqual({
      event: "notification_worker_item_failure",
      phase: "PROCESS_NOTIFICATION",
      code: "NOTIFICATION_PROCESSING_FAILED",
      outboxId: notifications[0]!.id,
      attemptCorrelationId: "40000000-0000-4000-8000-000000000001",
      timestamp: now.toISOString(),
    });
  });

  it("accounts for an ID generation failure and continues the claimed queue", async () => {
    const notifications = [claimed("WHATSAPP", 1), claimed("EMAIL", 2)];
    const runtime = runtimeRecorder();
    const finalized: string[] = [];
    const dependencies = workerDependencies({
      repository: repositoryFor(notifications, (notification) => {
        finalized.push(notification.id);
      }),
      whatsappProvider: { send: async () => success },
      emailProvider: { send: async () => success },
      runtime: runtime.runtime,
    });
    let generateCalls = 0;
    dependencies.ids.generate = () => {
      generateCalls += 1;
      if (generateCalls === 1) {
        throw new Error("id-generation-canary-must-not-be-logged");
      }
      return "40000000-0000-4000-8000-000000000002";
    };

    const result = await processDueNotificationBatch(dependencies);

    expect(result).toEqual({
      expired: 0,
      recovered: 0,
      claimed: 2,
      processed: 2,
      failed: 1,
    });
    expect(finalized).toEqual([notifications[1]!.id]);
    const failureEvents = runtime.events.filter(
      (event) => event.event === "notification_worker_item_failure",
    );
    expect(failureEvents).toEqual([
      {
        event: "notification_worker_item_failure",
        phase: "PROCESS_NOTIFICATION",
        code: "NOTIFICATION_PROCESSING_FAILED",
        outboxId: notifications[0]!.id,
        timestamp: now.toISOString(),
      },
    ]);
    expect(failureEvents[0]).not.toHaveProperty("attemptCorrelationId");
    expect(JSON.stringify(runtime.events)).not.toContain(
      "id-generation-canary-must-not-be-logged",
    );
  });

  it("propagates an unexpected queue rejection at the processing boundary", async () => {
    const notifications = new Proxy([claimed("WHATSAPP", 1)], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("unexpected-queue-access");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await expect(
      processDueNotificationBatch(
        workerDependencies({
          repository: repositoryFor(notifications),
          whatsappProvider: { send: async () => success },
          emailProvider: { send: async () => success },
        }),
      ),
    ).rejects.toMatchObject({ phase: "PROCESS_NOTIFICATION" });
  });

  it.each([
    "CLOCK",
    "EXPIRE_PENDING",
    "RECOVER_EXPIRED_LEASES",
    "CLAIM_DUE",
    "POLL_WAIT",
  ] as const)(
    "recovers from an allow-listed %s failure and processes the next batch",
    async (phase) => {
      const controller = new AbortController();
      const runtime = runtimeRecorder();
      let clockCalls = 0;
      let expireCalls = 0;
      let recoverCalls = 0;
      let claimCalls = 0;
      let pollCalls = 0;
      const repository: NotificationWorkerRepository = {
        expirePending: async () => {
          expireCalls += 1;
          if (phase === "EXPIRE_PENDING" && expireCalls === 1) {
            throw Object.assign(new Error("not logged"), {
              code: "ECONNREFUSED",
            });
          }
          return 0;
        },
        recoverExpiredLeases: async () => {
          recoverCalls += 1;
          if (phase === "RECOVER_EXPIRED_LEASES" && recoverCalls === 1) {
            throw Object.assign(new Error("not logged"), { code: "P1001" });
          }
          return 0;
        },
        claimDue: async () => {
          claimCalls += 1;
          if (phase === "CLAIM_DUE" && claimCalls === 1) {
            throw Object.assign(new Error("not logged"), { code: "P2024" });
          }
          return [];
        },
        startAttempt: async () => null,
        confirmProviderCall: async () => false,
        finalizeAttempt: async () => "STALE",
      };
      const dependencies = workerDependencies({
        repository,
        whatsappProvider: { send: async () => success },
        emailProvider: { send: async () => success },
        runtime: runtime.runtime,
      });
      dependencies.clock = {
        now: () => {
          clockCalls += 1;
          if (phase === "CLOCK" && clockCalls === 1) {
            throw Object.assign(new Error("not logged"), {
              code: "ETIMEDOUT",
            });
          }
          return now;
        },
      };
      dependencies.sleeper = {
        wait: async (milliseconds) => {
          if (milliseconds === NOTIFICATION_POLL_MS) {
            pollCalls += 1;
            if (phase === "POLL_WAIT" && pollCalls === 1) {
              throw Object.assign(new Error("not logged"), {
                code: "ECONNRESET",
              });
            }
            controller.abort();
          }
        },
      };

      await expect(
        runNotificationWorkerLoop(dependencies, controller.signal),
      ).resolves.toBeUndefined();
      expect(claimCalls).toBeGreaterThanOrEqual(1);
      expect(runtime.events).toContainEqual(
        expect.objectContaining({
          event: "notification_worker_runtime_failure",
          phase,
          classification: "RUNTIME_RECOVERABLE",
          consecutiveFailures: 1,
          backoffMs: 1_000,
        }),
      );
      expect(runtime.events).toContainEqual(
        expect.objectContaining({
          event: "notification_worker_recovered",
          previousFailures: 1,
        }),
      );
    },
  );

  it("uses the exact capped runtime backoff sequence", async () => {
    const controller = new AbortController();
    const runtime = runtimeRecorder();
    const waits: number[] = [];
    let expireCalls = 0;
    const repository: NotificationWorkerRepository = {
      ...repositoryFor([]),
      expirePending: async () => {
        expireCalls += 1;
        if (expireCalls <= 6) {
          throw Object.assign(new Error("not logged"), { code: "P1001" });
        }
        return 0;
      },
    };
    const dependencies = workerDependencies({
      repository,
      whatsappProvider: { send: async () => success },
      emailProvider: { send: async () => success },
      runtime: runtime.runtime,
    });
    dependencies.sleeper = {
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        if (expireCalls > 6) controller.abort();
      },
    };

    await runNotificationWorkerLoop(dependencies, controller.signal);

    expect(waits).toEqual([
      1_000,
      2_000,
      5_000,
      10_000,
      30_000,
      30_000,
      NOTIFICATION_POLL_MS,
    ]);
  });

  it("resets runtime backoff after a completed batch", async () => {
    const controller = new AbortController();
    const runtime = runtimeRecorder();
    const backoffs: number[] = [];
    let expireCalls = 0;
    let completedBatches = 0;
    const repository: NotificationWorkerRepository = {
      ...repositoryFor([]),
      expirePending: async () => {
        expireCalls += 1;
        if (expireCalls === 1 || expireCalls === 3) {
          throw Object.assign(new Error("not logged"), { code: "P1001" });
        }
        completedBatches += 1;
        return 0;
      },
    };
    const dependencies = workerDependencies({
      repository,
      whatsappProvider: { send: async () => success },
      emailProvider: { send: async () => success },
      runtime: runtime.runtime,
    });
    dependencies.sleeper = {
      wait: async (milliseconds) => {
        if (milliseconds !== NOTIFICATION_POLL_MS) backoffs.push(milliseconds);
        if (milliseconds === NOTIFICATION_POLL_MS && completedBatches === 1) {
          return;
        }
        if (milliseconds === NOTIFICATION_POLL_MS && completedBatches === 2) {
          controller.abort();
        }
      },
    };

    await runNotificationWorkerLoop(dependencies, controller.signal);

    expect(backoffs).toEqual([1_000, 1_000]);
    expect(
      runtime.events.filter(
        (event) => event.event === "notification_worker_recovered",
      ),
    ).toHaveLength(2);
  });

  it("fails fast for an unknown runtime error without sleeping", async () => {
    const runtime = runtimeRecorder({ classification: "RUNTIME_FATAL" });
    let sleeps = 0;
    const dependencies = workerDependencies({
      repository: {
        ...repositoryFor([]),
        expirePending: async () => {
          throw new Error("unknown and hostile");
        },
      },
      whatsappProvider: { send: async () => success },
      emailProvider: { send: async () => success },
      runtime: runtime.runtime,
    });
    dependencies.sleeper = {
      wait: async () => {
        sleeps += 1;
      },
    };

    await expect(
      runNotificationWorkerLoop(dependencies, new AbortController().signal),
    ).rejects.toMatchObject({ phase: "EXPIRE_PENDING" });
    expect(sleeps).toBe(0);
    expect(runtime.events).toContainEqual(
      expect.objectContaining({
        event: "notification_worker_runtime_failure",
        classification: "RUNTIME_FATAL",
        code: "WORKER_RUNTIME_UNCLASSIFIED",
        backoffMs: 0,
      }),
    );
  });

  it("aborts during runtime backoff without another claim or failure event", async () => {
    const controller = new AbortController();
    const runtime = runtimeRecorder();
    let expireCalls = 0;
    let claimCalls = 0;
    const dependencies = workerDependencies({
      repository: {
        ...repositoryFor([]),
        expirePending: async () => {
          expireCalls += 1;
          throw Object.assign(new Error("not logged"), { code: "P1001" });
        },
        claimDue: async () => {
          claimCalls += 1;
          return [];
        },
      },
      whatsappProvider: { send: async () => success },
      emailProvider: { send: async () => success },
      runtime: runtime.runtime,
    });
    dependencies.sleeper = {
      wait: async (_milliseconds, signal) => {
        controller.abort();
        expect(signal.aborted).toBe(true);
      },
    };

    await expect(
      runNotificationWorkerLoop(dependencies, controller.signal),
    ).resolves.toBeUndefined();
    expect(expireCalls).toBe(1);
    expect(claimCalls).toBe(0);
    expect(
      runtime.events.filter(
        (event) => event.event === "notification_worker_runtime_failure",
      ),
    ).toHaveLength(1);
  });

  it("continues when the injected event logger throws", async () => {
    const runtime = runtimeRecorder();
    runtime.runtime.emit = () => {
      throw new Error("logger failure");
    };
    const notifications = [claimed("WHATSAPP", 1), claimed("EMAIL", 2)];
    const repository = repositoryFor(notifications);
    const originalStartAttempt = repository.startAttempt;
    repository.startAttempt = async (input) => {
      if (input.notification.id === notifications[0]!.id) {
        throw new Error("item failure");
      }
      return originalStartAttempt(input);
    };

    await expect(
      processDueNotificationBatch(
        workerDependencies({
          repository,
          whatsappProvider: { send: async () => success },
          emailProvider: { send: async () => success },
          runtime: runtime.runtime,
        }),
      ),
    ).resolves.toMatchObject({ processed: 2, failed: 1 });
  });
});
