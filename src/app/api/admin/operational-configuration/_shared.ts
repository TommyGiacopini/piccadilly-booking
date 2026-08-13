import { NextResponse } from "next/server";

import {
  getRequestUser,
  passwordChangeRequiredResponse,
} from "@/server/auth/authorization";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { isSameOriginRequest } from "@/server/auth/request-security";
import type { AuthenticatedUser } from "@/server/auth/session";

export function configurationJson(
  body: unknown,
  status = 200,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function requireOperationalAdmin(
  request: Request,
  mutation: boolean,
): Promise<
  | { user: AuthenticatedUser; response: null }
  | { user: null; response: Response }
> {
  if (
    mutation &&
    !isSameOriginRequest(request, resolveAuthConfig().trustProxy)
  ) {
    return {
      user: null,
      response: configurationJson({ error: "Forbidden" }, 403),
    };
  }

  const user = await getRequestUser(request);
  if (!user) {
    return {
      user: null,
      response: configurationJson({ error: "Unauthorized" }, 401),
    };
  }

  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return { user: null, response: passwordGuard };

  if (user.role !== "ADMIN") {
    return {
      user: null,
      response: configurationJson({ error: "Forbidden" }, 403),
    };
  }

  return { user, response: null };
}

export async function readStrictJson(request: Request): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    throw new TypeError("JSON_REQUIRED");
  }
  return request.json();
}
