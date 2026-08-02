import { NextResponse } from "next/server";

import { resolveAuthConfig } from "@/server/auth/auth-config";
import { isSameOriginRequest } from "@/server/auth/request-security";
import { revokeSessionToken } from "@/server/auth/session";
import {
  getSessionCookieName,
  getSessionCookieOptions,
} from "@/server/auth/session-token";
import { getAppEnvironment } from "@/shared/config/app-environment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const config = resolveAuthConfig();

  if (!isSameOriginRequest(request, config.trustProxy)) {
    return new Response("Forbidden", { status: 403 });
  }

  const appEnvironment = getAppEnvironment();
  const cookieName = getSessionCookieName(appEnvironment);
  const sessionToken = request.headers
    .get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);

  await revokeSessionToken(sessionToken);

  const response = NextResponse.redirect(new URL("/login", request.url), {
    status: 303,
  });
  response.cookies.set(
    cookieName,
    "",
    getSessionCookieOptions(appEnvironment, new Date(0)),
  );
  response.headers.set("Cache-Control", "no-store");

  return response;
}
