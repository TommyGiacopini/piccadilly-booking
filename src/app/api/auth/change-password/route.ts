import { NextResponse } from "next/server";

import {
  IdentityError,
  identityErrorStatus,
} from "@/modules/identity/application/identity-errors";
import { changePersonalPassword } from "@/modules/identity/application/identity-service";
import { getRequestUser } from "@/server/auth/authorization";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { isSameOriginRequest } from "@/server/auth/request-security";
import {
  getSessionCookieName,
  getSessionCookieOptions,
} from "@/server/auth/session-token";
import { getAppEnvironment } from "@/shared/config/app-environment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request, resolveAuthConfig().trustProxy)) {
    return noStoreJson({ error: "Forbidden" }, 403);
  }

  const user = await getRequestUser(request);
  if (!user) return noStoreJson({ error: "Unauthorized" }, 401);

  const contentType =
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
  if (contentType !== "application/json") {
    return noStoreJson({ error: "Content-Type deve essere application/json." }, 400);
  }

  try {
    await changePersonalPassword(
      { id: user.id, restaurantId: user.restaurantId },
      await request.json(),
    );

    const appEnvironment = getAppEnvironment();
    const response = noStoreJson(
      { ok: true, reauthenticationRequired: true },
      200,
    );
    response.cookies.set(
      getSessionCookieName(appEnvironment),
      "",
      getSessionCookieOptions(appEnvironment, new Date(0)),
    );
    return response;
  } catch (error) {
    if (error instanceof IdentityError) {
      return noStoreJson(
        { error: error.publicMessage, code: error.code },
        identityErrorStatus(error.code),
      );
    }

    if (error instanceof SyntaxError) {
      return noStoreJson({ error: "Il corpo JSON non è valido." }, 400);
    }

    console.error("Personal password change failed.");
    return noStoreJson({ error: "Non è stato possibile cambiare la password." }, 500);
  }
}
