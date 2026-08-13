import "server-only";

import { Prisma } from "@/generated/prisma/client";

interface DriverConflictLike {
  name?: unknown;
  code?: unknown;
  cause?: unknown;
  meta?: unknown;
}

function hasDriverWriteConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as DriverConflictLike;
  if (candidate.code === "P2034") return true;

  if (
    candidate.name === "DriverAdapterError" &&
    typeof candidate.cause === "object" &&
    candidate.cause !== null &&
    "kind" in candidate.cause &&
    candidate.cause.kind === "TransactionWriteConflict"
  ) {
    return true;
  }

  if (
    typeof candidate.meta === "object" &&
    candidate.meta !== null &&
    "driverAdapterError" in candidate.meta
  ) {
    return hasDriverWriteConflict(candidate.meta.driverAdapterError);
  }

  return false;
}

export function isRetryableTransactionConflict(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034") ||
    hasDriverWriteConflict(error)
  );
}

export async function waitForTransactionRetry(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, attempt * 10);
  });
}
