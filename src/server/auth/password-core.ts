import argon2 from "argon2";
import { z } from "zod";

export const MINIMUM_PASSWORD_LENGTH = 12;
export const MAXIMUM_PASSWORD_LENGTH = 128;

const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,p=1,t=2$t+vdXaRpuYE2/oAfhagiJg$IXDgo1C3ojm1bjE4rwtYrGHJXUZe096x3RsgBcTLSUY";

export function normalizeUsername(username: string): string {
  return username.normalize("NFKC").trim().toLowerCase();
}

export const usernameSchema = z
  .string()
  .transform(normalizeUsername)
  .pipe(
    z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/),
  );

export const passwordSchema = z
  .string()
  .min(MINIMUM_PASSWORD_LENGTH)
  .max(MAXIMUM_PASSWORD_LENGTH);

export const credentialsSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(passwordSchema.parse(password), ARGON2ID_OPTIONS);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}
