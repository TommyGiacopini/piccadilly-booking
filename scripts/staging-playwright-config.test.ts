import { describe, expect, it } from "vitest";

import {
  futureRestaurantDate,
  resolveStagingPlaywrightEnvironment,
} from "../tests/staging/environment";

function environment() {
  return {
    STAGING_BASE_URL: "https://piccadilly-m13.onrender.com",
    STAGING_ACCESS_USERNAME: "basic-user",
    STAGING_ACCESS_PASSWORD: "basic-password",
    STAGING_ADMIN_USERNAME: "demo.admin",
    STAGING_ADMIN_PASSWORD: "admin-password",
    STAGING_STAFF_USERNAME: "demo.staff",
    STAGING_STAFF_PASSWORD: "staff-password",
    STAGING_RUN_ID: "RUN-20260830",
  };
}

describe("M13 staging Playwright configuration", () => {
  it("requires remote HTTPS, credentials, run ID and no database URL", () => {
    expect(resolveStagingPlaywrightEnvironment(environment())).toMatchObject({
      baseURL: "https://piccadilly-m13.onrender.com",
      runId: "RUN-20260830",
    });
    expect(() =>
      resolveStagingPlaywrightEnvironment({
        ...environment(),
        DATABASE_URL: "postgresql://must-not-be-present",
      }),
    ).toThrow("must not be present");
    expect(() =>
      resolveStagingPlaywrightEnvironment({
        ...environment(),
        STAGING_BASE_URL: "http://piccadilly-m13.onrender.com",
      }),
    ).toThrow("HTTPS onrender.com");
  });

  it("chooses the restaurant-local date seven or thirteen days ahead", () => {
    const now = new Date("2026-08-30T22:30:00.000Z");
    expect(futureRestaurantDate(now, 7)).toBe("2026-09-07");
    expect(futureRestaurantDate(now, 13)).toBe("2026-09-13");
  });
});
