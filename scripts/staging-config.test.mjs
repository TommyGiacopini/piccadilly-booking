import { describe, expect, it } from "vitest";

import {
  assertNoRealProviderConfiguration,
  resolveOnrenderExternalUrl,
  validateStagingWebEnvironment,
  validateStagingWorkerEnvironment,
} from "./staging-config.mjs";

function webEnvironment() {
  return {
    APP_ENV: "staging",
    NODE_ENV: "production",
    RENDER: "true",
    RENDER_SERVICE_TYPE: "web",
    RENDER_EXTERNAL_URL: "https://piccadilly-m13.onrender.com",
    DATABASE_URL: "postgresql://fake:fake@db.example.test:5432/staging",
    AUTH_RESTAURANT_ID: "00000000-0000-4000-8000-000000000001",
    AUTH_TRUST_PROXY: "true",
    AUTH_RATE_LIMIT_SECRET: "a".repeat(32),
    PUBLIC_BOOKING_MANAGEMENT_SECRET: "b".repeat(32),
    PUBLIC_BOOKING_RATE_LIMIT_SECRET: "c".repeat(32),
    PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS: "900",
    PUBLIC_BOOKING_READ_LIMIT: "60",
    PUBLIC_BOOKING_MUTATION_LIMIT: "10",
    RESERVATION_PRIVACY_POLICY_VERSION: "staging-demo-v1",
    RESERVATION_TERMS_VERSION: "staging-demo-terms-v1",
    RESERVATION_IDEMPOTENCY_TTL_HOURS: "24",
    STAGING_ACCESS_USERNAME: "piccadilly-staging",
    STAGING_ACCESS_PASSWORD: "staging-access-password",
    AUTH_DEMO_ADMIN_PASSWORD: "staging-admin-password",
    AUTH_DEMO_STAFF_PASSWORD: "staging-staff-password",
  };
}

describe("M13 staging configuration", () => {
  it("accepts Render NODE_ENV=production when APP_ENV remains staging", () => {
    expect(validateStagingWebEnvironment(webEnvironment())).toEqual({
      serviceType: "web",
      externalUrl: "https://piccadilly-m13.onrender.com/",
    });
  });

  it("fails fast on missing web values and wrong Render service types", () => {
    expect(() =>
      validateStagingWebEnvironment({ ...webEnvironment(), STAGING_ACCESS_PASSWORD: "" }),
    ).toThrow("Missing required staging configuration");
    expect(() =>
      validateStagingWebEnvironment({ ...webEnvironment(), RENDER_SERVICE_TYPE: "worker" }),
    ).toThrow("RENDER_SERVICE_TYPE");
  });

  it("validates the minimal worker boundary", () => {
    expect(
      validateStagingWorkerEnvironment({
        APP_ENV: "staging",
        RENDER: "true",
        RENDER_SERVICE_TYPE: "worker",
        DATABASE_URL: "postgres://fake:fake@db.example.test:5432/staging",
      }),
    ).toEqual({ serviceType: "worker" });
  });

  it.each([
    ["META_ACCESS_TOKEN", "secret"],
    ["SMTP_URL", "smtp://example.test"],
    ["EMAIL_PROVIDER_MODE", "REAL"],
    ["WHATSAPP_PROVIDER_API_KEY", "secret"],
  ])("rejects real provider configuration %s", (key, value) => {
    expect(() =>
      assertNoRealProviderConfiguration({ [key]: value }),
    ).toThrow("forbidden");
  });

  it("requires a credential-free HTTPS onrender.com root URL", () => {
    expect(resolveOnrenderExternalUrl("https://demo.onrender.com")).toBe(
      "https://demo.onrender.com/",
    );
    for (const value of [
      "http://demo.onrender.com",
      "https://user:pass@demo.onrender.com",
      "https://demo.onrender.com/path",
      "https://demo.onrender.com/?secret=value",
      "https://official.example.com/",
    ]) {
      expect(() => resolveOnrenderExternalUrl(value)).toThrow("HTTPS onrender.com");
    }
  });
});
