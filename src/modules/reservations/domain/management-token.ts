import { createHash, createHmac } from "node:crypto";

const MANAGEMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function deriveManagementToken(
  reservationId: string,
  secret: string,
): string {
  if (!reservationId || secret.length < 32) {
    throw new Error("Invalid management-token derivation input.");
  }

  return createHmac("sha256", secret)
    .update(`reservation-management-v1\u0000${reservationId}`, "utf8")
    .digest("base64url");
}

export function isManagementToken(value: string): boolean {
  return MANAGEMENT_TOKEN_PATTERN.test(value);
}

export function hashManagementToken(rawToken: string): string {
  if (!isManagementToken(rawToken)) {
    throw new Error("Invalid management token.");
  }

  return createHash("sha256")
    .update(`reservation-management-token-v1\u0000${rawToken}`, "utf8")
    .digest("hex");
}

export function managementPath(rawToken: string): string {
  if (!isManagementToken(rawToken)) {
    throw new Error("Invalid management token.");
  }

  return `/p/${rawToken}`;
}
