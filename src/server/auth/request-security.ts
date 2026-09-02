import "server-only";

import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const ALLOWED_POST_LOGIN_PATHS = new Set([
  "/dashboard",
  "/dashboard/reservations/new",
  "/admin",
  "/admin/configuration",
  "/admin/rooms",
  "/admin/schedules",
  "/admin/special-dates",
  "/admin/users",
]);

function closestForwardedValue(value: string | null): string | null {
  const values = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return values?.at(-1) || null;
}

function normalizedHttpOrigin(protocol: string, host: string): string | null {
  const normalizedProtocol = protocol.trim().toLowerCase();
  const normalizedHost = host.trim();

  if (
    (normalizedProtocol !== "http" && normalizedProtocol !== "https") ||
    !normalizedHost
  ) {
    return null;
  }

  try {
    const url = new URL(`${normalizedProtocol}://${normalizedHost}`);

    if (
      url.protocol !== `${normalizedProtocol}:` ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function normalizedOriginHeader(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);

    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function unbracketedHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();

  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function isWildcardBindHostname(hostname: string): boolean {
  const normalized = unbracketedHostname(hostname);
  return normalized === "0.0.0.0" || normalized === "::";
}

function isAllowedLocalFallbackHostname(hostname: string): boolean {
  const normalized = unbracketedHostname(hostname);

  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  if (isIP(normalized) !== 4) {
    return false;
  }

  const [firstOctet = -1, secondOctet = -1] = normalized
    .split(".")
    .map(Number);

  return (
    firstOctet === 10 ||
    firstOctet === 127 ||
    (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) ||
    (firstOctet === 192 && secondOctet === 168)
  );
}

function resolveDirectRequestOrigin(
  request: Request,
  requestUrl: URL,
): string | null {
  const protocol = requestUrl.protocol.replace(":", "");
  const requestOrigin = normalizedHttpOrigin(protocol, requestUrl.host);

  if (!requestOrigin) {
    return null;
  }

  if (!isWildcardBindHostname(requestUrl.hostname)) {
    const hostHeader = request.headers.get("host");
    const hostOrigin = hostHeader
      ? normalizedHttpOrigin(protocol, hostHeader)
      : requestOrigin;

    return hostOrigin === requestOrigin ? requestOrigin : null;
  }

  const hostHeader = request.headers.get("host");
  const fallbackOrigin = hostHeader
    ? normalizedHttpOrigin(protocol, hostHeader)
    : null;

  if (!fallbackOrigin) {
    return null;
  }

  return isAllowedLocalFallbackHostname(new URL(fallbackOrigin).hostname)
    ? fallbackOrigin
    : null;
}

export function resolveSafePostLoginPath(value: unknown): string {
  if (typeof value !== "string" || !ALLOWED_POST_LOGIN_PATHS.has(value)) {
    return "/dashboard";
  }

  return value;
}

export function resolveTrustedRequestOrigin(
  request: Request,
  trustProxy: boolean,
): string | null {
  try {
    const requestUrl = new URL(request.url);
    const expectedOrigin = trustProxy
      ? normalizedHttpOrigin(
          closestForwardedValue(request.headers.get("x-forwarded-proto")) ||
            requestUrl.protocol.replace(":", ""),
          closestForwardedValue(request.headers.get("x-forwarded-host")) ||
            request.headers.get("host") ||
            requestUrl.host,
        )
      : resolveDirectRequestOrigin(request, requestUrl);
    const submittedOrigin = normalizedOriginHeader(request.headers.get("origin"));

    return expectedOrigin && submittedOrigin === expectedOrigin
      ? expectedOrigin
      : null;
  } catch {
    return null;
  }
}

export function isSameOriginRequest(
  request: Request,
  trustProxy: boolean,
): boolean {
  return resolveTrustedRequestOrigin(request, trustProxy) !== null;
}

export function resolveClientAddress(
  headers: Headers,
  trustProxy: boolean,
): string {
  if (!trustProxy) {
    return "direct-client";
  }

  const forwardedAddress = closestForwardedValue(headers.get("x-forwarded-for"));
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
