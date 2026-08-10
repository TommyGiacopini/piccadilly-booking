import "server-only";

import { createHmac, randomUUID } from "node:crypto";

import {
  Prisma,
  type PrismaClient,
  type PublicReservationRateLimitAction,
} from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";

type PublicRateLimitClient = Pick<
  PrismaClient,
  "$executeRaw" | "$queryRaw"
>;

export const PUBLIC_RATE_LIMIT_CLEANUP_BATCH_SIZE = 25;
const PUBLIC_RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;
let cleanupNotBeforeMs = 0;

export interface PublicRateLimitResult {
  allowed: boolean;
  retryAt: Date;
}

export function createPublicRateLimitKeyHash(input: {
  restaurantId: string;
  action: PublicReservationRateLimitAction;
  clientAddress: string;
  secret: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(
      `${input.restaurantId}\u0000${input.action}\u0000${input.clientAddress}`,
      "utf8",
    )
    .digest("hex");
}

export async function consumePublicRateLimit(input: {
  restaurantId: string;
  action: PublicReservationRateLimitAction;
  keyHash: string;
  limit: number;
  windowMs: number;
  now?: Date;
  client?: PublicRateLimitClient;
}): Promise<PublicRateLimitResult> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();
  const nextExpiry = new Date(now.getTime() + input.windowMs);

  if (now.getTime() >= cleanupNotBeforeMs) {
    cleanupNotBeforeMs = now.getTime() + PUBLIC_RATE_LIMIT_CLEANUP_INTERVAL_MS;
    try {
      await cleanupExpiredPublicRateLimits(now, client);
    } catch {
      cleanupNotBeforeMs = 0;
      throw new Error("Public rate-limit maintenance failed.");
    }
  }

  const rows = await client.$queryRaw<
    Array<{ attempts: number; expiresAt: Date }>
  >(Prisma.sql`
    INSERT INTO "public_reservation_rate_limits" (
      "id",
      "restaurant_id",
      "action",
      "key_hash",
      "attempts",
      "window_started_at",
      "expires_at",
      "created_at",
      "updated_at"
    )
    VALUES (
      ${randomUUID()}::uuid,
      ${input.restaurantId}::uuid,
      ${input.action}::"PublicReservationRateLimitAction",
      ${input.keyHash},
      1,
      ${now},
      ${nextExpiry},
      ${now},
      ${now}
    )
    ON CONFLICT ("restaurant_id", "action", "key_hash") DO UPDATE
    SET
      "attempts" = CASE
        WHEN "public_reservation_rate_limits"."expires_at" <= ${now}
          THEN 1
        ELSE "public_reservation_rate_limits"."attempts" + 1
      END,
      "window_started_at" = CASE
        WHEN "public_reservation_rate_limits"."expires_at" <= ${now}
          THEN ${now}
        ELSE "public_reservation_rate_limits"."window_started_at"
      END,
      "expires_at" = CASE
        WHEN "public_reservation_rate_limits"."expires_at" <= ${now}
          THEN ${nextExpiry}
        ELSE "public_reservation_rate_limits"."expires_at"
      END,
      "updated_at" = ${now}
    RETURNING
      "attempts",
      "expires_at" AS "expiresAt"
  `);
  const result = rows[0];

  if (!result) {
    throw new Error("Public rate-limit write returned no row.");
  }

  return {
    allowed: result.attempts <= input.limit,
    retryAt: result.expiresAt,
  };
}

export async function cleanupExpiredPublicRateLimits(
  now: Date = new Date(),
  client: Pick<PrismaClient, "$executeRaw"> = prisma,
): Promise<number> {
  return client.$executeRaw(Prisma.sql`
    WITH "expired_rate_limits" AS (
      SELECT "id"
      FROM "public_reservation_rate_limits"
      WHERE "expires_at" <= ${now}
      ORDER BY "expires_at", "id"
      LIMIT ${PUBLIC_RATE_LIMIT_CLEANUP_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM "public_reservation_rate_limits" AS "rate_limit"
    USING "expired_rate_limits"
    WHERE "rate_limit"."id" = "expired_rate_limits"."id"
  `);
}
