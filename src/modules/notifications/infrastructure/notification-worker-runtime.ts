import "server-only";

import type {
  NotificationWorkerEvent,
  NotificationWorkerFailureClassification,
  NotificationWorkerFailureCode,
  NotificationWorkerRuntime,
} from "@/modules/notifications/application/ports";

const MAX_CAUSE_DEPTH = 8;

const RECOVERABLE_CODES: Readonly<
  Record<
    string,
    {
      classification: "RUNTIME_RECOVERABLE";
      code: NotificationWorkerFailureCode;
    }
  >
> = {
  P1001: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_UNAVAILABLE",
  },
  P1002: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_OPERATION_TIMEOUT",
  },
  P1008: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_OPERATION_TIMEOUT",
  },
  P1017: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_LOST",
  },
  P2024: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_POOL_EXHAUSTED",
  },
  P2034: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_TRANSACTION_CONFLICT",
  },
  "40001": {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_TRANSACTION_CONFLICT",
  },
  "40P01": {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_TRANSACTION_CONFLICT",
  },
  "53300": {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_POOL_EXHAUSTED",
  },
  "57P01": {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_LOST",
  },
  "57P02": {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_LOST",
  },
  "57P03": {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_UNAVAILABLE",
  },
  ECONNRESET: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_LOST",
  },
  ECONNREFUSED: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_UNAVAILABLE",
  },
  ETIMEDOUT: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_OPERATION_TIMEOUT",
  },
  EPIPE: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_LOST",
  },
  ENETDOWN: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_UNAVAILABLE",
  },
  ENETUNREACH: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_UNAVAILABLE",
  },
  EHOSTUNREACH: {
    classification: "RUNTIME_RECOVERABLE",
    code: "DB_CONNECTION_UNAVAILABLE",
  },
};

const FATAL_CODES: Readonly<Record<string, NotificationWorkerFailureCode>> = {
  P1000: "DB_AUTHORIZATION_FAILED",
  P1003: "DB_SCHEMA_INCOMPATIBLE",
  P1010: "DB_AUTHORIZATION_FAILED",
  P2021: "DB_SCHEMA_INCOMPATIBLE",
  P2022: "DB_SCHEMA_INCOMPATIBLE",
  WORKER_CONFIGURATION_INVALID: "WORKER_CONFIGURATION_INVALID",
};

function readStringProperty(value: object, property: string): string | null {
  try {
    const candidate = Reflect.get(value, property);
    return typeof candidate === "string" ? candidate.toUpperCase() : null;
  } catch {
    return null;
  }
}

function readCause(value: object): unknown {
  try {
    return Reflect.get(value, "cause");
  } catch {
    return undefined;
  }
}

function classifyStableCode(code: string): {
  classification: NotificationWorkerFailureClassification;
  code: NotificationWorkerFailureCode;
} | null {
  const recoverable = RECOVERABLE_CODES[code];
  if (recoverable) return recoverable;
  if (/^08[A-Z0-9]{3}$/u.test(code)) {
    return {
      classification: "RUNTIME_RECOVERABLE",
      code:
        code === "08003" || code === "08006"
          ? "DB_CONNECTION_LOST"
          : "DB_CONNECTION_UNAVAILABLE",
    };
  }
  const fatalCode = FATAL_CODES[code];
  return fatalCode
    ? { classification: "RUNTIME_FATAL", code: fatalCode }
    : null;
}

export function classifyNotificationWorkerFailure(error: unknown): {
  classification: NotificationWorkerFailureClassification;
  code: NotificationWorkerFailureCode;
} {
  const visited = new Set<object>();
  let current = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") {
      break;
    }
    if (visited.has(current)) break;
    visited.add(current);

    for (const property of ["code", "sqlState", "sqlstate"]) {
      const stableCode = readStringProperty(current, property);
      if (!stableCode) continue;
      const classified = classifyStableCode(stableCode);
      if (classified) return classified;
    }
    current = readCause(current);
  }

  return {
    classification: "RUNTIME_FATAL",
    code: "WORKER_RUNTIME_UNCLASSIFIED",
  };
}

export function notificationWorkerBackoffMilliseconds(
  consecutiveFailures: number,
): number {
  if (consecutiveFailures <= 1) return 1_000;
  if (consecutiveFailures === 2) return 2_000;
  if (consecutiveFailures === 3) return 5_000;
  if (consecutiveFailures === 4) return 10_000;
  return 30_000;
}

export function createNotificationWorkerRuntime(input?: {
  now?: () => Date;
  write?: (line: string) => void;
}): NotificationWorkerRuntime {
  const now = input?.now ?? (() => new Date());
  const write = input?.write ?? ((line: string) => process.stdout.write(line));

  return {
    classifyFailure: classifyNotificationWorkerFailure,
    backoffMilliseconds: notificationWorkerBackoffMilliseconds,
    timestamp: () => now().toISOString(),
    emit(event: NotificationWorkerEvent): void {
      try {
        write(`${JSON.stringify(event)}\n`);
      } catch {
        // Logging is deliberately failure-safe.
      }
    },
  };
}
