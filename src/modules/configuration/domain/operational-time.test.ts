import { describe, expect, it } from "vitest";

import {
  localDateFromDatabase,
  localDateToDatabase,
  operationalTimeFromDatabase,
  operationalTimeToDatabase,
} from "@/modules/configuration/domain/operational-time";

describe("PostgreSQL operational time and local date mapping", () => {
  it("round-trips a TIME value without a business date", () => {
    expect(operationalTimeFromDatabase(operationalTimeToDatabase("22:15"))).toBe(
      "22:15",
    );
  });

  it("round-trips a DATE value without applying Europe/Rome or UTC shifts", () => {
    expect(localDateFromDatabase(localDateToDatabase("2026-03-29"))).toBe(
      "2026-03-29",
    );
    expect(localDateFromDatabase(localDateToDatabase("2026-10-25"))).toBe(
      "2026-10-25",
    );
  });
});
