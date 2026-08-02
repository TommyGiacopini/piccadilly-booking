import "server-only";

import type { PrismaClient, UserRole } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import {
  createSessionToken,
  hashSessionSecret,
  parseSessionToken,
  sessionSecretMatches,
} from "@/server/auth/session-token";
import { SESSION_TTL_MS } from "@/server/auth/auth-config";

type SessionClient = Pick<PrismaClient, "session">;

export interface AuthenticatedUser {
  id: string;
  restaurantId: string;
  username: string;
  role: UserRole;
}

export interface CreatedSession {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function createSessionForUser(
  userId: string,
  options: {
    client?: SessionClient;
    now?: Date;
    ttlMs?: number;
  } = {},
): Promise<CreatedSession> {
  const client = options.client ?? prisma;
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.ttlMs ?? SESSION_TTL_MS));
  const token = createSessionToken();

  await client.session.create({
    data: {
      id: token.id,
      secretHash: hashSessionSecret(token.secret),
      userId,
      expiresAt,
      createdAt: now,
    },
  });

  return { id: token.id, token: token.token, expiresAt };
}

export async function validateSessionToken(
  rawToken: string | undefined,
  options: { client?: SessionClient; now?: Date } = {},
): Promise<AuthenticatedUser | null> {
  if (!rawToken) {
    return null;
  }

  const token = parseSessionToken(rawToken);

  if (!token) {
    return null;
  }

  const client = options.client ?? prisma;
  const now = options.now ?? new Date();
  const session = await client.session.findUnique({
    where: { id: token.id },
    include: {
      user: {
        select: {
          id: true,
          restaurantId: true,
          username: true,
          role: true,
          isActive: true,
          disabledAt: true,
        },
      },
    },
  });

  if (!session || !sessionSecretMatches(token.secret, session.secretHash)) {
    return null;
  }

  if (
    session.revokedAt ||
    session.expiresAt.getTime() <= now.getTime() ||
    !session.user.isActive ||
    session.user.disabledAt
  ) {
    if ((!session.user.isActive || session.user.disabledAt) && !session.revokedAt) {
      await client.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: now },
      });
    }

    return null;
  }

  return {
    id: session.user.id,
    restaurantId: session.user.restaurantId,
    username: session.user.username,
    role: session.user.role,
  };
}

export async function revokeSessionToken(
  rawToken: string | undefined,
  options: { client?: SessionClient; now?: Date } = {},
): Promise<boolean> {
  if (!rawToken) {
    return false;
  }

  const token = parseSessionToken(rawToken);

  if (!token) {
    return false;
  }

  const client = options.client ?? prisma;
  const now = options.now ?? new Date();
  const session = await client.session.findUnique({
    where: { id: token.id },
    select: { secretHash: true, revokedAt: true },
  });

  if (
    !session ||
    session.revokedAt ||
    !sessionSecretMatches(token.secret, session.secretHash)
  ) {
    return false;
  }

  await client.session.update({
    where: { id: token.id },
    data: { revokedAt: now },
  });

  return true;
}

export async function revokeAllSessionsForUser(
  userId: string,
  options: { client?: SessionClient; now?: Date } = {},
): Promise<number> {
  const client = options.client ?? prisma;
  const result = await client.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: options.now ?? new Date() },
  });

  return result.count;
}
