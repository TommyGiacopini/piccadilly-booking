import "server-only";

import { timingSafeEqual } from "node:crypto";

import { resolveAppEnvironment } from "@/shared/config/app-environment";

const STAGING_ACCESS_EXEMPT_PATHS = new Set(["/api/health", "/robots.txt"]);
const BASIC_SCHEME_PATTERN = /^Basic ([A-Za-z0-9+/]+={0,2})$/;

export const STAGING_BANNER_TEXT =
  "AMBIENTE DEMO/STAGING — DATI FITTIZI — NESSUN MESSAGGIO REALE";
export const STAGING_ROBOTS_HEADER = "noindex, nofollow, noarchive";

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function parseBasicCredentials(header: string | null) {
  const encoded = header?.match(BASIC_SCHEME_PATTERN)?.[1];
  if (!encoded) return null;

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function isStagingAccessExempt(pathname: string): boolean {
  return STAGING_ACCESS_EXEMPT_PATHS.has(pathname);
}

export function isAuthorizedForStaging(
  authorizationHeader: string | null,
  environment: Record<string, string | undefined> = process.env,
): boolean {
  if (resolveAppEnvironment(environment.APP_ENV) !== "staging") return true;

  const expectedUsername = environment.STAGING_ACCESS_USERNAME;
  const expectedPassword = environment.STAGING_ACCESS_PASSWORD;
  if (!expectedUsername || !expectedPassword) return false;

  const credentials = parseBasicCredentials(authorizationHeader);
  return Boolean(
    credentials &&
      safeEqual(credentials.username, expectedUsername) &&
      safeEqual(credentials.password, expectedPassword),
  );
}

export function createStagingUnauthorizedResponse(): Response {
  return new Response("Staging access requires authentication.", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Basic realm="Piccadilly Staging", charset="UTF-8"',
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": STAGING_ROBOTS_HEADER,
    },
  });
}
