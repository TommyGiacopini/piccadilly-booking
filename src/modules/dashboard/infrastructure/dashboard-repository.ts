import "server-only";

import { localDateToDatabase } from "@/modules/configuration/domain/operational-time";
import type {
  DashboardReservationSource,
  DashboardRoom,
  DashboardRoomAvailability,
  DashboardNotificationHealthRow,
} from "@/modules/dashboard/domain/dashboard-domain";
import { deriveLatestNotificationHealth } from "@/modules/dashboard/domain/dashboard-domain";
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
  privateNotesPresent: boolean;
  legacyNotesPresent: boolean;
  legacyNotesState: "ACTIVE" | "CLEARED" | null;
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
        select: {
          id: true,
          restaurantId: true,
          localDate: true,
          serviceType: true,
          arrivalTime: true,
          partySize: true,
          childrenCount: true,
          gameRoomPreference: true,
          status: true,
          origin: true,
          customerFirstName: true,
          customerLastName: true,
          customerPhone: true,
          customerEmail: true,
          notes: true,
          preferences: true,
          allergies: true,
          privacyPolicyVersion: true,
          privacyConsentAt: true,
          privacyConsentMethod: true,
          termsPolicyVersion: true,
          termsConsentAt: true,
          termsConsentMethod: true,
          consentLanguage: true,
          createdByUserId: true,
          capacityOverride: true,
          capacityOverrideReason: true,
          createdAt: true,
          updatedAt: true,
          cancelledAt: true,
          arrivedAt: true,
          version: true,
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
          reservation.id AS "reservationId",
          (reservation.private_notes IS NOT NULL AND reservation.private_notes <> '') AS "privateNotesPresent",
          (assignment.internal_notes IS NOT NULL) AS "legacyNotesPresent",
          CASE WHEN assignment.id IS NULL THEN NULL
            WHEN assignment.cleared_at IS NULL THEN 'ACTIVE' ELSE 'CLEARED' END AS "legacyNotesState"
        FROM reservations AS reservation
        LEFT JOIN reservation_assignments AS assignment
          ON reservation.restaurant_id = assignment.restaurant_id
          AND reservation.id = assignment.reservation_id
        WHERE reservation.restaurant_id = ${input.restaurantId}::uuid
          AND reservation.local_date = ${localDate}::date
      `);
      const notePresenceByReservationId = new Map(
        notePresenceRows.map((row) => [
          row.reservationId,
          row,
        ]),
      );
      const reservationIds = reservations.map((reservation) => reservation.id);
      const notificationRows =
        reservationIds.length === 0
          ? []
          : await transaction.$queryRaw<
              Array<
                DashboardNotificationHealthRow & { reservationId: string }
              >
            >(Prisma.sql`
              WITH notification_groups AS (
                SELECT
                  reservation_id,
                  event_group_id,
                  reservation_version,
                  MAX(COALESCE(terminal_at, updated_at, created_at)) AS activity_at
                FROM notification_outbox
                WHERE restaurant_id = ${input.restaurantId}::uuid
                  AND reservation_id IN (${Prisma.join(
                    reservationIds.map(
                      (reservationId) => Prisma.sql`${reservationId}::uuid`,
                    ),
                  )})
                GROUP BY reservation_id, event_group_id, reservation_version
                HAVING NOT BOOL_AND(status = 'CANCELLED')
              ), ranked_groups AS (
                SELECT
                  reservation_id,
                  event_group_id,
                  reservation_version,
                  activity_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY reservation_id
                    ORDER BY reservation_version DESC, activity_at DESC, event_group_id DESC
                  ) AS position
                FROM notification_groups
              )
              SELECT
                outbox.reservation_id AS "reservationId",
                outbox.event_group_id AS "eventGroupId",
                outbox.reservation_version AS "reservationVersion",
                outbox.status,
                ranked.activity_at AS "createdAt"
              FROM ranked_groups AS ranked
              INNER JOIN notification_outbox AS outbox
                ON outbox.restaurant_id = ${input.restaurantId}::uuid
                AND outbox.reservation_id = ranked.reservation_id
                AND outbox.event_group_id = ranked.event_group_id
              WHERE ranked.position = 1
              ORDER BY outbox.reservation_id, outbox.channel, outbox.id
            `);
      const healthRowsByReservation = new Map<
        string,
        DashboardNotificationHealthRow[]
      >();
      for (const row of notificationRows) {
        const rows = healthRowsByReservation.get(row.reservationId) ?? [];
        rows.push(row);
        healthRowsByReservation.set(row.reservationId, rows);
      }

      return reservations.map((row) => ({
        reservation: mapReservation(row),
        privateNotesPresent: notePresenceByReservationId.get(row.id)?.privateNotesPresent === true,
        legacyNotesPresent: notePresenceByReservationId.get(row.id)?.legacyNotesPresent === true,
        legacyNotesState: notePresenceByReservationId.get(row.id)?.legacyNotesState ?? null,
        assignment:
          row.assignment?.clearedAt === null
            ? {
                room: row.assignment.room,
                tables: row.assignment.tables.map(
                  ({ diningTable }) => diningTable,
                ),
                internalNotesPresent:
                  notePresenceByReservationId.get(row.id)?.legacyNotesPresent === true,
              }
            : null,
        notificationHealth: deriveLatestNotificationHealth(
          healthRowsByReservation.get(row.id) ?? [],
        ),
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
