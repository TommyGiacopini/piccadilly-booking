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
  unassignedReservations: number;
  preferredRoomCovers: { label: string; covers: number }[];
}

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
  reservations: readonly StoredReservation[],
  filters: DashboardFilters,
): StoredReservation[] {
  return reservations.filter(
    (reservation) =>
      (filters.service === "ALL" ||
        reservation.serviceType === filters.service) &&
      (filters.status === "ALL" || reservation.status === filters.status) &&
      (filters.origin === "ALL" || reservation.origin === filters.origin),
  );
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
  reservation: StoredReservation,
  roomsByCode: ReadonlyMap<string, string>,
): DashboardReservation {
  const preferences = parsePublicPreferences(reservation.preferences);
  const allergyData = parsePublicAllergies(reservation.allergies);

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
  };
}

export function aggregateDashboard(
  reservations: readonly StoredReservation[],
  rooms: readonly DashboardRoom[],
): DashboardSummary {
  const confirmed = reservations.filter(
    (reservation) => reservation.status === "CONFIRMED",
  );
  const roomsByCode = new Map(rooms.map((room) => [room.code, room.name]));
  const roomTotals = new Map<string, number>();

  for (const reservation of confirmed) {
    const label = roomLabel(reservation, roomsByCode);
    roomTotals.set(label, (roomTotals.get(label) ?? 0) + reservation.partySize);
  }

  const configuredRoomNames = new Set(rooms.map((room) => room.name));
  const configuredTotals = rooms.map((room) => ({
    label: room.name,
    covers: roomTotals.get(room.name) ?? 0,
  }));
  const extraTotals = [...roomTotals.entries()]
    .filter(([label]) => !configuredRoomNames.has(label))
    .sort(([left], [right]) => left.localeCompare(right, "it"))
    .map(([label, covers]) => ({ label, covers }));

  return {
    confirmedReservations: confirmed.length,
    confirmedCovers: confirmed.reduce(
      (total, reservation) => total + reservation.partySize,
      0,
    ),
    cancellations: reservations.filter(
      (reservation) => reservation.status === "CANCELLED",
    ).length,
    origins: {
      PUBLIC: confirmed.filter((reservation) => reservation.origin === "PUBLIC")
        .length,
      PHONE: confirmed.filter((reservation) => reservation.origin === "PHONE")
        .length,
      STAFF: confirmed.filter((reservation) => reservation.origin === "STAFF")
        .length,
    },
    foodRequests: confirmed.filter((reservation) => {
      const allergyData = parsePublicAllergies(reservation.allergies);
      return (
        allergyData.celiac ||
        allergyData.allergies !== null ||
        allergyData.intolerances !== null ||
        allergyData.legacyText !== null
      );
    }).length,
    highChairs: confirmed.filter(
      (reservation) => parsePublicPreferences(reservation.preferences).highChair,
    ).length,
    strollers: confirmed.filter(
      (reservation) => parsePublicPreferences(reservation.preferences).stroller,
    ).length,
    accessibilityRequests: confirmed.filter(
      (reservation) =>
        parsePublicPreferences(reservation.preferences).accessibility,
    ).length,
    unassignedReservations: confirmed.length,
    preferredRoomCovers: [...configuredTotals, ...extraTotals],
  };
}
