import "server-only";

import { localDateToDatabase } from "@/modules/configuration/domain/operational-time";
import type {
  DashboardReservationSource,
  DashboardRoom,
  DashboardRoomAvailability,
} from "@/modules/dashboard/domain/dashboard-domain";
import { mapReservation } from "@/modules/reservations/infrastructure/reservation-repository";
import { readEffectiveServiceRooms } from "@/modules/rooms/infrastructure/service-instance-repository";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
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

interface AssignmentNotePresenceRow {
  reservationId: string;
  internalNotesPresent: boolean;
}

export async function readDashboardReservationsWithClient(
  client: PrismaClient,
  input: {
    restaurantId: string;
    localDate: string;
  },
): Promise<DashboardReservationSource[]> {
  const localDate = localDateToDatabase(input.localDate);

  return client.$transaction(
    async (transaction) => {
      const reservations = await transaction.reservation.findMany({
        where: {
          restaurantId: input.restaurantId,
          localDate,
        },
        orderBy: [
          { serviceType: "asc" },
          { arrivalTime: "asc" },
          { createdAt: "asc" },
          { id: "asc" },
        ],
        include: {
          assignment: {
            select: {
              clearedAt: true,
              room: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  isActive: true,
                },
              },
              tables: {
                select: {
                  diningTable: {
                    select: {
                      id: true,
                      name: true,
                      displayOrder: true,
                      isActive: true,
                    },
                  },
                },
                orderBy: { diningTableId: "asc" },
              },
            },
          },
        },
      });
      const notePresenceRows = await transaction.$queryRaw<
        AssignmentNotePresenceRow[]
      >(Prisma.sql`
        SELECT
          assignment.reservation_id AS "reservationId",
          assignment.internal_notes IS NOT NULL AS "internalNotesPresent"
        FROM reservation_assignments AS assignment
        INNER JOIN reservations AS reservation
          ON reservation.restaurant_id = assignment.restaurant_id
          AND reservation.id = assignment.reservation_id
        WHERE assignment.restaurant_id = ${input.restaurantId}::uuid
          AND reservation.restaurant_id = ${input.restaurantId}::uuid
          AND reservation.local_date = ${localDate}::date
          AND assignment.cleared_at IS NULL
      `);
      const notePresenceByReservationId = new Map(
        notePresenceRows.map((row) => [
          row.reservationId,
          row.internalNotesPresent,
        ]),
      );

      return reservations.map((row) => ({
        reservation: mapReservation(row),
        assignment:
          row.assignment?.clearedAt === null
            ? {
                room: row.assignment.room,
                tables: row.assignment.tables.map(
                  ({ diningTable }) => diningTable,
                ),
                internalNotesPresent:
                  notePresenceByReservationId.get(row.id) === true,
              }
            : null,
      }));
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export async function readDashboardReservations(input: {
  restaurantId: string;
  localDate: string;
}): Promise<DashboardReservationSource[]> {
  return readDashboardReservationsWithClient(prisma, input);
}

export async function readDashboardRoomAvailability(input: {
  restaurantId: string;
  localDate: string;
  now: Date;
}): Promise<DashboardRoomAvailability> {
  const lunch = await readEffectiveServiceRooms(prisma, {
    restaurantId: input.restaurantId,
    localDate: input.localDate,
    serviceType: "LUNCH",
    now: input.now,
  });
  const dinner = await readEffectiveServiceRooms(prisma, {
    restaurantId: input.restaurantId,
    localDate: input.localDate,
    serviceType: "DINNER",
    now: input.now,
  });

  return {
    LUNCH: new Map(lunch.rooms.map((room) => [room.id, room.isAvailable])),
    DINNER: new Map(dinner.rooms.map((room) => [room.id, room.isAvailable])),
  };
}
