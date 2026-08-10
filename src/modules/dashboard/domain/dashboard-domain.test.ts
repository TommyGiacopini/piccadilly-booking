import { describe, expect, it } from "vitest";

import {
  aggregateDashboard,
  filterDashboardReservations,
  parseDashboardFilters,
  restaurantToday,
  shiftLocalDate,
  toDashboardReservation,
} from "@/modules/dashboard/domain/dashboard-domain";
import type { StoredReservation } from "@/modules/reservations/domain/types";

function reservation(
  overrides: Partial<StoredReservation> = {},
): StoredReservation {
  return {
    id: crypto.randomUUID(),
    restaurantId: crypto.randomUUID(),
    localDate: "2026-08-10",
    serviceType: "DINNER",
    arrivalTime: "19:00",
    partySize: 2,
    status: "CONFIRMED",
    origin: "PUBLIC",
    customerFirstName: "Cliente",
    customerLastName: "Fittizio",
    customerPhone: "+39 000 000 0000",
    customerEmail: null,
    notes: null,
    preferences: JSON.stringify({
      roomCode: "sala-1",
      highChair: true,
      stroller: false,
      accessibility: false,
      children: true,
      celebration: null,
      animals: false,
    }),
    allergies: JSON.stringify({
      celiac: true,
      allergies: null,
      intolerances: null,
    }),
    privacyPolicyVersion: "test-v1",
    privacyConsentAt: new Date("2026-08-01T10:00:00.000Z"),
    privacyConsentMethod: "WEB_CHECKBOX",
    termsPolicyVersion: "terms-v1",
    termsConsentAt: new Date("2026-08-01T10:00:00.000Z"),
    termsConsentMethod: "WEB_CHECKBOX",
    consentLanguage: "it",
    createdByUserId: null,
    capacityOverride: false,
    capacityOverrideReason: null,
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    updatedAt: new Date("2026-08-01T10:00:00.000Z"),
    cancelledAt: null,
    version: 1,
    ...overrides,
  };
}

const rooms = [
  { code: "sala-1", name: "Sala 1", displayOrder: 1, isActive: true },
  { code: "sala-2", name: "Sala 2", displayOrder: 2, isActive: true },
];

describe("M8 dashboard domain", () => {
  it("uses the restaurant timezone for the current local day", () => {
    expect(
      restaurantToday(new Date("2026-08-10T22:30:00.000Z"), "Europe/Rome"),
    ).toBe("2026-08-11");
    expect(shiftLocalDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(
      restaurantToday(new Date("2026-03-29T01:30:00.000Z"), "Europe/Rome"),
    ).toBe("2026-03-29");
    expect(
      restaurantToday(new Date("2026-10-25T01:30:00.000Z"), "Europe/Rome"),
    ).toBe("2026-10-25");
  });

  it("validates and applies service, status and origin filters", () => {
    const filters = parseDashboardFilters({
      service: "DINNER",
      status: "CONFIRMED",
      origin: "PHONE",
    });
    const rows = [
      reservation({ origin: "PHONE" }),
      reservation({ origin: "PUBLIC" }),
      reservation({ origin: "PHONE", status: "CANCELLED" }),
    ];

    expect(filterDashboardReservations(rows, filters)).toHaveLength(1);
    expect(() =>
      parseDashboardFilters({ service: "INVALID", status: "ALL", origin: "ALL" }),
    ).toThrow();
  });

  it("aggregates confirmed covers, requests, cancellations and preferred rooms", () => {
    const rows = [
      reservation(),
      reservation({
        origin: "PHONE",
        partySize: 3,
        preferences: "Sala storica M6",
        allergies: "Dichiarazione storica M6",
      }),
      reservation({
        status: "CANCELLED",
        cancelledAt: new Date("2026-08-02T10:00:00.000Z"),
        partySize: 8,
      }),
    ];
    const summary = aggregateDashboard(rows, rooms);

    expect(summary.confirmedReservations).toBe(2);
    expect(summary.confirmedCovers).toBe(5);
    expect(summary.cancellations).toBe(1);
    expect(summary.origins).toEqual({ PUBLIC: 1, PHONE: 1, STAFF: 0 });
    expect(summary.foodRequests).toBe(2);
    expect(summary.highChairs).toBe(1);
    expect(summary.unassignedReservations).toBe(2);
    expect(summary.preferredRoomCovers).toContainEqual({
      label: "Sala storica M6",
      covers: 3,
    });
  });

  it("parses legacy M6 preference and allergy text without throwing", () => {
    const row = toDashboardReservation(
      reservation({
        preferences: "Sala libera M6",
        allergies: "Allergia testuale M6",
      }),
      new Map(rooms.map((room) => [room.code, room.name])),
    );

    expect(row.preferredRoom).toBe("Sala libera M6");
    expect(row.allergies).toBe("Allergia testuale M6");
    expect(row.updatedAt).toBe("2026-08-01T10:00:00.000Z");
  });
});
