import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { FreshArrivalActor } from "@/modules/reservations/infrastructure/staff-reservation-repository";

export async function readPrivateNotesReservation(
  client: Prisma.TransactionClient,
  input: { restaurantId: string; reservationId: string },
  lock = false,
) {
  const rows = await client.$queryRaw<Array<{
    id: string;
    version: number;
    status: "CONFIRMED" | "CANCELLED";
    notes: string | null;
    privateNotes: string | null;
  }>>(Prisma.sql`
    SELECT id, version, status, notes, private_notes AS "privateNotes"
    FROM reservations
    WHERE restaurant_id = ${input.restaurantId}::uuid AND id = ${input.reservationId}::uuid
    ${lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}
  `);
  return rows[0] ?? null;
}

export async function readLegacyAssignmentNotes(
  client: Prisma.TransactionClient,
  input: { restaurantId: string; reservationId: string },
) {
  return client.reservationAssignment.findFirst({
    where: { restaurantId: input.restaurantId, reservationId: input.reservationId },
    select: { internalNotes: true, clearedAt: true },
  });
}

export async function updatePrivateNotes(
  client: Prisma.TransactionClient,
  input: {
    restaurantId: string;
    reservationId: string;
    expectedVersion: number;
    privateNotes: string | null;
    updatedAt: Date;
  },
) {
  // Bind the text as a SQL parameter; diagnostics never interpolate private notes.
  return client.$executeRaw(Prisma.sql`
    UPDATE reservations
    SET private_notes = ${input.privateNotes}, version = version + 1, updated_at = ${input.updatedAt}
    WHERE id = ${input.reservationId}::uuid AND restaurant_id = ${input.restaurantId}::uuid
      AND status = 'CONFIRMED' AND version = ${input.expectedVersion}
  `);
}

export async function insertPrivateNotesAudit(
  client: Prisma.TransactionClient,
  input: {
    actor: FreshArrivalActor;
    reservationId: string;
    correlationId: string;
    previousState: Prisma.InputJsonValue;
    newState: Prisma.InputJsonValue;
    createdAt: Date;
  },
) {
  await client.reservationAuditEvent.create({
    data: {
      restaurantId: input.actor.restaurantId,
      reservationId: input.reservationId,
      action: "PRIVATE_NOTES_UPDATED",
      actorOrigin: "STAFF",
      actorUserId: input.actor.id,
      actorRole: input.actor.role,
      correlationId: input.correlationId,
      previousState: input.previousState,
      newState: input.newState,
      capacityOverride: false,
      capacityOverrideReason: null,
      createdAt: input.createdAt,
    },
  });
}
