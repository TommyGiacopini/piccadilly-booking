import { describe, expect, it } from "vitest";

import { resolveDatabaseUrl } from "@/server/db/database-config";

describe("resolveDatabaseUrl", () => {
  it("accepts PostgreSQL connection URLs", () => {
    expect(
      resolveDatabaseUrl(
        "postgresql://demo:demo-password@localhost:5433/demo?schema=public",
      ),
    ).toBe(
      "postgresql://demo:demo-password@localhost:5433/demo?schema=public",
    );
  });

  it.each([undefined, "", "mysql://localhost/demo", "not-a-url"])(
    "rejects an invalid database URL without exposing its value",
    (value) => {
      expect(() => resolveDatabaseUrl(value)).toThrow(
        "DATABASE_URL must be a valid PostgreSQL connection URL.",
      );
    },
  );
});
