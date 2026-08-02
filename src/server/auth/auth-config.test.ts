import { describe, expect, it } from "vitest";

import {
  AUTH_RESTAURANT_ID,
  LOCAL_RATE_LIMIT_SECRET,
  resolveAuthConfig,
} from "@/server/auth/auth-config";

describe("authentication environment", () => {
  it("validates local settings and keeps proxy trust explicit", () => {
    expect(
      resolveAuthConfig({
        APP_ENV: "development",
        AUTH_RESTAURANT_ID,
        AUTH_RATE_LIMIT_SECRET: LOCAL_RATE_LIMIT_SECRET,
        AUTH_TRUST_PROXY: "false",
      }),
    ).toMatchObject({
      restaurantId: AUTH_RESTAURANT_ID,
      trustProxy: false,
      sessionTtlMs: 8 * 60 * 60 * 1_000,
      rateLimitMaxAttempts: 5,
    });
  });

  it("rejects the local secret in production", () => {
    expect(() =>
      resolveAuthConfig({
        APP_ENV: "production",
        AUTH_RESTAURANT_ID,
        AUTH_RATE_LIMIT_SECRET: LOCAL_RATE_LIMIT_SECRET,
        AUTH_TRUST_PROXY: "true",
      }),
    ).toThrow("cannot be used in production");
  });
});
