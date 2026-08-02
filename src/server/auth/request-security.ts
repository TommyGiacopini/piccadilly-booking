import "server-only";

import { createHmac } from "node:crypto";

const ALLOWED_POST_LOGIN_PATHS = new Set(["/dashboard", "/admin"]);

function firstForwardedValue(value: string | null): string | null {
  return value?.split(",", 1)[0]?.trim() || null;
}

export function resolveSafePostLoginPath(value: unknown): string {
  if (typeof value !== "string" || !ALLOWED_POST_LOGIN_PATHS.has(value)) {
    return "/dashboard";
  }

  return value;
}

export function isSameOriginRequest(
  request: Request,
  trustProxy: boolean,
): boolean {
  const origin = request.headers.get("origin");

  if (!origin) {
    return false;
  }

  try {
    const requestUrl = new URL(request.url);
    const expectedHost = trustProxy
      ? firstForwardedValue(request.headers.get("x-forwarded-host")) ||
        request.headers.get("host") ||
        requestUrl.host
      : request.headers.get("host") || requestUrl.host;
    const expectedProtocol = trustProxy
      ? firstForwardedValue(request.headers.get("x-forwarded-proto")) ||
        requestUrl.protocol.replace(":", "")
      : requestUrl.protocol.replace(":", "");
    const originUrl = new URL(origin);

    return (
      originUrl.host.toLowerCase() === expectedHost.toLowerCase() &&
      originUrl.protocol === `${expectedProtocol.toLowerCase()}:`
    );
  } catch {
    return false;
  }
}

export function resolveClientAddress(
  headers: Headers,
  trustProxy: boolean,
): string {
  if (!trustProxy) {
    return "direct-client";
  }

  const forwardedAddress = firstForwardedValue(headers.get("x-forwarded-for"));
  return forwardedAddress?.slice(0, 128) || "unknown-proxy-client";
}

export function createRateLimitKeyHash(
  normalizedUsername: string,
  clientAddress: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${clientAddress}\u0000${normalizedUsername}`, "utf8")
    .digest("hex");
}
