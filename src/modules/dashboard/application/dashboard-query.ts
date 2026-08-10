import "server-only";

import { getAvailabilityPreview } from "@/modules/availability/application/availability-service";
import type { AvailabilityResult } from "@/modules/availability/domain/types";
import {
  aggregateDashboard,
  dashboardFiltersSchema,
  filterDashboardReservations,
  resolveDashboardDate,
  shiftLocalDate,
  toDashboardReservation,
  type DashboardFilters,
  type DashboardReservation,
  type DashboardRoom,
  type DashboardSummary,
} from "@/modules/dashboard/domain/dashboard-domain";
import {
  readDashboardContext,
  readDashboardReservations,
} from "@/modules/dashboard/infrastructure/dashboard-repository";

export interface DashboardDayView {
  restaurantName: string;
  timezone: string;
  localDate: string;
  previousDate: string;
  nextDate: string;
  filters: DashboardFilters;
  invalidQuery: boolean;
  rooms: DashboardRoom[];
  reservations: DashboardReservation[];
  summary: DashboardSummary;
  availability: Record<"LUNCH" | "DINNER", AvailabilityResult>;
}

export async function getStaffReservationFormContext(input: {
  restaurantId: string;
  rawDate?: unknown;
  now?: Date;
}) {
  const context = await readDashboardContext(input.restaurantId);

  if (!context) throw new Error("Dashboard restaurant configuration not found.");

  return {
    timezone: context.timezone,
    rooms: context.rooms,
    localDate: resolveDashboardDate(
      input.rawDate,
      input.now ?? new Date(),
      context.timezone,
    ),
  };
}

export async function getDashboardDay(input: {
  restaurantId: string;
  rawDate?: unknown;
  rawService?: unknown;
  rawStatus?: unknown;
  rawOrigin?: unknown;
  now?: Date;
}): Promise<DashboardDayView> {
  const context = await readDashboardContext(input.restaurantId);

  if (!context) throw new Error("Dashboard restaurant configuration not found.");

  const now = input.now ?? new Date();
  const dateWasValid =
    input.rawDate === undefined ||
    resolveDashboardDate(input.rawDate, now, context.timezone) === input.rawDate;
  const localDate = resolveDashboardDate(input.rawDate, now, context.timezone);
  const parsedFilters = dashboardFiltersSchema.safeParse({
    service: input.rawService ?? "ALL",
    status: input.rawStatus ?? "ALL",
    origin: input.rawOrigin ?? "ALL",
  });
  const filters: DashboardFilters = parsedFilters.success
    ? parsedFilters.data
    : { service: "ALL", status: "ALL", origin: "ALL" };

  const allReservations = await readDashboardReservations({
    restaurantId: input.restaurantId,
    localDate,
  });
  const lunchAvailability = await getAvailabilityPreview({
    restaurantId: input.restaurantId,
    date: localDate,
    serviceType: "LUNCH",
    partySize: 1,
    channel: "STAFF",
    now,
    includePersistentLoad: true,
  });
  const dinnerAvailability = await getAvailabilityPreview({
    restaurantId: input.restaurantId,
    date: localDate,
    serviceType: "DINNER",
    partySize: 1,
    channel: "STAFF",
    now,
    includePersistentLoad: true,
  });
  const filtered = filterDashboardReservations(allReservations, filters);
  const roomsByCode = new Map(
    context.rooms.map((room) => [room.code, room.name]),
  );

  return {
    restaurantName: context.restaurantName,
    timezone: context.timezone,
    localDate,
    previousDate: shiftLocalDate(localDate, -1),
    nextDate: shiftLocalDate(localDate, 1),
    filters,
    invalidQuery: !dateWasValid || !parsedFilters.success,
    rooms: context.rooms,
    reservations: filtered.map((reservation) =>
      toDashboardReservation(reservation, roomsByCode),
    ),
    summary: aggregateDashboard(filtered, context.rooms),
    availability: {
      LUNCH: lunchAvailability,
      DINNER: dinnerAvailability,
    },
  };
}
