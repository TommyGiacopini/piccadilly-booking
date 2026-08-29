import { describe, expect, it } from "vitest";

import type {
  ClaimedNotification,
  NotificationProvider,
  NotificationProviderResult,
  NotificationWorkerRepository,
  Sleeper,
} from "@/modules/notifications/application/ports";
import {
  NOTIFICATION_PROVIDER_DEADLINE_MS,
  processClaimedNotification,
} from "@/modules/notifications/application/processor";

const startedAt = new Date("2028-01-01T10:00:00.000Z");
const notification: ClaimedNotification = {
  id: "10000000-0000-4000-8000-000000000001",
  restaurantId: "10000000-0000-4000-8000-000000000002",
  reservationId: "10000000-0000-4000-8000-000000000003",
  reservationVersion: 1,
  eventGroupId: "10000000-0000-4000-8000-000000000004",
  eventType: "RESERVATION_CONFIRMED",
  channel: "WHATSAPP",
  strategy: "WHATSAPP_ONLY",
  destination: "+39000000000",
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
  idempotencyKey: "a".repeat(64),
  originCorrelationId: "10000000-0000-4000-8000-000000000005",
  leaseToken: "10000000-0000-4000-8000-000000000006",
};

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

function controlledSleeper(): Sleeper & { advance(milliseconds: number): void } {
  let elapsed = 0;
  const waits: Array<{
    dueAt: number;
    signal: AbortSignal;
    resolve: () => void;
  }> = [];
  function settle(): void {
    for (const wait of waits) {
      if (!wait.signal.aborted && wait.dueAt <= elapsed) wait.resolve();
    }
  }
  return {
    wait: async (milliseconds, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const wait = { dueAt: elapsed + milliseconds, signal, resolve };
        waits.push(wait);
        signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    advance(milliseconds) {
      elapsed += milliseconds;
      settle();
    },
  };
}

function repositoryFixture(attemptNumber = 1) {
  let started: Date | null = null;
  let finalized:
    | Parameters<NotificationWorkerRepository["finalizeAttempt"]>[0]
    | null = null;
  const repository: NotificationWorkerRepository = {
    expirePending: async () => 0,
    recoverExpiredLeases: async () => 0,
    claimDue: async () => [],
    startAttempt: async (input) => {
      started = input.now;
      return {
        notification: { ...input.notification, attemptCount: attemptNumber },
        attemptNumber,
        attemptCorrelationId: input.attemptCorrelationId,
        providerKind: "SIMULATED_WHATSAPP",
      };
    },
    confirmProviderCall: async () => true,
    finalizeAttempt: async (input) => {
      finalized = input;
      return input.terminalFailureCode ? "DEAD" : "PENDING";
    },
  };
  return {
    repository,
    started: () => started,
    finalized: () => finalized,
  };
}

function processorInput(input: {
  repository: NotificationWorkerRepository;
  provider: NotificationProvider;
  clock: { now(): Date };
  sleeper?: Sleeper;
  currentNotification?: ClaimedNotification;
}) {
  return {
    dependencies: {
      repository: input.repository,
      whatsappProvider: input.provider,
      emailProvider: input.provider,
      clock: input.clock,
      sleeper: input.sleeper ?? passiveSleeper(),
    },
    notification: input.currentNotification ?? notification,
    attemptCorrelationId: "20000000-0000-4000-8000-000000000001",
    signal: new AbortController().signal,
  };
}

describe("notification processor boundary", () => {
  it("sanitizes unexpected provider exceptions and schedules from completion", async () => {
    const fixture = repositoryFixture();
    const provider: NotificationProvider = {
      send: async () => {
        throw new Error("raw-sensitive-provider-message");
      },
    };
    await processClaimedNotification(
      processorInput({
        repository: fixture.repository,
        provider,
        clock: { now: () => startedAt },
      }),
    );
    expect(fixture.finalized()).toMatchObject({
      result: {
        type: "TRANSIENT_FAILURE",
        failureCode: "PROVIDER_UNAVAILABLE",
      },
      now: startedAt,
      terminalFailureCode: null,
      nextAvailableAt: new Date(startedAt.getTime() + 60_000),
    });
    expect(JSON.stringify(fixture.finalized())).not.toContain(
      "raw-sensitive-provider-message",
    );
  });

  it("aborts the provider at exactly 30 seconds, not at 29.999", async () => {
    const fixture = repositoryFixture();
    const sleeper = controlledSleeper();
    let current = startedAt.getTime();
    let providerSignal: AbortSignal | null = null;
    const providerStarted = deferred<void>();
    const provider: NotificationProvider = {
      send: async (_request, options) => {
        providerSignal = options.signal;
        providerStarted.resolve();
        return new Promise<NotificationProviderResult>(() => undefined);
      },
    };
    const processing = processClaimedNotification(
      processorInput({
        repository: fixture.repository,
        provider,
        clock: { now: () => new Date(current) },
        sleeper,
      }),
    );
    await providerStarted.promise;

    current += NOTIFICATION_PROVIDER_DEADLINE_MS - 1;
    sleeper.advance(NOTIFICATION_PROVIDER_DEADLINE_MS - 1);
    await Promise.resolve();
    expect((providerSignal as AbortSignal | null)?.aborted).toBe(false);
    expect(fixture.finalized()).toBeNull();

    current += 1;
    sleeper.advance(1);
    await processing;
    expect((providerSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(fixture.finalized()).toMatchObject({
      result: { type: "TRANSIENT_FAILURE", failureCode: "PROVIDER_TIMEOUT" },
      now: new Date(current),
      nextAvailableAt: new Date(current + 60_000),
      terminalFailureCode: null,
    });
  });

  it.each([
    [1, 60_000, null],
    [2, 5 * 60_000, null],
    [3, 15 * 60_000, null],
    [4, null, "RETRY_EXHAUSTED"],
  ] as const)(
    "records completion time and schedules attempt %s from completion",
    async (attemptNumber, delay, terminalFailureCode) => {
      const fixture = repositoryFixture(attemptNumber);
      const result = deferred<NotificationProviderResult>();
      const providerStarted = deferred<void>();
      let current = startedAt.getTime();
      const provider: NotificationProvider = {
        send: async () => {
          providerStarted.resolve();
          return result.promise;
        },
      };
      const processing = processClaimedNotification(
        processorInput({
          repository: fixture.repository,
          provider,
          clock: { now: () => new Date(current) },
        }),
      );
      await providerStarted.promise;
      current += 2 * 60_000;
      result.resolve({
        type: "TRANSIENT_FAILURE",
        failureCode: "SIMULATED_TRANSIENT_FAILURE",
      });
      await processing;

      expect(fixture.started()).toEqual(startedAt);
      expect(fixture.finalized()).toMatchObject({
        now: new Date(current),
        terminalFailureCode,
        nextAvailableAt: delay === null ? null : new Date(current + delay),
      });
    },
  );

  it.each([
    ["completion exactly at expiry", 120_000, 120_000],
    ["completion after expiry", 60_000, 120_000],
    ["next retry exactly at expiry", 180_000, 120_000],
  ] as const)("terminalizes expiry when %s", async (_case, expiryMs, completionMs) => {
    const fixture = repositoryFixture();
    const result = deferred<NotificationProviderResult>();
    const providerStarted = deferred<void>();
    let current = startedAt.getTime();
    const processing = processClaimedNotification(
      processorInput({
        repository: fixture.repository,
        provider: {
          send: async () => {
            providerStarted.resolve();
            return result.promise;
          },
        },
        clock: { now: () => new Date(current) },
        currentNotification: {
          ...notification,
          expiresAt: new Date(startedAt.getTime() + expiryMs),
        },
      }),
    );
    await providerStarted.promise;
    current += completionMs;
    result.resolve({
      type: "TRANSIENT_FAILURE",
      failureCode: "SIMULATED_TRANSIENT_FAILURE",
    });
    await processing;
    expect(fixture.finalized()).toMatchObject({
      now: new Date(current),
      terminalFailureCode: "EXPIRED",
      nextAvailableAt: null,
    });
  });

  it("terminalizes a provider timeout that crosses expiry", async () => {
    const fixture = repositoryFixture();
    const sleeper = controlledSleeper();
    let current = startedAt.getTime();
    const providerStarted = deferred<void>();
    const processing = processClaimedNotification(
      processorInput({
        repository: fixture.repository,
        provider: {
          send: async () => {
            providerStarted.resolve();
            return new Promise<NotificationProviderResult>(() => undefined);
          },
        },
        clock: { now: () => new Date(current) },
        sleeper,
        currentNotification: {
          ...notification,
          expiresAt: new Date(startedAt.getTime() + 20_000),
        },
      }),
    );
    await providerStarted.promise;
    current += NOTIFICATION_PROVIDER_DEADLINE_MS;
    sleeper.advance(NOTIFICATION_PROVIDER_DEADLINE_MS);
    await processing;
    expect(fixture.finalized()).toMatchObject({
      result: { type: "TRANSIENT_FAILURE", failureCode: "PROVIDER_TIMEOUT" },
      now: new Date(current),
      terminalFailureCode: "EXPIRED",
      nextAvailableAt: null,
    });
  });
});
