import { describe, expect, it } from "vitest";

import {
  createStagingUnauthorizedResponse,
  isAuthorizedForStaging,
  isStagingAccessExempt,
} from "@/server/staging/access-gate";

const staging = {
  APP_ENV: "staging",
  STAGING_ACCESS_USERNAME: "demo-user",
  STAGING_ACCESS_PASSWORD: "demo-password",
};

describe("M13 staging Basic access gate", () => {
  it("allows exact credentials only in staging", () => {
    const valid = `Basic ${Buffer.from("demo-user:demo-password").toString("base64")}`;
    const invalid = `Basic ${Buffer.from("demo-user:wrong").toString("base64")}`;
    expect(isAuthorizedForStaging(valid, staging)).toBe(true);
    expect(isAuthorizedForStaging(invalid, staging)).toBe(false);
    expect(isAuthorizedForStaging(null, staging)).toBe(false);
    expect(isAuthorizedForStaging(null, { APP_ENV: "development" })).toBe(true);
    expect(isAuthorizedForStaging(null, { APP_ENV: "production" })).toBe(true);
  });

  it("exempts only health and robots and returns hardened 401 responses", () => {
    expect(isStagingAccessExempt("/api/health")).toBe(true);
    expect(isStagingAccessExempt("/robots.txt")).toBe(true);
    expect(isStagingAccessExempt("/api/health/details")).toBe(false);
    expect(isStagingAccessExempt("/")).toBe(false);
    const response = createStagingUnauthorizedResponse();
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
