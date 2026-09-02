import { NextResponse } from "next/server";

import { processLoginWithAudit } from "@/server/auth/authentication-audit";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { normalizeUsername } from "@/server/auth/password";
import { cleanupExpiredLoginRateLimits } from "@/server/auth/rate-limit";
import {
  createRateLimitKeyHash,
  resolveClientAddress,
  resolveSafePostLoginPath,
  resolveTrustedRequestOrigin,
} from "@/server/auth/request-security";
import {
  getSessionCookieName,
  getSessionCookieOptions,
} from "@/server/auth/session-token";
import { getAppEnvironment } from "@/shared/config/app-environment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function loginErrorResponse(
  requestOrigin: string,
  returnTo: string,
  error: "invalid" | "rate-limited",
): NextResponse {
  const location = new URL("/login", requestOrigin);
  location.searchParams.set("error", error);
  location.searchParams.set("returnTo", returnTo);

  return NextResponse.redirect(location, { status: 303 });
}

export async function POST(request: Request): Promise<Response> {
  const config = resolveAuthConfig();
  const requestOrigin = resolveTrustedRequestOrigin(request, config.trustProxy);

  if (!requestOrigin) {
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

  const result = await processLoginWithAudit({
    restaurantId: config.restaurantId,
    credentials: { username, password: passwordValue },
    credentialFingerprint: rateLimitKey,
    config,
  });

  if (result.status !== "SUCCESS") {
    return loginErrorResponse(
      requestOrigin,
      returnTo,
      result.status === "INVALID" ? "invalid" : "rate-limited",
    );
  }

  const destination = new URL(
    result.user.mustChangePassword ? "/cambia-password" : returnTo,
    requestOrigin,
  );
  const response = NextResponse.redirect(destination, { status: 303 });
  const appEnvironment = getAppEnvironment();

  response.cookies.set(
    getSessionCookieName(appEnvironment),
    result.session.token,
    getSessionCookieOptions(appEnvironment, result.session.expiresAt),
  );
  response.headers.set("Cache-Control", "no-store");

  return response;
}
