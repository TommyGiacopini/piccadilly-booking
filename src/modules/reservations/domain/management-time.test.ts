import { describe, expect, it } from "vitest";

import {
  managementViewExpiry,
  originalManagementLinkDurationHours,
} from "@/modules/reservations/domain/management-time";

describe("management link duration", () => {
  it.each([
    ["2026-03-27", "20:30", 1],
    ["2026-03-28", "20:30", 24],
    ["2026-03-29", "20:30", 7],
    ["2026-10-24", "20:30", 12],
    ["2026-10-25", "20:30", 24],
  ])(
    "recovers the exact original duration across Europe/Rome DST for %s",
    (localDate, arrivalTime, durationHours) => {
      const viewExpiresAt = managementViewExpiry({
        localDate,
        arrivalTime,
        timezone: "Europe/Rome",
        durationHours,
      });
      expect(
        originalManagementLinkDurationHours({
          localDate,
          arrivalTime,
          timezone: "Europe/Rome",
          viewExpiresAt,
        }),
      ).toBe(durationHours);
    },
  );

  it.each([0, 25, 3.5])("rejects incoherent legacy duration %s", (hours) => {
    const reservation = new Date("2026-08-14T18:30:00.000Z");
    expect(() =>
      originalManagementLinkDurationHours({
        localDate: "2026-08-14",
        arrivalTime: "20:30",
        timezone: "Europe/Rome",
        viewExpiresAt: new Date(
          reservation.getTime() + hours * 60 * 60 * 1_000,
        ),
      }),
    ).toThrow("Incoherent legacy management-link duration");
  });
});
