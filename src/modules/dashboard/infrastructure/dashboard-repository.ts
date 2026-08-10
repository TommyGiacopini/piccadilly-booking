import "server-only";

import { localDateToDatabase } from "@/modules/configuration/domain/operational-time";
import type { DashboardRoom } from "@/modules/dashboard/domain/dashboard-domain";
import type { StoredReservation } from "@/modules/reservations/domain/types";
import { mapReservation } from "@/modules/reservations/infrastructure/reservation-repository";
import { prisma } from "@/server/db/prisma";

export interface DashboardContext {
  restaurantName: string;
  timezone: string;
  rooms: DashboardRoom[];
}

export async function readDashboardContext(
  restaurantId: string,
): Promise<DashboardContext | null> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      name: true,
      timezone: true,
    },
  });

  if (!restaurant) return null;

  const rooms = await prisma.room.findMany({
    where: { restaurantId },
    select: { code: true, name: true, displayOrder: true, isActive: true },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });

  return {
    restaurantName: restaurant.name,
    timezone: restaurant.timezone,
    rooms,
  };
}

export async function readDashboardReservations(input: {
  restaurantId: string;
  localDate: string;
}): Promise<StoredReservation[]> {
  const reservations = await prisma.reservation.findMany({
    where: {
      restaurantId: input.restaurantId,
      localDate: localDateToDatabase(input.localDate),
    },
    orderBy: [
      { serviceType: "asc" },
      { arrivalTime: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });

  return reservations.map(mapReservation);
}
