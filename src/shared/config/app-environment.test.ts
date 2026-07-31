import { describe, expect, it } from "vitest";

import { resolveAppEnvironment } from "@/shared/config/app-environment";

describe("resolveAppEnvironment", () => {
  it("uses development when APP_ENV is not configured", () => {
    expect(resolveAppEnvironment(undefined)).toBe("development");
  });

  it("normalizes a supported configured environment", () => {
    expect(resolveAppEnvironment("  STAGING ")).toBe("staging");
  });

  it("rejects unsupported environments", () => {
    expect(() => resolveAppEnvironment("personal-production")).toThrow(
      "Unsupported APP_ENV value",
    );
  });
});
