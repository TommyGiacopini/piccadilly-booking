import "server-only";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { ExportActorUnavailableError, ExportSnapshotTooLargeError } from "@/modules/exports/application/export-errors";
import { EXPORT_PREVIEW_ROOMS, ExportPreviewDataError, type ExportPreviewRequest, type ExportPreviewSnapshot, type ExportPreviewReservation } from "@/modules/exports/domain/export-contract";
import type {
  ExportActorReference,
  ExportAuditWriteInput,
} from "@/modules/exports/application/export-ports";
import { insertAuditEvent } from "@/modules/audit/infrastructure/audit-repository";
import {
  buildExportDays,
  EXCEL_MAX_RESERVATIONS,
  compareExportTables,
  type ExportPeriod,
  type ExportReservationDto,
  type ExportSnapshotDto,
} from "@/modules/exports/domain/export-domain";
import {
  localDateFromDatabase,
  localDateToDatabase,
  operationalTimeFromDatabase,
} from "@/modules/configuration/domain/operational-time";
import {
  parsePublicAllergies,
  parsePublicPreferences,
} from "@/modules/reservations/domain/public-validation";
import { prisma } from "@/server/db/prisma";

export { ExportActorUnavailableError };
export type { ExportActorReference };

export async function readExportSnapshotWithClient(
  client: PrismaClient,
  input: { actor: ExportActorReference; period: ExportPeriod; maximumReservations?: number },
  hooks: { afterContextRead?: () => Promise<void> } = {},
): Promise<ExportSnapshotDto> {
  return client.$transaction(
    async (transaction) => {
      const actor = await transaction.user.findFirst({
        where: { id: input.actor.id, restaurantId: input.actor.restaurantId },
        select: {
          restaurantId: true,
          role: true,
          isActive: true,
          disabledAt: true,
          mustChangePassword: true,
        },
      });
      if (
        !actor ||
        !actor.isActive ||
        actor.disabledAt !== null ||
        actor.mustChangePassword ||
        (actor.role !== "ADMIN" && actor.role !== "STAFF")
      ) {
        throw new ExportActorUnavailableError();
      }

      const restaurant = await transaction.restaurant.findUnique({
        where: { id: actor.restaurantId },
        select: { name: true, timezone: true },
      });
      if (!restaurant) throw new Error("Export restaurant is unavailable.");

      const rooms = await transaction.room.findMany({
        where: { restaurantId: actor.restaurantId },
        select: { code: true, name: true },
      });
      const roomsByCode = new Map(rooms.map((room) => [room.code, room.name]));
      await hooks.afterContextRead?.();

      const rows = await transaction.reservation.findMany({
        take: (input.maximumReservations ?? EXCEL_MAX_RESERVATIONS) + 1,
        where: {
          restaurantId: actor.restaurantId,
          status: "CONFIRMED",
          localDate: {
            gte: localDateToDatabase(input.period.fromDate),
            lte: localDateToDatabase(input.period.toDate),
          },
        },
        orderBy: [{ localDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          localDate: true,
          serviceType: true,
          arrivalTime: true,
          customerFirstName: true,
          customerLastName: true,
          partySize: true,
          customerPhone: true,
          origin: true,
          preferences: true,
          allergies: true,
          notes: true,
          createdAt: true,
          assignment: {
            select: {
              clearedAt: true,
              room: { select: { code: true, name: true } },
              tables: {
                where: { restaurantId: actor.restaurantId },
                select: {
                  diningTable: {
                    select: { id: true, name: true, displayOrder: true },
                  },
                },
              },
            },
          },
        },
      });

      if (rows.length > (input.maximumReservations ?? EXCEL_MAX_RESERVATIONS)) throw new ExportSnapshotTooLargeError();
      const reservations: ExportReservationDto[] = rows.map((row) => {
        const preferences = parsePublicPreferences(row.preferences);
        const allergyData = parsePublicAllergies(row.allergies);
        const preferredRoom = preferences.roomCode
          ? (roomsByCode.get(preferences.roomCode) ?? preferences.roomCode)
          : (preferences.legacyText ?? "Non indicata");
        const activeAssignment =
          row.assignment?.clearedAt === null ? row.assignment : null;

        return {
          id: row.id,
          localDate: localDateFromDatabase(row.localDate),
          serviceType: row.serviceType,
          arrivalTime: operationalTimeFromDatabase(row.arrivalTime),
          customerFirstName: row.customerFirstName,
          customerLastName: row.customerLastName,
          partySize: row.partySize,
          customerPhone: row.customerPhone,
          origin: row.origin,
          preferredRoom,
          highChair: preferences.highChair,
          stroller: preferences.stroller,
          accessibility: preferences.accessibility,
          children: preferences.children,
          celiac: allergyData.celiac,
          allergies: allergyData.allergies ?? allergyData.legacyText,
          intolerances: allergyData.intolerances,
          celebration: preferences.celebration,
          animals: preferences.animals,
          notes: row.notes,
          createdAt: row.createdAt,
          assignment: activeAssignment
            ? {
                roomCode: activeAssignment.room.code,
                roomName: activeAssignment.room.name,
                tables: activeAssignment.tables
                  .map(({ diningTable }) => diningTable)
                  .sort(compareExportTables),
              }
            : null,
        };
      });

      return {
        restaurantName: restaurant.name,
        timezone: restaurant.timezone,
        fromDate: input.period.fromDate,
        toDate: input.period.toDate,
        reservationCount: reservations.length,
        days: buildExportDays(input.period.dates, reservations),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

export function readExportSnapshot(input: {
  actor: ExportActorReference;
  period: ExportPeriod;
  maximumReservations?: number;
}): Promise<ExportSnapshotDto> {
  return readExportSnapshotWithClient(prisma, input);
}
export async function readExportPreviewWithClient(
  client: PrismaClient,
  input: { actor: ExportActorReference; selection: ExportPreviewRequest; maximumReservations: number },
  hooks: { afterContextRead?: () => Promise<void> } = {},
): Promise<ExportPreviewSnapshot> {
  return client.$transaction(async transaction => {
    const actor = await transaction.user.findFirst({
      where: { id: input.actor.id, restaurantId: input.actor.restaurantId },
      select: { restaurantId: true, role: true, isActive: true, disabledAt: true, mustChangePassword: true },
    });
    if (!actor || !actor.isActive || actor.disabledAt !== null || actor.mustChangePassword
      || actor.role !== "ADMIN" && actor.role !== "STAFF") throw new ExportActorUnavailableError();
    const restaurant = await transaction.restaurant.findUnique({
      where: { id: actor.restaurantId }, select: { name: true, timezone: true },
    });
    if (!restaurant) throw new Error("Export restaurant unavailable.");
    const rooms = await transaction.room.findMany({
      where: { restaurantId: actor.restaurantId }, select: { code: true, name: true },
    });
    const roomNames = new Map(rooms.map(room => [room.code, room.name]));
    const base: Prisma.ReservationWhereInput = {
      restaurantId: actor.restaurantId, status: "CONFIRMED",
      localDate: localDateToDatabase(input.selection.period.date), serviceType: input.selection.service,
    };
    const relevantLegacy = await transaction.room.findMany({
      where: {
        restaurantId: actor.restaurantId, code: { in: ["galleria", "terrazzo"] },
        reservationAssignments: { some: { restaurantId: actor.restaurantId, clearedAt: null, reservation: base } },
      },
      select: { code: true }, take: 2,
    });
    await hooks.afterContextRead?.();
    const selectedRoom = EXPORT_PREVIEW_ROOMS.find(room => room.key === input.selection.room);
    const where: Prisma.ReservationWhereInput = { ...base };
    if (input.selection.room === "UNASSIGNED") where.OR = [
      { assignment: { is: null } }, { assignment: { is: { restaurantId: actor.restaurantId, clearedAt: { not: null } } } },
    ];
    else if (selectedRoom?.code) where.assignment = {
      is: { restaurantId: actor.restaurantId, clearedAt: null, room: { restaurantId: actor.restaurantId, code: selectedRoom.code } },
    };
    const rows = await transaction.reservation.findMany({
      where, take: input.maximumReservations + 1,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true, localDate: true, serviceType: true, arrivalTime: true,
        customerFirstName: true, customerLastName: true, partySize: true,
        childrenCount: true, gameRoomPreference: true, preferences: true, allergies: true, notes: true, createdAt: true,
        assignment: { select: {
          restaurantId: true, roomId: true, clearedAt: true,
          room: { select: { id: true, restaurantId: true, code: true, name: true } },
          tables: {
            where: { restaurantId: actor.restaurantId },
            select: { restaurantId: true, roomId: true, diningTable: { select: { id: true, roomId: true, name: true, displayOrder: true } } },
          },
        } },
      },
    });
    if (rows.length > input.maximumReservations) throw new ExportSnapshotTooLargeError();
    const reservations: ExportPreviewReservation[] = rows.map(row => {
      const preferences = parsePublicPreferences(row.preferences), allergyData = parsePublicAllergies(row.allergies);
      const assignment = row.assignment?.clearedAt === null ? row.assignment : null;
      if (assignment && (assignment.restaurantId !== actor.restaurantId || assignment.room.restaurantId !== actor.restaurantId
        || assignment.roomId !== assignment.room.id || assignment.tables.some(link => link.restaurantId !== actor.restaurantId
          || link.roomId !== assignment.roomId || link.diningTable.roomId !== assignment.roomId))) throw new ExportPreviewDataError();
      return {
        id: row.id, localDate: localDateFromDatabase(row.localDate), serviceType: row.serviceType,
        arrivalTime: operationalTimeFromDatabase(row.arrivalTime),
        customerFirstName: row.customerFirstName, customerLastName: row.customerLastName, partySize: row.partySize,
        childrenCount: row.childrenCount, gameRoomPreference: row.gameRoomPreference, legacyChildren: preferences.children,
        preferredRoom: preferences.roomCode ? roomNames.get(preferences.roomCode) ?? preferences.roomCode : preferences.legacyText ?? "Non indicata",
        highChair: preferences.highChair, stroller: preferences.stroller, accessibility: preferences.accessibility,
        celiac: allergyData.celiac, allergies: allergyData.allergies ?? allergyData.legacyText,
        intolerances: allergyData.intolerances, celebration: preferences.celebration, animals: preferences.animals,
        notes: row.notes, createdAt: row.createdAt,
        assignment: assignment ? {
          roomCode: assignment.room.code, roomName: assignment.room.name,
          tables: assignment.tables.map(link => ({ id: link.diningTable.id, name: link.diningTable.name, displayOrder: link.diningTable.displayOrder })),
        } : null,
      };
    });
    return {
      restaurantName: restaurant.name, timezone: restaurant.timezone, reservations,
      availableLegacyRooms: relevantLegacy.map(room => room.code === "galleria" ? "GALLERIA" : "TERRAZZO"),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export function readExportPreview(input: Parameters<typeof readExportPreviewWithClient>[1]): Promise<ExportPreviewSnapshot> {
  return readExportPreviewWithClient(prisma, input);
}

export async function writeExportAuditWithClient(
  client: PrismaClient,
  input: ExportAuditWriteInput,
): Promise<void> {
  await client.$transaction(async (transaction) => {
    const actor = await transaction.user.findFirst({
      where: { id: input.actor.id, restaurantId: input.actor.restaurantId },
      select: {
        id: true,
        restaurantId: true,
        role: true,
        isActive: true,
        disabledAt: true,
        mustChangePassword: true,
      },
    });
    if (
      !actor ||
      !actor.isActive ||
      actor.disabledAt !== null ||
      actor.mustChangePassword ||
      (actor.role !== "ADMIN" && actor.role !== "STAFF")
    ) {
      throw new ExportActorUnavailableError();
    }
    await insertAuditEvent(transaction, {
      restaurantId: actor.restaurantId,
      category: "EXPORT",
      action:
        input.format === "PDF"
          ? "PDF_EXPORT_REQUESTED"
          : "EXCEL_EXPORT_REQUESTED",
      outcome: input.outcome,
      actorUserId: actor.id,
      actorRole: actor.role,
      entityType: null,
      entityId: null,
      correlationId: input.correlationId,
      previousState: null,
      newState: null,
      metadata: input.metadata as Prisma.InputJsonValue,
      createdAt: input.createdAt,
    });
  });
}

export function writeExportAudit(
  input: Parameters<typeof writeExportAuditWithClient>[1],
): Promise<void> {
  return writeExportAuditWithClient(prisma, input);
}
