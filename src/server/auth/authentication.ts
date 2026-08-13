import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import {
  credentialsSchema,
  DUMMY_PASSWORD_HASH,
  verifyPassword,
} from "@/server/auth/password";
import type { AuthenticatedUser } from "@/server/auth/session";

type AuthenticationClient = Pick<PrismaClient, "user">;

export interface LoginCredentials {
  username: unknown;
  password: unknown;
}

export async function authenticateCredentials(
  restaurantId: string,
  credentials: LoginCredentials,
  client: AuthenticationClient = prisma,
): Promise<AuthenticatedUser | null> {
  const parsed = credentialsSchema.safeParse(credentials);

  if (!parsed.success) {
    const timingPassword =
      typeof credentials.password === "string"
        ? credentials.password.slice(0, 128)
        : "invalid-credentials";
    await verifyPassword(DUMMY_PASSWORD_HASH, timingPassword);
    return null;
  }

  const user = await client.user.findUnique({
    where: {
      restaurantId_username: {
        restaurantId,
        username: parsed.data.username,
      },
    },
  });
  const passwordMatches = await verifyPassword(
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    parsed.data.password,
  );

  if (
    !user ||
    !passwordMatches ||
    !user.isActive ||
    user.disabledAt !== null
  ) {
    return null;
  }

  return {
    id: user.id,
    restaurantId: user.restaurantId,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}
