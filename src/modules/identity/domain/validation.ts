import { z } from "zod";

import { usernameSchema } from "@/server/auth/password-core";

export const createUserSchema = z
  .object({
    username: usernameSchema,
    role: z.enum(["ADMIN", "STAFF"]),
  })
  .strict();

export const userRoleChangeSchema = z
  .object({
    role: z.enum(["ADMIN", "STAFF"]),
  })
  .strict();

export const userStatusChangeSchema = z
  .object({
    isActive: z.boolean(),
  })
  .strict();

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string(),
    newPassword: z.string(),
    confirmPassword: z.string(),
  })
  .strict();
