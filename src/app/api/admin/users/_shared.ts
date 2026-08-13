import { NextResponse } from "next/server";

import {
  getRequestUser,
  passwordChangeRequiredResponse,
} from "@/server/auth/authorization";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { isSameOriginRequest } from "@/server/auth/request-security";
import type { AuthenticatedUser } from "@/server/auth/session";

export function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function requireAdminMutationActor(
  request: Request,
): Promise<
  | { user: AuthenticatedUser; response: null }
  | { user: null; response: Response }
> {
  if (!isSameOriginRequest(request, resolveAuthConfig().trustProxy)) {
    return { user: null, response: noStoreJson({ error: "Forbidden" }, 403) };
  }

  const user = await getRequestUser(request);
  if (!user) {
    return {
      user: null,
      response: noStoreJson({ error: "Unauthorized" }, 401),
    };
  }

  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return { user: null, response: passwordGuard };

  if (user.role !== "ADMIN") {
    return { user: null, response: noStoreJson({ error: "Forbidden" }, 403) };
  }

  return { user, response: null };
}

export async function readJson(request: Request): Promise<unknown> {
  const contentType =
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";

  if (contentType !== "application/json") {
    throw new TypeError("JSON_REQUIRED");
  }

  return request.json();
}
