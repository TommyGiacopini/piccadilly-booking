import { describe, expect, it } from "vitest";

import {
  classifyNotificationWorkerFailure,
  createNotificationWorkerRuntime,
  notificationWorkerBackoffMilliseconds,
} from "@/modules/notifications/infrastructure/notification-worker-runtime";

const fixedNow = new Date("2028-01-01T10:00:00.000Z");

describe("notification worker runtime policy", () => {
  it.each([
    ["P1001", "DB_CONNECTION_UNAVAILABLE"],
    ["P1002", "DB_OPERATION_TIMEOUT"],
    ["P1008", "DB_OPERATION_TIMEOUT"],
    ["P1017", "DB_CONNECTION_LOST"],
    ["P2024", "DB_POOL_EXHAUSTED"],
    ["P2034", "DB_TRANSACTION_CONFLICT"],
    ["08006", "DB_CONNECTION_LOST"],
    ["08001", "DB_CONNECTION_UNAVAILABLE"],
    ["40001", "DB_TRANSACTION_CONFLICT"],
    ["40P01", "DB_TRANSACTION_CONFLICT"],
    ["53300", "DB_POOL_EXHAUSTED"],
    ["57P01", "DB_CONNECTION_LOST"],
    ["57P02", "DB_CONNECTION_LOST"],
    ["57P03", "DB_CONNECTION_UNAVAILABLE"],
    ["ECONNRESET", "DB_CONNECTION_LOST"],
    ["ECONNREFUSED", "DB_CONNECTION_UNAVAILABLE"],
    ["ETIMEDOUT", "DB_OPERATION_TIMEOUT"],
    ["EPIPE", "DB_CONNECTION_LOST"],
    ["ENETDOWN", "DB_CONNECTION_UNAVAILABLE"],
    ["ENETUNREACH", "DB_CONNECTION_UNAVAILABLE"],
    ["EHOSTUNREACH", "DB_CONNECTION_UNAVAILABLE"],
  ] as const)("classifies allow-listed recoverable code %s", (code, safeCode) => {
    expect(classifyNotificationWorkerFailure({ code })).toEqual({
      classification: "RUNTIME_RECOVERABLE",
      code: safeCode,
    });
  });

  it.each([
    ["P1000", "DB_AUTHORIZATION_FAILED"],
    ["P1010", "DB_AUTHORIZATION_FAILED"],
    ["P1003", "DB_SCHEMA_INCOMPATIBLE"],
    ["P2021", "DB_SCHEMA_INCOMPATIBLE"],
    ["P2022", "DB_SCHEMA_INCOMPATIBLE"],
    ["WORKER_CONFIGURATION_INVALID", "WORKER_CONFIGURATION_INVALID"],
  ] as const)("classifies known fatal code %s", (code, safeCode) => {
    expect(classifyNotificationWorkerFailure({ code })).toEqual({
      classification: "RUNTIME_FATAL",
      code: safeCode,
    });
  });

  it("finds an allow-listed code through nested causes", () => {
    expect(
      classifyNotificationWorkerFailure({
        cause: { cause: { sqlState: "40p01" } },
      }),
    ).toEqual({
      classification: "RUNTIME_RECOVERABLE",
      code: "DB_TRANSACTION_CONFLICT",
    });
  });

  it("traverses causes with a fixed bound and rejects deeper codes", () => {
    let error: object = { code: "P1001" };
    for (let index = 0; index < 8; index += 1) error = { cause: error };
    expect(classifyNotificationWorkerFailure(error)).toEqual({
      classification: "RUNTIME_FATAL",
      code: "WORKER_RUNTIME_UNCLASSIFIED",
    });
  });

  it("terminates safely for cyclic and unknown causes", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(classifyNotificationWorkerFailure(cyclic)).toEqual({
      classification: "RUNTIME_FATAL",
      code: "WORKER_RUNTIME_UNCLASSIFIED",
    });
    expect(classifyNotificationWorkerFailure(new Error("unknown"))).toEqual({
      classification: "RUNTIME_FATAL",
      code: "WORKER_RUNTIME_UNCLASSIFIED",
    });
  });

  it("uses the exact deterministic backoff sequence and cap", () => {
    expect(
      [1, 2, 3, 4, 5, 6, 100].map(
        notificationWorkerBackoffMilliseconds,
      ),
    ).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000]);
  });

  it("writes one-line allow-listed JSON without hostile raw error fields", () => {
    const lines: string[] = [];
    const canaries = [
      "+39-000-SECRET",
      "person@example.test",
      "password-canary",
      "postgresql://user:secret@localhost:5433/db",
      "token-canary",
      "stack-canary",
      "meta-canary",
    ];
    const hostile = Object.assign(new Error(canaries.join(" ")), {
      code: "ECONNRESET",
      stack: canaries[5],
      meta: canaries[6],
      cause: { token: canaries[4] },
    });
    const runtime = createNotificationWorkerRuntime({
      now: () => fixedNow,
      write: (line) => lines.push(line),
    });
    const failure = runtime.classifyFailure(hostile);
    runtime.emit({
      event: "notification_worker_runtime_failure",
      phase: "CLAIM_DUE",
      ...failure,
      consecutiveFailures: 1,
      backoffMs: 1_000,
      timestamp: runtime.timestamp(),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(lines[0]?.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      event: "notification_worker_runtime_failure",
      phase: "CLAIM_DUE",
      classification: "RUNTIME_RECOVERABLE",
      code: "DB_CONNECTION_LOST",
      consecutiveFailures: 1,
      backoffMs: 1_000,
      timestamp: fixedNow.toISOString(),
    });
    for (const canary of canaries) expect(lines.join("")).not.toContain(canary);
  });

  it("swallows writer and serialization failures", () => {
    const runtime = createNotificationWorkerRuntime({
      now: () => fixedNow,
      write: () => {
        throw new Error("logger unavailable");
      },
    });
    expect(() =>
      runtime.emit({
        event: "notification_worker_recovered",
        previousFailures: 1,
        timestamp: fixedNow.toISOString(),
      }),
    ).not.toThrow();
  });
});
