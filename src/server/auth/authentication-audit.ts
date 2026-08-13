import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { insertAuditEvent } from "@/modules/audit/infrastructure/audit-repository";
import { authenticateCredentials } from "@/server/auth/authentication";
import type { AuthConfig } from "@/server/auth/auth-config";
import {
  getLoginRateLimitStatus,
  recordFailedLoginAttemptInTransaction,
} from "@/server/auth/rate-limit";
import {
  createSessionForUser,
  type AuthenticatedUser,
  type CreatedSession,
} from "@/server/auth/session";
import {
  parseSessionToken,
  sessionSecretMatches,
} from "@/server/auth/session-token";
import { prisma } from "@/server/db/prisma";

type LoginAttemptResult =
  | {
      status: "SUCCESS";
      user: AuthenticatedUser;
      session: CreatedSession;
    }
  | { status: "INVALID" | "RATE_LIMITED" };

function credentialAuditMetadata(credentialFingerprint: string) {
  return { credentialFingerprint };
}

async function runSerializable<T>(
  callback: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const shouldRetry =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 3;

      if (!shouldRetry) {
        throw error;
      }
    }
  }

  throw new Error("Authentication transaction retry exhausted.");
}

export async function processLoginWithAudit(input: {
  restaurantId: string;
  credentials: { username: unknown; password: unknown };
  credentialFingerprint: string;
  config: AuthConfig;
  now?: Date;
}): Promise<LoginAttemptResult> {
  const now = input.now ?? new Date();
  const correlationId = randomUUID();

  return runSerializable(async (client) => {
    const currentLimit = await getLoginRateLimitStatus(
      input.credentialFingerprint,
      now,
      client,
    );

    if (!currentLimit.allowed) {
      await insertAuditEvent(client, {
        restaurantId: input.restaurantId,
        category: "AUTHENTICATION",
        action: "LOGIN_RATE_LIMITED",
        outcome: "BLOCKED",
        actorUserId: null,
        actorRole: null,
        entityType: null,
        entityId: null,
        correlationId,
        previousState: null,
        newState: null,
        metadata: credentialAuditMetadata(input.credentialFingerprint),
        createdAt: now,
      });
      return { status: "RATE_LIMITED" };
    }

    const authenticated = await authenticateCredentials(
      input.restaurantId,
      input.credentials,
      client,
    );
    const confirmed = authenticated
      ? await client.user.findFirst({
          where: {
            id: authenticated.id,
            restaurantId: input.restaurantId,
            isActive: true,
            disabledAt: null,
          },
          select: {
            id: true,
            restaurantId: true,
            username: true,
            role: true,
            mustChangePassword: true,
          },
        })
      : null;

    if (!confirmed) {
      const updatedLimit = await recordFailedLoginAttemptInTransaction(
        input.credentialFingerprint,
        input.config,
        now,
        client,
      );
      await insertAuditEvent(client, {
        restaurantId: input.restaurantId,
        category: "AUTHENTICATION",
        action: "LOGIN_FAILED",
        outcome: "FAILURE",
        actorUserId: null,
        actorRole: null,
        entityType: null,
        entityId: null,
        correlationId,
        previousState: null,
        newState: null,
        metadata: credentialAuditMetadata(input.credentialFingerprint),
        createdAt: now,
      });
      return {
        status: updatedLimit.allowed ? "INVALID" : "RATE_LIMITED",
      };
    }

    await client.loginRateLimit.deleteMany({
      where: { keyHash: input.credentialFingerprint },
    });
    const session = await createSessionForUser(confirmed.id, {
      client,
      now,
      ttlMs: input.config.sessionTtlMs,
    });
    await insertAuditEvent(client, {
      restaurantId: input.restaurantId,
      category: "AUTHENTICATION",
      action: "LOGIN_SUCCEEDED",
      outcome: "SUCCESS",
      actorUserId: confirmed.id,
      actorRole: confirmed.role,
      entityType: null,
      entityId: null,
      correlationId,
      previousState: null,
      newState: null,
      metadata: null,
      createdAt: now,
    });

    return {
      status: "SUCCESS",
      user: confirmed,
      session,
    };
  });
}

export async function revokeSessionWithAudit(input: {
  restaurantId: string;
  rawToken: string | undefined;
  now?: Date;
}): Promise<boolean> {
  const token = parseSessionToken(input.rawToken ?? "");

  if (!token) {
    return false;
  }

  const now = input.now ?? new Date();
  const correlationId = randomUUID();

  return prisma.$transaction(async (client) => {
    const session = await client.session.findUnique({
      where: { id: token.id },
      include: {
        user: {
          select: {
            id: true,
            restaurantId: true,
            role: true,
          },
        },
      },
    });

    if (
      !session ||
      session.revokedAt ||
      session.user.restaurantId !== input.restaurantId ||
      !sessionSecretMatches(token.secret, session.secretHash)
    ) {
      return false;
    }

    const revoked = await client.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: now },
    });

    if (revoked.count !== 1) {
      return false;
    }

    await insertAuditEvent(client, {
      restaurantId: input.restaurantId,
      category: "AUTHENTICATION",
      action: "LOGOUT_SUCCEEDED",
      outcome: "SUCCESS",
      actorUserId: session.user.id,
      actorRole: session.user.role,
      entityType: null,
      entityId: null,
      correlationId,
      previousState: null,
      newState: null,
      metadata: null,
      createdAt: now,
    });

    return true;
  });
}
