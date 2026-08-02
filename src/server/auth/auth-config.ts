import "server-only";

import { z } from "zod";

import { resolveAppEnvironment } from "@/shared/config/app-environment";

export const AUTH_RESTAURANT_ID = "00000000-0000-4000-8000-000000000001";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1_000;
export const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;
export const LOGIN_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1_000;
export const LOCAL_RATE_LIMIT_SECRET =
  "local-only-rate-limit-secret-change-outside-development";

const authEnvironmentSchema = z.object({
  AUTH_RESTAURANT_ID: z.uuid().default(AUTH_RESTAURANT_ID),
  AUTH_RATE_LIMIT_SECRET: z.string().min(32),
  AUTH_TRUST_PROXY: z.enum(["true", "false"]).default("false"),
});

export interface AuthConfig {
  restaurantId: string;
  rateLimitSecret: string;
  trustProxy: boolean;
  sessionTtlMs: number;
  rateLimitMaxAttempts: number;
  rateLimitWindowMs: number;
  rateLimitBlockMs: number;
}

export function resolveAuthConfig(
  environment: Record<string, string | undefined> = process.env,
): AuthConfig {
  const parsed = authEnvironmentSchema.parse(environment);
  const appEnvironment = resolveAppEnvironment(environment.APP_ENV);

  if (
    appEnvironment === "production" &&
    parsed.AUTH_RATE_LIMIT_SECRET === LOCAL_RATE_LIMIT_SECRET
  ) {
    throw new Error(
      "The local authentication secret cannot be used in production.",
    );
  }

  return {
    restaurantId: parsed.AUTH_RESTAURANT_ID,
    rateLimitSecret: parsed.AUTH_RATE_LIMIT_SECRET,
    trustProxy: parsed.AUTH_TRUST_PROXY === "true",
    sessionTtlMs: SESSION_TTL_MS,
    rateLimitMaxAttempts: LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
    rateLimitWindowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
    rateLimitBlockMs: LOGIN_RATE_LIMIT_BLOCK_MS,
  };
}
