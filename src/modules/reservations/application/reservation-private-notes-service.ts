import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import {
  normalizePrivateNotes,
  privateNotesAuditSnapshot,
  reservationPrivateNotesInputSchema,
  type ReservationPrivateNotesContext,
} from "@/modules/reservations/domain/reservation-notes";
import { runReservationTransaction } from "@/modules/reservations/infrastructure/reservation-repository";
import { acquireReservationMutationLock } from "@/modules/reservations/infrastructure/reservation-locks";
import { readFreshArrivalActor } from "@/modules/reservations/infrastructure/staff-reservation-repository";
import {
  insertPrivateNotesAudit,
  readLegacyAssignmentNotes,
  readPrivateNotesReservation,
  updatePrivateNotes,
} from "@/modules/reservations/infrastructure/reservation-notes-repository";
import { prisma } from "@/server/db/prisma";

type PrivateNotesErrorCode = "VALIDATION" | "FORBIDDEN" | "NOT_FOUND" | "CANCELLED" | "VERSION_CONFLICT";
export class ReservationPrivateNotesError extends Error {
  constructor(readonly code: PrivateNotesErrorCode, readonly publicMessage: string) {
    super(publicMessage);
    this.name = "ReservationPrivateNotesError";
  }
}

export function privateNotesErrorStatus(code: PrivateNotesErrorCode) {
  return { VALIDATION: 400, FORBIDDEN: 403, NOT_FOUND: 404, CANCELLED: 409, VERSION_CONFLICT: 409 }[code];
}

interface PrivateNotesActor { id: string; restaurantId: string }

async function requireActor(client: Prisma.TransactionClient, actor: PrivateNotesActor) {
  const fresh = await readFreshArrivalActor(client, { actorId: actor.id, restaurantId: actor.restaurantId });
  if (!fresh) throw new ReservationPrivateNotesError("FORBIDDEN", "L'utente non può gestire le note interne.");
  return fresh;
}

export async function getReservationPrivateNotes(input: {
  actor: PrivateNotesActor;
  reservationId: string;
}): Promise<ReservationPrivateNotesContext> {
  return prisma.$transaction(async (client) => {
    await requireActor(client, input.actor);
    const identity = { restaurantId: input.actor.restaurantId, reservationId: input.reservationId };
    const row = await readPrivateNotesReservation(client, identity);
    if (!row) throw new ReservationPrivateNotesError("NOT_FOUND", "Prenotazione non trovata.");
    const legacy = await readLegacyAssignmentNotes(client, identity);
    const privateNotes = normalizePrivateNotes(row.privateNotes);
    return {
      reservation: { id: row.id, version: row.version, status: row.status, notes: row.notes },
      privateNotes,
      privateNotesPresent: privateNotes !== null,
      legacyAssignment: legacy ? {
        internalNotes: legacy.internalNotes,
        internalNotesPresent: legacy.internalNotes !== null && legacy.internalNotes !== "",
        state: legacy.clearedAt === null ? "ACTIVE" : "CLEARED",
      } : null,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function putReservationPrivateNotes(input: {
  actor: PrivateNotesActor;
  reservationId: string;
  rawPayload: unknown;
  now?: Date;
}) {
  const parsed = reservationPrivateNotesInputSchema.safeParse(input.rawPayload);
  const now = input.now ?? new Date();
  if (!parsed.success || Number.isNaN(now.getTime())) {
    throw new ReservationPrivateNotesError("VALIDATION", "I dati della nota interna non sono validi.");
  }
  const correlationId = randomUUID();
  return runReservationTransaction(async (client) => {
    await acquireReservationMutationLock(client, input.actor.restaurantId, input.reservationId);
    const actor = await requireActor(client, input.actor);
    const identity = { restaurantId: actor.restaurantId, reservationId: input.reservationId };
    const row = await readPrivateNotesReservation(client, identity, true);
    if (!row) throw new ReservationPrivateNotesError("NOT_FOUND", "Prenotazione non trovata.");
    if (row.status !== "CONFIRMED") {
      throw new ReservationPrivateNotesError("CANCELLED", "La prenotazione cancellata è consultabile in sola lettura.");
    }
    const current = normalizePrivateNotes(row.privateNotes);
    const desired = parsed.data.privateNotes;
    if (current === desired) return { changed: false, reservationVersion: row.version, privateNotes: current };
    if (row.version !== parsed.data.version) {
      throw new ReservationPrivateNotesError("VERSION_CONFLICT", "La prenotazione è stata aggiornata da un altro operatore.");
    }
    const count = await updatePrivateNotes(client, {
      ...identity, expectedVersion: row.version, privateNotes: desired, updatedAt: now,
    });
    if (count !== 1) throw new ReservationPrivateNotesError("VERSION_CONFLICT", "La prenotazione è stata aggiornata da un altro operatore.");
    await insertPrivateNotesAudit(client, {
      actor, reservationId: row.id, correlationId,
      previousState: privateNotesAuditSnapshot(current, row.version),
      newState: privateNotesAuditSnapshot(desired, row.version + 1),
      createdAt: now,
    });
    return { changed: true, reservationVersion: row.version + 1, privateNotes: desired };
  });
}
