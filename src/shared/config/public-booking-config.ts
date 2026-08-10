import "server-only";

import { z } from "zod";

import { resolveAppEnvironment } from "@/shared/config/app-environment";

export const LOCAL_PUBLIC_MANAGEMENT_SECRET =
  "local-only-public-management-secret-change-outside-development";
export const LOCAL_PUBLIC_RATE_LIMIT_SECRET =
  "local-only-public-rate-limit-secret-change-outside-development";

const positiveIntegerFromEnvironment = z.coerce.number().int().positive();

const publicBookingEnvironmentSchema = z.object({
  AUTH_RESTAURANT_ID: z.uuid(),
  AUTH_TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  PUBLIC_BOOKING_MANAGEMENT_SECRET: z.string().min(32),
  PUBLIC_BOOKING_RATE_LIMIT_SECRET: z.string().min(32),
  PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS:
    positiveIntegerFromEnvironment.max(86_400).default(900),
  PUBLIC_BOOKING_READ_LIMIT:
    positiveIntegerFromEnvironment.max(10_000).default(60),
  PUBLIC_BOOKING_MUTATION_LIMIT:
    positiveIntegerFromEnvironment.max(10_000).default(10),
});

export interface PublicBookingConfig {
  restaurantId: string;
  trustProxy: boolean;
  managementSecret: string;
  rateLimitSecret: string;
  rateLimitWindowMs: number;
  readLimit: number;
  mutationLimit: number;
}

export function resolvePublicBookingConfig(
  environment: Record<string, string | undefined> = process.env,
): PublicBookingConfig {
  const parsed = publicBookingEnvironmentSchema.parse(environment);
  const appEnvironment = resolveAppEnvironment(environment.APP_ENV);

  if (
    appEnvironment !== "development" &&
    (parsed.PUBLIC_BOOKING_MANAGEMENT_SECRET ===
      LOCAL_PUBLIC_MANAGEMENT_SECRET ||
      parsed.PUBLIC_BOOKING_RATE_LIMIT_SECRET ===
        LOCAL_PUBLIC_RATE_LIMIT_SECRET)
  ) {
    throw new Error("Local public-booking secrets cannot be used in production.");
  }

  return {
    restaurantId: parsed.AUTH_RESTAURANT_ID,
    trustProxy: parsed.AUTH_TRUST_PROXY === "true",
    managementSecret: parsed.PUBLIC_BOOKING_MANAGEMENT_SECRET,
    rateLimitSecret: parsed.PUBLIC_BOOKING_RATE_LIMIT_SECRET,
    rateLimitWindowMs:
      parsed.PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS * 1_000,
    readLimit: parsed.PUBLIC_BOOKING_READ_LIMIT,
    mutationLimit: parsed.PUBLIC_BOOKING_MUTATION_LIMIT,
  };
}
