import "server-only";

import { randomUUID } from "node:crypto";

import {
  reservationArrivalAuditSnapshot,
  reservationArrivalInputSchema,
} from "@/modules/reservations/domain/reservation-arrival";
import { runReservationTransaction } from "@/modules/reservations/infrastructure/reservation-repository";
import { acquireReservationMutationLock } from "@/modules/reservations/infrastructure/reservation-locks";
import {
  insertReservationArrivalAudit,
  readArrivalReservation,
  readFreshArrivalActor,
  updateReservationArrival,
} from "@/modules/reservations/infrastructure/staff-reservation-repository";

export type ReservationArrivalErrorCode =
  | "VALIDATION"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "INVARIANT";

export class ReservationArrivalError extends Error {
  constructor(
    readonly code: ReservationArrivalErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ReservationArrivalError";
  }
}

export function reservationArrivalErrorStatus(
  code: ReservationArrivalErrorCode,
): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "VERSION_CONFLICT":
      return 409;
    case "INVARIANT":
      return 500;
  }
}

export interface ReservationArrivalActor {
  id: string;
  restaurantId: string;
}

export interface ReservationArrivalMutationResult {
  changed: boolean;
  reservationVersion: number;
  arrivedAt: string | null;
}

export async function putReservationArrival(input: {
  actor: ReservationArrivalActor;
  reservationId: string;
  rawPayload: unknown;
  now?: Date;
}): Promise<ReservationArrivalMutationResult> {
  const parsed = reservationArrivalInputSchema.safeParse(input.rawPayload);
  if (!parsed.success) {
    throw new ReservationArrivalError(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "I dati di arrivo non sono validi.",
    );
  }
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new ReservationArrivalError(
      "VALIDATION",
      "La data di elaborazione non è valida.",
    );
  }
  const correlationId = randomUUID();

  return runReservationTransaction(async (client) => {
    await acquireReservationMutationLock(
      client,
      input.actor.restaurantId,
      input.reservationId,
    );
    const reservation = await readArrivalReservation(client, {
      restaurantId: input.actor.restaurantId,
      reservationId: input.reservationId,
    });
    if (!reservation) {
      throw new ReservationArrivalError(
        "NOT_FOUND",
        "Prenotazione non trovata.",
      );
    }
    const actor = await readFreshArrivalActor(client, {
      actorId: input.actor.id,
      restaurantId: input.actor.restaurantId,
    });
    if (!actor) {
      throw new ReservationArrivalError(
        "FORBIDDEN",
        "L'utente non può gestire lo stato di arrivo.",
      );
    }

    const currentlyArrived = reservation.arrivedAt !== null;
    if (currentlyArrived === parsed.data.arrived) {
      return {
        changed: false,
        reservationVersion: reservation.version,
        arrivedAt: reservation.arrivedAt?.toISOString() ?? null,
      };
    }
    if (reservation.version !== parsed.data.version) {
      throw new ReservationArrivalError(
        "VERSION_CONFLICT",
        "La prenotazione è stata aggiornata da un altro operatore.",
      );
    }

    const nextArrivedAt = parsed.data.arrived ? now : null;
    const updated = await updateReservationArrival(client, {
      restaurantId: actor.restaurantId,
      reservationId: reservation.id,
      expectedVersion: parsed.data.version,
      arrivedAt: nextArrivedAt,
      updatedAt: now,
    });
    if (!updated) {
      throw new ReservationArrivalError(
        "VERSION_CONFLICT",
        "La prenotazione è stata aggiornata da un altro operatore.",
      );
    }
    await insertReservationArrivalAudit(client, {
      actor,
      reservationId: reservation.id,
      action: parsed.data.arrived ? "ARRIVAL_RECORDED" : "ARRIVAL_REVERTED",
      correlationId,
      previousState: reservationArrivalAuditSnapshot(reservation.arrivedAt),
      newState: reservationArrivalAuditSnapshot(nextArrivedAt),
      createdAt: now,
    });

    return {
      changed: true,
      reservationVersion: updated.version,
      arrivedAt: updated.arrivedAt?.toISOString() ?? null,
    };
  });
}
