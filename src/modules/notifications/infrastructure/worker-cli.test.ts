import { describe, expect, it, vi } from "vitest";

import type {
  NotificationProviderResult,
  NotificationWorkerRepository,
  NotificationWorkerRuntime,
} from "@/modules/notifications/application/ports";
import type { NotificationWorkerDependencies } from "@/modules/notifications/application/worker";
import { createNotificationWorkerRuntime } from "@/modules/notifications/infrastructure/notification-worker-runtime";
import { runNotificationWorkerCli } from "@/modules/notifications/infrastructure/worker-cli";

const now = new Date("2028-01-01T10:00:00.000Z");
const success: NotificationProviderResult = {
  type: "SUCCESS",
  providerReference: "simulated",
  deduplicated: false,
};

function runtimeRecorder() {
  const lines: string[] = [];
  return {
    lines,
    runtime: createNotificationWorkerRuntime({
      now: () => now,
      write: (line) => lines.push(line),
    }),
  };
}

function repository(
  overrides: Partial<NotificationWorkerRepository> = {},
): NotificationWorkerRepository {
  return {
    expirePending: async () => 0,
    recoverExpiredLeases: async () => 0,
    claimDue: async () => [],
    startAttempt: async () => null,
    confirmProviderCall: async () => false,
    finalizeAttempt: async () => "STALE",
    ...overrides,
  };
}

function dependencies(
  runtime: NotificationWorkerRuntime,
  repositoryOverride?: NotificationWorkerRepository,
): NotificationWorkerDependencies {
  return {
    repository: repositoryOverride ?? repository(),
    whatsappProvider: { send: async () => success },
    emailProvider: { send: async () => success },
    clock: { now: () => now },
    sleeper: { wait: async () => undefined },
    ids: { generate: () => "40000000-0000-4000-8000-000000000001" },
    runtime,
  };
}

describe("notification worker CLI", () => {
  it("keeps one-shot fail-fast and returns a sanitized failure", async () => {
    const recorded = runtimeRecorder();
    let sleeps = 0;
    const deps = dependencies(
      recorded.runtime,
      repository({
        expirePending: async () => {
          throw Object.assign(new Error("secret-message"), { code: "P1001" });
        },
      }),
    );
    deps.sleeper = {
      wait: async () => {
        sleeps += 1;
      },
    };

    const exitCode = await runNotificationWorkerCli({
      args: ["--once"],
      runtime: recorded.runtime,
      createDependencies: () => deps,
      disconnect: async () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(sleeps).toBe(0);
    expect(recorded.lines.join("")).not.toContain("secret-message");
    expect(recorded.lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "notification_worker_stopped",
        reason: "ONE_SHOT_FAILURE",
        phase: "EXPIRE_PENDING",
        code: "DB_CONNECTION_UNAVAILABLE",
        exitCode: 1,
      }),
    );
  });

  it("returns exit 1 for a fatal long-running failure", async () => {
    const recorded = runtimeRecorder();
    const deps = dependencies(
      recorded.runtime,
      repository({
        expirePending: async () => {
          throw new Error("programming-canary");
        },
      }),
    );

    const exitCode = await runNotificationWorkerCli({
      args: [],
      runtime: recorded.runtime,
      createDependencies: () => deps,
      disconnect: async () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(recorded.lines.join("")).not.toContain("programming-canary");
    expect(recorded.lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "notification_worker_stopped",
        reason: "RUNTIME_FATAL",
        phase: "EXPIRE_PENDING",
        code: "WORKER_RUNTIME_UNCLASSIFIED",
        exitCode: 1,
      }),
    );
  });

  it("reports a startup composition failure without raw details", async () => {
    const recorded = runtimeRecorder();
    const exitCode = await runNotificationWorkerCli({
      args: [],
      runtime: recorded.runtime,
      createDependencies: () => {
        throw Object.assign(new Error("credential-canary"), {
          code: "WORKER_CONFIGURATION_INVALID",
        });
      },
      disconnect: async () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(recorded.lines.join("")).not.toContain("credential-canary");
    expect(recorded.lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "notification_worker_stopped",
        phase: "STARTUP",
        code: "WORKER_CONFIGURATION_INVALID",
      }),
    );
  });

  it("aborts polling through SIGTERM and exits cleanly", async () => {
    const recorded = runtimeRecorder();
    const listeners = new Map<string, () => void>();
    let claimCalls = 0;
    const deps = dependencies(
      recorded.runtime,
      repository({
        claimDue: async () => {
          claimCalls += 1;
          return [];
        },
      }),
    );
    deps.sleeper = {
      wait: async (_milliseconds, signal) =>
        new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    };

    const running = runNotificationWorkerCli({
      args: [],
      runtime: recorded.runtime,
      createDependencies: () => deps,
      disconnect: async () => undefined,
      addSignalListener: (signal, listener) => listeners.set(signal, listener),
      removeSignalListener: (signal) => listeners.delete(signal),
    });
    await vi.waitFor(() => expect(claimCalls).toBe(1));
    listeners.get("SIGTERM")?.();

    await expect(running).resolves.toBe(0);
    expect(claimCalls).toBe(1);
    expect(recorded.lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "notification_worker_stopped",
        reason: "ABORTED",
        phase: "SHUTDOWN",
        exitCode: 0,
      }),
    );
  });

  it("sanitizes disconnect failure and preserves an earlier failure exit", async () => {
    const recorded = runtimeRecorder();
    const deps = dependencies(
      recorded.runtime,
      repository({
        expirePending: async () => {
          throw new Error("primary-canary");
        },
      }),
    );
    const exitCode = await runNotificationWorkerCli({
      args: [],
      runtime: recorded.runtime,
      createDependencies: () => deps,
      disconnect: async () => {
        throw Object.assign(new Error("disconnect-secret"), {
          code: "ECONNRESET",
        });
      },
    });

    expect(exitCode).toBe(1);
    expect(recorded.lines.join("")).not.toContain("primary-canary");
    expect(recorded.lines.join("")).not.toContain("disconnect-secret");
    expect(recorded.lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: "notification_worker_stopped",
        reason: "SHUTDOWN_FAILURE",
        phase: "SHUTDOWN",
        code: "DB_CONNECTION_LOST",
        exitCode: 1,
      }),
    );
  });
});
