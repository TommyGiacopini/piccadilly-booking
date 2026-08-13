import "server-only";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { AuthConfig } from "@/server/auth/auth-config";
import { prisma } from "@/server/db/prisma";

type RateLimitClient = Pick<PrismaClient, "loginRateLimit">;
type TransactionalRateLimitClient = Pick<
  PrismaClient,
  "loginRateLimit" | "$transaction"
>;

export interface LoginRateLimitStatus {
  allowed: boolean;
  retryAt: Date | null;
}

export async function recordFailedLoginAttemptInTransaction(
  keyHash: string,
  config: AuthConfig,
  now: Date,
  client: RateLimitClient,
): Promise<LoginRateLimitStatus> {
  const entry = await client.loginRateLimit.findUnique({
    where: { keyHash },
  });
  const windowExpired =
    !entry ||
    entry.expiresAt.getTime() <= now.getTime() ||
    entry.windowStartedAt.getTime() + config.rateLimitWindowMs <= now.getTime();
  const windowStartedAt = windowExpired ? now : entry.windowStartedAt;
  const attempts = windowExpired ? 1 : entry.attempts + 1;
  const blockedUntil =
    attempts >= config.rateLimitMaxAttempts
      ? new Date(now.getTime() + config.rateLimitBlockMs)
      : null;
  const expiresAt =
    blockedUntil ??
    new Date(windowStartedAt.getTime() + config.rateLimitWindowMs);

  await client.loginRateLimit.upsert({
    where: { keyHash },
    update: { attempts, windowStartedAt, blockedUntil, expiresAt },
    create: {
      keyHash,
      attempts,
      windowStartedAt,
      blockedUntil,
      expiresAt,
    },
  });

  return {
    allowed: blockedUntil === null,
    retryAt: blockedUntil,
  };
}

export async function cleanupExpiredLoginRateLimits(
  now: Date = new Date(),
  client: RateLimitClient = prisma,
): Promise<number> {
  const result = await client.loginRateLimit.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  return result.count;
}

export async function getLoginRateLimitStatus(
  keyHash: string,
  now: Date = new Date(),
  client: RateLimitClient = prisma,
): Promise<LoginRateLimitStatus> {
  const entry = await client.loginRateLimit.findUnique({
    where: { keyHash },
  });

  if (!entry || entry.expiresAt.getTime() <= now.getTime()) {
    return { allowed: true, retryAt: null };
  }

  if (entry.blockedUntil && entry.blockedUntil.getTime() > now.getTime()) {
    return { allowed: false, retryAt: entry.blockedUntil };
  }

  return { allowed: true, retryAt: null };
}

export async function recordFailedLoginAttempt(
  keyHash: string,
  config: AuthConfig,
  now: Date = new Date(),
  client: TransactionalRateLimitClient = prisma,
): Promise<LoginRateLimitStatus> {
  for (let transactionAttempt = 1; transactionAttempt <= 3; transactionAttempt += 1) {
    try {
      return await client.$transaction(
        (transaction) =>
          recordFailedLoginAttemptInTransaction(
            keyHash,
            config,
            now,
            transaction,
          ),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      const shouldRetry =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        transactionAttempt < 3;

      if (!shouldRetry) {
        throw error;
      }
    }
  }

  throw new Error("Login rate-limit transaction retry exhausted.");
}

export async function clearLoginRateLimit(
  keyHash: string,
  client: RateLimitClient = prisma,
): Promise<void> {
  await client.loginRateLimit.deleteMany({ where: { keyHash } });
}
