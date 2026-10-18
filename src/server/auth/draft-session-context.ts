import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { validateSessionToken, type AuthenticatedUser } from "@/server/auth/session";
import { getSessionCookieName, parseSessionToken } from "@/server/auth/session-token";
import { getAppEnvironment } from "@/shared/config/app-environment";

export interface DraftSessionContext {
  actorId: string;
  tenantId: string;
  sessionBinding: string;
  role: "STAFF" | "ADMIN";
}

export type DraftSessionResult =
  | { status: "OK"; context: DraftSessionContext }
  | { status: "UNAUTHENTICATED" | "FORBIDDEN" | "PASSWORD_CHANGE_REQUIRED" };

export const DRAFT_SESSION_BINDING_HEADER = "X-Piccadilly-Draft-Session-Binding";

// Never expose the raw token/secret. Both actor and binding come from this one
// canonical authentication of the cookie received by the mutation itself.
export async function readDraftRequestSession(request: Request): Promise<{
  user: AuthenticatedUser; sessionBinding: string;
} | null> {
  const cookieName = getSessionCookieName(getAppEnvironment());
  // Extract once: validation and derivation must use the identical cookie value.
  const rawToken = request.headers.get("cookie")?.split(";").map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  const user = await validateSessionToken(rawToken);
  if (!user) return null;
  const token = rawToken ? parseSessionToken(rawToken) : null;
  if (!token) return null;
  const message = JSON.stringify(["CB06/session/v1", token.id, user.id, user.restaurantId]);
  return { user, sessionBinding: createHmac("sha256", token.secret).update(message, "utf8").digest("base64url") };
}

export function draftSessionBindingError(request: Request, actualBinding: string): {
  status: 400 | 403; code: "DRAFT_SESSION_BINDING_INVALID" | "DRAFT_SESSION_MISMATCH";
} | null {
  const received = request.headers.get(DRAFT_SESSION_BINDING_HEADER);
  // D01: headerless legacy requests retain their existing authorization. Any
  // present value, including empty/combined duplicate headers, must be checked.
  if (received === null) return null;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(received)) return { status: 400, code: "DRAFT_SESSION_BINDING_INVALID" };
  const bytes = Buffer.from(received, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== received) return { status: 400, code: "DRAFT_SESSION_BINDING_INVALID" };
  if (!timingSafeEqual(bytes, Buffer.from(actualBinding, "base64url"))) return { status: 403, code: "DRAFT_SESSION_MISMATCH" };
  return null;
}

export async function readDraftSessionContext(request: Request): Promise<DraftSessionResult> {
  const session = await readDraftRequestSession(request);
  if (!session) return { status: "UNAUTHENTICATED" };
  const { user, sessionBinding } = session;
  if (user.mustChangePassword) return { status: "PASSWORD_CHANGE_REQUIRED" };
  if (user.role !== "STAFF" && user.role !== "ADMIN") return { status: "FORBIDDEN" };
  return {
    status: "OK",
    context: {
      actorId: user.id,
      tenantId: user.restaurantId,
      sessionBinding,
      role: user.role,
    },
  };
}
