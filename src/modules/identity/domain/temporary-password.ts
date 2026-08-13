import { randomBytes } from "node:crypto";

export const TEMPORARY_PASSWORD_LENGTH = 24;

export function generateTemporaryPassword(): string {
  return randomBytes(18).toString("base64url");
}
