import "server-only";

import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";

const CAPACITY_LOCK_NAMESPACE = "reservation-capacity-v1";
const IDEMPOTENCY_LOCK_NAMESPACE = "reservation-idempotency-v1";

export function deriveAdvisoryLockKey(
  namespace: string,
  parts: readonly string[],
): readonly [number, number] {
  if (!namespace || parts.some((part) => !part)) {
    throw new Error("Invalid advisory lock identity.");
  }

  const digest = createHash("sha256")
    .update([namespace, ...parts].join("\u0000"), "utf8")
    .digest();

  return [digest.readInt32BE(0), digest.readInt32BE(4)] as const;
}

async function acquireTransactionLock(
  client: Prisma.TransactionClient,
  key: readonly [number, number],
): Promise<void> {
  const rows = await client.$queryRaw<Array<{ locked: number }>>(
    Prisma.sql`
      WITH lock_acquired AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(${key[0]}, ${key[1]}) AS ignored
      )
      SELECT 1::integer AS locked
      FROM lock_acquired
    `,
  );

  if (rows[0]?.locked !== 1) {
    throw new Error("PostgreSQL advisory transaction lock was not acquired.");
  }
}

export async function acquireIdempotencyLock(
  client: Prisma.TransactionClient,
  restaurantId: string,
  keyHash: string,
): Promise<void> {
  await acquireTransactionLock(
    client,
    deriveAdvisoryLockKey(IDEMPOTENCY_LOCK_NAMESPACE, [
      restaurantId,
      keyHash,
    ]),
  );
}

export async function acquireCapacityLock(
  client: Prisma.TransactionClient,
  input: {
    restaurantId: string;
    localDate: string;
    serviceType: string;
  },
): Promise<void> {
  await acquireTransactionLock(
    client,
    deriveAdvisoryLockKey(CAPACITY_LOCK_NAMESPACE, [
      input.restaurantId,
      input.localDate,
      input.serviceType,
    ]),
  );
}
