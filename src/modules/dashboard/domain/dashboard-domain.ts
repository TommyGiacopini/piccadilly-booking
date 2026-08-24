import { z } from "zod";

import { getZonedDateTimeParts } from "@/modules/availability/domain/local-calendar";
import {
  isLocalDate,
  localDateFromDatabase,
} from "@/modules/configuration/domain/operational-time";
import {
  parsePublicAllergies,
  parsePublicPreferences,
} from "@/modules/reservations/domain/public-validation";
import type { StoredReservation } from "@/modules/reservations/domain/types";

export const dashboardFiltersSchema = z
  .object({
    service: z.enum(["ALL", "LUNCH", "DINNER"]).default("ALL"),
    status: z.enum(["ALL", "CONFIRMED", "CANCELLED"]).default("ALL"),
    origin: z.enum(["ALL", "PUBLIC", "PHONE", "STAFF"]).default("ALL"),
    assignment: z.enum(["ALL", "UNASSIGNED", "ASSIGNED"]).default("ALL"),
    finalRoom: z
      .enum(["ALL", "sala-1", "sala-2", "sala-3", "galleria", "terrazzo"])
      .default("ALL"),
  })
  .strict();

export type DashboardFilters = z.infer<typeof dashboardFiltersSchema>;

export interface DashboardRoom {
  code: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
}

export interface DashboardReservation {
  id: string;
  version: number;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  partySize: number;
  status: "CONFIRMED" | "CANCELLED";
  origin: "PUBLIC" | "PHONE" | "STAFF";
  customerFirstName: string;
  customerLastName: string;
  customerPhone: string;
  customerEmail: string | null;
  preferredRoom: string;
  highChair: boolean;
  stroller: boolean;
  accessibility: boolean;
  children: boolean;
  celiac: boolean;
  allergies: string | null;
  intolerances: string | null;
  celebration: string | null;
  animals: boolean;
  notes: string | null;
  overrideApplied: boolean;
  overrideReason: string | null;
  createdAt: string;
  updatedAt: string;
  assignment: DashboardAssignmentSummary | null;
}

export interface DashboardAssignmentSource {
  room: {
    id: string;
    code: string;
    name: string;
    isActive: boolean;
  };
  tables: {
    id: string;
    name: string;
    displayOrder: number;
    isActive: boolean;
  }[];
  internalNotesPresent: boolean;
}

export interface DashboardReservationSource {
  reservation: StoredReservation;
  assignment: DashboardAssignmentSource | null;
}

export interface DashboardAssignmentSummary {
  roomCode: string;
  roomName: string;
  roomIsActive: boolean;
  roomIsAvailableForService: boolean | null;
  tableNames: string[];
  tableCount: number;
  internalNotesPresent: boolean;
  hasInactiveReferences: boolean;
  hasUnavailableRoomReference: boolean;
}

export interface DashboardSummary {
  confirmedReservations: number;
  confirmedCovers: number;
  cancellations: number;
  origins: Record<"PUBLIC" | "PHONE" | "STAFF", number>;
  foodRequests: number;
  highChairs: number;
  strollers: number;
  accessibilityRequests: number;
  assignedReservations: number;
  unassignedReservations: number;
  unassignedCovers: number;
  finalRoomCovers: { code: string; label: string; covers: number }[];
}

export type DashboardRoomAvailability = Record<
  "LUNCH" | "DINNER",
  ReadonlyMap<string, boolean>
>;

export function restaurantToday(now: Date, timezone: string): string {
  return getZonedDateTimeParts(now, timezone).date;
}

export function resolveDashboardDate(
  rawDate: unknown,
  now: Date,
  timezone: string,
): string {
  return typeof rawDate === "string" && isLocalDate(rawDate)
    ? rawDate
    : restaurantToday(now, timezone);
}

export function shiftLocalDate(localDate: string, days: number): string {
  if (!isLocalDate(localDate) || !Number.isInteger(days)) {
    throw new Error("Invalid dashboard date shift.");
  }

  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return localDateFromDatabase(date);
}

export function parseDashboardFilters(input: unknown): DashboardFilters {
  return dashboardFiltersSchema.parse(input);
}

export function filterDashboardReservations(
  reservations: readonly DashboardReservationSource[],
  filters: DashboardFilters,
): DashboardReservationSource[] {
  return reservations.filter(({ reservation, assignment }) => {
    const isOperationallyUnassigned =
      reservation.status === "CONFIRMED" && assignment === null;

    return (
      (filters.service === "ALL" ||
        reservation.serviceType === filters.service) &&
      (filters.status === "ALL" || reservation.status === filters.status) &&
      (filters.origin === "ALL" || reservation.origin === filters.origin) &&
      (filters.assignment === "ALL" ||
        (filters.assignment === "UNASSIGNED"
          ? isOperationallyUnassigned
          : assignment !== null)) &&
      (filters.finalRoom === "ALL" ||
        assignment?.room.code === filters.finalRoom)
    );
  });
}

function roomLabel(
  reservation: StoredReservation,
  roomsByCode: ReadonlyMap<string, string>,
): string {
  const preferences = parsePublicPreferences(reservation.preferences);

  if (preferences.roomCode) {
    return roomsByCode.get(preferences.roomCode) ?? preferences.roomCode;
  }

  return preferences.legacyText ?? "Non indicata";
}

export function toDashboardReservation(
  source: DashboardReservationSource,
  roomsByCode: ReadonlyMap<string, string>,
  roomAvailability: DashboardRoomAvailability | null,
): DashboardReservation {
  const { reservation } = source;
  const preferences = parsePublicPreferences(reservation.preferences);
  const allergyData = parsePublicAllergies(reservation.allergies);
  const assignment = source.assignment;
  const assignmentRoomAvailability = assignment
    ? (roomAvailability?.[reservation.serviceType].get(assignment.room.id) ??
      null)
    : null;
  const sortedTables = assignment
    ? [...assignment.tables].sort(
        (left, right) =>
          left.displayOrder - right.displayOrder ||
          left.name.localeCompare(right.name, "it") ||
          left.id.localeCompare(right.id),
      )
    : [];

  return {
    id: reservation.id,
    version: reservation.version,
    serviceType: reservation.serviceType,
    arrivalTime: reservation.arrivalTime,
    partySize: reservation.partySize,
    status: reservation.status,
    origin: reservation.origin,
    customerFirstName: reservation.customerFirstName,
    customerLastName: reservation.customerLastName,
    customerPhone: reservation.customerPhone,
    customerEmail: reservation.customerEmail,
    preferredRoom: roomLabel(reservation, roomsByCode),
    highChair: preferences.highChair,
    stroller: preferences.stroller,
    accessibility: preferences.accessibility,
    children: preferences.children,
    celiac: allergyData.celiac,
    allergies: allergyData.allergies ?? allergyData.legacyText,
    intolerances: allergyData.intolerances,
    celebration: preferences.celebration,
    animals: preferences.animals,
    notes: reservation.notes,
    overrideApplied: reservation.capacityOverride,
    overrideReason: reservation.capacityOverrideReason,
    createdAt: reservation.createdAt.toISOString(),
    updatedAt: reservation.updatedAt.toISOString(),
    assignment: assignment
      ? {
          roomCode: assignment.room.code,
          roomName: assignment.room.name,
          roomIsActive: assignment.room.isActive,
          roomIsAvailableForService: assignmentRoomAvailability,
          tableNames: sortedTables.map((table) => table.name),
          tableCount: sortedTables.length,
          internalNotesPresent: assignment.internalNotesPresent,
          hasInactiveReferences:
            !assignment.room.isActive ||
            sortedTables.some((table) => !table.isActive),
          hasUnavailableRoomReference:
            assignmentRoomAvailability === false,
        }
      : null,
  };
}

export function aggregateDashboard(
  reservations: readonly DashboardReservationSource[],
  rooms: readonly DashboardRoom[],
): DashboardSummary {
  const confirmed = reservations.filter(
    ({ reservation }) => reservation.status === "CONFIRMED",
  );
  const assigned = confirmed.filter(({ assignment }) => assignment !== null);
  const unassigned = confirmed.filter(({ assignment }) => assignment === null);
  const roomTotals = new Map<string, number>();

  for (const { reservation, assignment } of assigned) {
    if (!assignment) continue;
    roomTotals.set(
      assignment.room.code,
      (roomTotals.get(assignment.room.code) ?? 0) + reservation.partySize,
    );
  }

  const configuredTotals = rooms.map((room) => ({
    code: room.code,
    label: room.name,
    covers: roomTotals.get(room.code) ?? 0,
  }));

  return {
    confirmedReservations: confirmed.length,
    confirmedCovers: confirmed.reduce(
      (total, { reservation }) => total + reservation.partySize,
      0,
    ),
    cancellations: reservations.filter(
      ({ reservation }) => reservation.status === "CANCELLED",
    ).length,
    origins: {
      PUBLIC: confirmed.filter(
        ({ reservation }) => reservation.origin === "PUBLIC",
      ).length,
      PHONE: confirmed.filter(
        ({ reservation }) => reservation.origin === "PHONE",
      ).length,
      STAFF: confirmed.filter(
        ({ reservation }) => reservation.origin === "STAFF",
      ).length,
    },
    foodRequests: confirmed.filter(({ reservation }) => {
      const allergyData = parsePublicAllergies(reservation.allergies);
      return (
        allergyData.celiac ||
        allergyData.allergies !== null ||
        allergyData.intolerances !== null ||
        allergyData.legacyText !== null
      );
    }).length,
    highChairs: confirmed.filter(({ reservation }) =>
      parsePublicPreferences(reservation.preferences).highChair,
    ).length,
    strollers: confirmed.filter(({ reservation }) =>
      parsePublicPreferences(reservation.preferences).stroller,
    ).length,
    accessibilityRequests: confirmed.filter(
      ({ reservation }) =>
        parsePublicPreferences(reservation.preferences).accessibility,
    ).length,
    assignedReservations: assigned.length,
    unassignedReservations: unassigned.length,
    unassignedCovers: unassigned.reduce(
      (total, { reservation }) => total + reservation.partySize,
      0,
    ),
    finalRoomCovers: configuredTotals,
  };
}
