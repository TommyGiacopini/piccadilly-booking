import { describe, expect, it } from "vitest";

import {
  reservationArrivalAuditSnapshot,
  reservationArrivalInputSchema,
  reservationArrivalUiState,
} from "@/modules/reservations/domain/reservation-arrival";

describe("T03 reservation arrival domain", () => {
  it("accepts the strict desired-state command", () => {
    expect(
      reservationArrivalInputSchema.parse({ version: 3, arrived: true }),
    ).toEqual({ version: 3, arrived: true });
  });

  it.each([
    { version: 0, arrived: true },
    { version: -1, arrived: false },
    { version: 1.5, arrived: true },
    { version: 1, arrived: "true" },
    { version: 1 },
    { version: 1, arrived: true, extra: true },
  ])("rejects invalid commands %#", (command) => {
    expect(reservationArrivalInputSchema.safeParse(command).success).toBe(false);
  });

  it("builds minimized record and revert audit snapshots", () => {
    const arrivedAt = new Date("2026-09-30T19:42:15.123Z");
    expect(reservationArrivalAuditSnapshot(null)).toEqual({
      arrival: { recorded: false, arrivedAt: null },
    });
    expect(reservationArrivalAuditSnapshot(arrivedAt)).toEqual({
      arrival: { recorded: true, arrivedAt: "2026-09-30T19:42:15.123Z" },
    });
    expect(JSON.stringify(reservationArrivalAuditSnapshot(arrivedAt))).not.toMatch(
      /name|phone|email|notes|allerg/iu,
    );
  });

  it("derives current, historical and cancelled labels without inventing no-show state", () => {
    expect(
      reservationArrivalUiState({
        arrivedAt: null,
        status: "CONFIRMED",
        isHistorical: false,
      }),
    ).toBe("EXPECTED");
    expect(
      reservationArrivalUiState({
        arrivedAt: "2026-09-30T19:42:15.123Z",
        status: "CONFIRMED",
        isHistorical: false,
      }),
    ).toBe("ARRIVED");
    expect(
      reservationArrivalUiState({
        arrivedAt: null,
        status: "CONFIRMED",
        isHistorical: true,
      }),
    ).toBe("NOT_RECORDED");
    expect(
      reservationArrivalUiState({
        arrivedAt: null,
        status: "CANCELLED",
        isHistorical: false,
      }),
    ).toBe("NOT_RECORDED");
  });
});
