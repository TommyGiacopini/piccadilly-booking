import "server-only";

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { AppEnvironment } from "@/shared/config/app-environment";

const SESSION_SECRET_BYTES = 32;
const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SessionTokenParts {
  id: string;
  secret: string;
}

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  expires: Date;
  priority: "high";
}

export function createSessionToken(): SessionTokenParts & { token: string } {
  const id = randomUUID();
  const secret = randomBytes(SESSION_SECRET_BYTES).toString("base64url");

  return { id, secret, token: `${id}.${secret}` };
}

export function parseSessionToken(token: string): SessionTokenParts | null {
  const separator = token.indexOf(".");

  if (separator === -1 || separator !== token.lastIndexOf(".")) {
    return null;
  }

  const id = token.slice(0, separator);
  const secret = token.slice(separator + 1);

  if (!UUID_PATTERN.test(id) || !SESSION_SECRET_PATTERN.test(secret)) {
    return null;
  }

  return { id, secret };
}

export function hashSessionSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function sessionSecretMatches(
  secret: string,
  expectedHash: string,
): boolean {
  const actualHash = Buffer.from(hashSessionSecret(secret), "hex");
  const storedHash = Buffer.from(expectedHash, "hex");

  return (
    actualHash.length === storedHash.length &&
    timingSafeEqual(actualHash, storedHash)
  );
}

export function getSessionCookieName(appEnvironment: AppEnvironment): string {
  return appEnvironment === "production"
    ? "__Host-piccadilly_session"
    : "piccadilly_session";
}

export function getSessionCookieOptions(
  appEnvironment: AppEnvironment,
  expires: Date,
): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: appEnvironment === "production",
    sameSite: "lax",
    path: "/",
    expires,
    priority: "high",
  };
}
