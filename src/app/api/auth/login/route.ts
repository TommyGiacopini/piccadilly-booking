import { NextResponse } from "next/server";

import { authenticateCredentials } from "@/server/auth/authentication";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { normalizeUsername } from "@/server/auth/password";
import {
  cleanupExpiredLoginRateLimits,
  clearLoginRateLimit,
  getLoginRateLimitStatus,
  recordFailedLoginAttempt,
} from "@/server/auth/rate-limit";
import {
  createRateLimitKeyHash,
  isSameOriginRequest,
  resolveClientAddress,
  resolveSafePostLoginPath,
} from "@/server/auth/request-security";
import { createSessionForUser } from "@/server/auth/session";
import {
  getSessionCookieName,
  getSessionCookieOptions,
} from "@/server/auth/session-token";
import { getAppEnvironment } from "@/shared/config/app-environment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function loginErrorResponse(
  request: Request,
  returnTo: string,
  error: "invalid" | "rate-limited",
): NextResponse {
  const location = new URL("/login", request.url);
  location.searchParams.set("error", error);
  location.searchParams.set("returnTo", returnTo);

  return NextResponse.redirect(location, { status: 303 });
}

export async function POST(request: Request): Promise<Response> {
  const config = resolveAuthConfig();

  if (!isSameOriginRequest(request, config.trustProxy)) {
    return new Response("Forbidden", { status: 403 });
  }

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const usernameValue = formData.get("username");
  const passwordValue = formData.get("password");
  const returnTo = resolveSafePostLoginPath(formData.get("returnTo"));
  const username =
    typeof usernameValue === "string" ? usernameValue.slice(0, 256) : "";
  const normalizedUsername = normalizeUsername(username);
  const clientAddress = resolveClientAddress(request.headers, config.trustProxy);
  const rateLimitKey = createRateLimitKeyHash(
    normalizedUsername,
    clientAddress,
    config.rateLimitSecret,
  );

  await cleanupExpiredLoginRateLimits();

  const currentLimit = await getLoginRateLimitStatus(rateLimitKey);

  if (!currentLimit.allowed) {
    return loginErrorResponse(request, returnTo, "rate-limited");
  }

  const user = await authenticateCredentials(config.restaurantId, {
    username,
    password: passwordValue,
  });

  if (!user) {
    const updatedLimit = await recordFailedLoginAttempt(rateLimitKey, config);
    return loginErrorResponse(
      request,
      returnTo,
      updatedLimit.allowed ? "invalid" : "rate-limited",
    );
  }

  await clearLoginRateLimit(rateLimitKey);

  const session = await createSessionForUser(user.id, {
    ttlMs: config.sessionTtlMs,
  });
  const destination = new URL(returnTo, request.url);
  const response = NextResponse.redirect(destination, { status: 303 });
  const appEnvironment = getAppEnvironment();

  response.cookies.set(
    getSessionCookieName(appEnvironment),
    session.token,
    getSessionCookieOptions(appEnvironment, session.expiresAt),
  );
  response.headers.set("Cache-Control", "no-store");

  return response;
}
