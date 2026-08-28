import "server-only";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { ExportActorUnavailableError } from "@/modules/exports/application/export-errors";
import type {
  ExportActorReference,
  ExportAuditWriteInput,
} from "@/modules/exports/application/export-ports";
import { insertAuditEvent } from "@/modules/audit/infrastructure/audit-repository";
import {
  buildExportDays,
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
  input: { actor: ExportActorReference; period: ExportPeriod },
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
              internalNotes: true,
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
                internalNotes: activeAssignment.internalNotes,
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
}): Promise<ExportSnapshotDto> {
  return readExportSnapshotWithClient(prisma, input);
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
