import { describe, expect, it } from "vitest";

import {
  aggregateDashboard,
  deriveLatestNotificationHealth,
  filterDashboardReservations,
  parseDashboardFilters,
  restaurantToday,
  shiftLocalDate,
  toDashboardReservation,
  type DashboardAssignmentSource,
  type DashboardReservationSource,
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

function source(
  reservationOverrides: Partial<StoredReservation> = {},
  assignment: DashboardAssignmentSource | null = null,
): DashboardReservationSource {
  return { reservation: reservation(reservationOverrides), assignment };
}

function assignment(
  overrides: Partial<DashboardAssignmentSource> = {},
): DashboardAssignmentSource {
  return {
    room: {
      id: "00000000-0000-4000-8000-000000000101",
      code: "sala-2",
      name: "Sala 2",
      isActive: true,
    },
    tables: [
      {
        id: "00000000-0000-4000-8000-000000000201",
        name: "T2",
        displayOrder: 1,
        isActive: true,
      },
    ],
    internalNotesPresent: false,
    ...overrides,
  };
}

describe("M8 dashboard domain", () => {
  it("derives minimized notification warnings from only the latest non-superseded group", () => {
    const oldGroup = crypto.randomUUID();
    const latestGroup = crypto.randomUUID();
    expect(
      deriveLatestNotificationHealth([
        { eventGroupId: oldGroup, reservationVersion: 1, status: "DEAD", createdAt: new Date("2028-01-01T10:00:00.000Z") },
        { eventGroupId: latestGroup, reservationVersion: 2, status: "SUCCEEDED", createdAt: new Date("2028-01-01T11:00:00.000Z") },
      ]),
    ).toBeNull();
    expect(
      deriveLatestNotificationHealth([
        { eventGroupId: latestGroup, reservationVersion: 3, status: "DEAD", createdAt: new Date("2028-01-01T12:00:00.000Z") },
      ]),
    ).toBe("NOT_DELIVERED");
  });

  it("reports parallel partial delivery without exposing channel details", () => {
    const group = crypto.randomUUID();
    expect(
      deriveLatestNotificationHealth([
        { eventGroupId: group, reservationVersion: 4, status: "SUCCEEDED", createdAt: new Date("2028-01-01T12:00:00.000Z") },
        { eventGroupId: group, reservationVersion: 4, status: "DEAD", createdAt: new Date("2028-01-01T12:00:00.000Z") },
      ]),
    ).toBe("PARTIAL_SUCCESS");
  });

  it("suppresses pending and fully cancelled groups", () => {
    const group = crypto.randomUUID();
    expect(deriveLatestNotificationHealth([{ eventGroupId: group, reservationVersion: 1, status: "PENDING", createdAt: new Date("2028-01-01T10:00:00.000Z") }])).toBeNull();
    expect(deriveLatestNotificationHealth([{ eventGroupId: group, reservationVersion: 1, status: "CANCELLED", createdAt: new Date("2028-01-01T10:00:00.000Z") }])).toBeNull();
  });

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

  it("validates and applies service, status, origin and assignment filters", () => {
    const filters = parseDashboardFilters({
      service: "DINNER",
      status: "CONFIRMED",
      origin: "PHONE",
      assignment: "UNASSIGNED",
      finalRoom: "ALL",
    });
    const rows = [
      source({ origin: "PHONE" }),
      source({ origin: "PUBLIC" }),
      source({ origin: "PHONE" }, assignment()),
      source(
        {
          origin: "PHONE",
          status: "CANCELLED",
          cancelledAt: new Date("2026-08-02T10:00:00.000Z"),
        },
        null,
      ),
    ];

    expect(filterDashboardReservations(rows, filters)).toHaveLength(1);
    expect(() =>
      parseDashboardFilters({
        service: "INVALID",
        status: "ALL",
        origin: "ALL",
        assignment: "ALL",
        finalRoom: "ALL",
      }),
    ).toThrow();
  });

  it("filters by final room without using the customer preference", () => {
    const rows = [
      source({ preferences: JSON.stringify({ roomCode: "sala-1" }) }, assignment()),
      source({}, null),
    ];

    expect(
      filterDashboardReservations(rows, {
        service: "ALL",
        status: "ALL",
        origin: "ALL",
        assignment: "ASSIGNED",
        finalRoom: "sala-2",
      }),
    ).toHaveLength(1);
    expect(
      filterDashboardReservations(rows, {
        service: "ALL",
        status: "ALL",
        origin: "ALL",
        assignment: "ALL",
        finalRoom: "sala-1",
      }),
    ).toHaveLength(0);
  });

  it("aggregates assignment counts and covers by final room, excluding cancelled rows", () => {
    const rows = [
      source({}, assignment()),
      source({
          origin: "PHONE",
          partySize: 3,
          preferences: "Sala storica M6",
          allergies: "Dichiarazione storica M6",
        }),
      source(
        {
          status: "CANCELLED",
          cancelledAt: new Date("2026-08-02T10:00:00.000Z"),
          partySize: 8,
        },
        assignment(),
      ),
    ];
    const summary = aggregateDashboard(rows, rooms);

    expect(summary.confirmedReservations).toBe(2);
    expect(summary.confirmedCovers).toBe(5);
    expect(summary.cancellations).toBe(1);
    expect(summary.origins).toEqual({ PUBLIC: 1, PHONE: 1, STAFF: 0 });
    expect(summary.foodRequests).toBe(2);
    expect(summary.highChairs).toBe(1);
    expect(summary.assignedReservations).toBe(1);
    expect(summary.unassignedReservations).toBe(1);
    expect(summary.unassignedCovers).toBe(3);
    expect(summary.finalRoomCovers).toContainEqual({
      code: "sala-2",
      label: "Sala 2",
      covers: 2,
    });
  });

  it("keeps preference and final assignment distinct and projects grandfathering", () => {
    const row = toDashboardReservation(
      source(
        {
          preferences: "Sala libera M6",
          allergies: "Allergia testuale M6",
        },
        assignment({
          room: {
            id: "00000000-0000-4000-8000-000000000101",
            code: "sala-2",
            name: "Sala 2",
            isActive: false,
          },
          internalNotesPresent: true,
        }),
      ),
      new Map(rooms.map((room) => [room.code, room.name])),
      {
        LUNCH: new Map(),
        DINNER: new Map([
          ["00000000-0000-4000-8000-000000000101", false],
        ]),
      },
    );

    expect(row.preferredRoom).toBe("Sala libera M6");
    expect(row.allergies).toBe("Allergia testuale M6");
    expect(row.assignment).toMatchObject({
      roomName: "Sala 2",
      internalNotesPresent: true,
      hasInactiveReferences: true,
      hasUnavailableRoomReference: true,
    });
    expect(row.updatedAt).toBe("2026-08-01T10:00:00.000Z");
  });
});
