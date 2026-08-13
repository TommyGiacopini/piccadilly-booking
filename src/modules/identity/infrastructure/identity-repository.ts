import "server-only";

import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

const IDENTITY_LIFECYCLE_LOCK_NAMESPACE = "identity-lifecycle-v1";

function deriveIdentityLockKey(restaurantId: string): readonly [number, number] {
  const digest = createHash("sha256")
    .update(
      `${IDENTITY_LIFECYCLE_LOCK_NAMESPACE}\u0000${restaurantId}`,
      "utf8",
    )
    .digest();

  return [digest.readInt32BE(0), digest.readInt32BE(4)] as const;
}

export async function acquireIdentityLifecycleLock(
  client: Prisma.TransactionClient,
  restaurantId: string,
): Promise<void> {
  const [firstKey, secondKey] = deriveIdentityLockKey(restaurantId);
  const rows = await client.$queryRaw<Array<{ locked: number }>>(
    Prisma.sql`
      WITH lock_acquired AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(${firstKey}, ${secondKey}) AS ignored
      )
      SELECT 1::integer AS locked
      FROM lock_acquired
    `,
  );

  if (rows[0]?.locked !== 1) {
    throw new Error("PostgreSQL identity lifecycle lock was not acquired.");
  }
}

export async function runIdentityTransaction<T>(
  callback: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const retry =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 3;

      if (!retry) throw error;
    }
  }

  throw new Error("Identity transaction retry exhausted.");
}
