import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { UserRole } from "@/generated/prisma/client";
import { getSessionCookieName } from "@/server/auth/session-token";
import {
  type AuthenticatedUser,
  validateSessionToken,
} from "@/server/auth/session";
import { getAppEnvironment } from "@/shared/config/app-environment";

export function canAccessStaffArea(role: UserRole): boolean {
  return role === UserRole.ADMIN || role === UserRole.STAFF;
}

export function canAccessAdminArea(role: UserRole): boolean {
  return role === UserRole.ADMIN;
}

export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const cookieStore = await cookies();
  const cookieName = getSessionCookieName(getAppEnvironment());

  return validateSessionToken(cookieStore.get(cookieName)?.value);
}

export async function requireAuthenticatedUser(
  returnTo = "/dashboard",
): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();

  if (!user || !canAccessStaffArea(user.role)) {
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  return user;
}

export async function requireAdmin(
  returnTo = "/admin",
): Promise<AuthenticatedUser> {
  const user = await requireAuthenticatedUser(returnTo);

  if (!canAccessAdminArea(user.role)) {
    redirect("/dashboard?access=denied");
  }

  return user;
}

export async function getRequestUser(
  request: Request,
): Promise<AuthenticatedUser | null> {
  const cookieName = getSessionCookieName(getAppEnvironment());
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);

  return validateSessionToken(token);
}
