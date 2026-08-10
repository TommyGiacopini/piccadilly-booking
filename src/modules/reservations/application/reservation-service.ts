import "server-only";

import { calculateAvailability } from "@/modules/availability/domain/availability-engine";
import type { AvailabilityReason } from "@/modules/availability/domain/types";
import {
  classifyIdempotencyRequest,
  hashIdempotencyKey,
  hashReservationRequest,
} from "@/modules/reservations/domain/idempotency";
import {
  createReservationSchema,
  idempotencyKeySchema,
} from "@/modules/reservations/domain/validation";
import {
  toReservationDto,
  type ReservationDto,
} from "@/modules/reservations/domain/dto";
import type {
  CreateReservationCommand,
  ReservationActor,
} from "@/modules/reservations/domain/types";
import { canUseCapacityOverride } from "@/modules/reservations/domain/override";
import { ReservationApplicationError } from "@/modules/reservations/application/reservation-errors";
import {
  attachReservationToIdempotencyKey,
  createIdempotencyKey,
  deleteIdempotencyKey,
  findIdempotencyKey,
  findReservationById,
  insertReservation,
  readConfirmedArrivals,
  readTransactionalAvailabilityConfiguration,
  runReservationTransaction,
} from "@/modules/reservations/infrastructure/reservation-repository";
import {
  acquireCapacityLock,
  acquireIdempotencyLock,
} from "@/modules/reservations/infrastructure/reservation-locks";
import {
  resolveReservationConfig,
  type ReservationConfig,
} from "@/shared/config/reservation-config";

export interface CreateReservationResult {
  reservation: ReservationDto;
  replayed: boolean;
}

function validationError(message: string): ReservationApplicationError {
  return new ReservationApplicationError("VALIDATION", message);
}

function parseCreateInput(
  rawPayload: unknown,
  rawIdempotencyKey: string | null | undefined,
): { command: CreateReservationCommand; idempotencyKey: string } {
  const parsedPayload = createReservationSchema.safeParse(rawPayload);

  if (!parsedPayload.success) {
    throw validationError(
      parsedPayload.error.issues[0]?.message ?? "I dati non sono validi.",
    );
  }

  const parsedKey = idempotencyKeySchema.safeParse(rawIdempotencyKey);

  if (!parsedKey.success) {
    throw validationError(
      parsedKey.error.issues[0]?.message ??
        "L'header Idempotency-Key non è valido.",
    );
  }

  return {
    command: parsedPayload.data,
    idempotencyKey: parsedKey.data,
  };
}

function availabilityError(reason: AvailabilityReason): never {
  switch (reason) {
    case "SERVICE_CLOSED":
      throw new ReservationApplicationError(
        "SERVICE_CLOSED",
        "Il servizio selezionato è chiuso.",
      );
    case "SLOT_IN_PAST":
      throw new ReservationApplicationError(
        "SLOT_IN_PAST",
        "L'orario selezionato è già trascorso.",
      );
    case "CAPACITY_EXCEEDED":
      throw new ReservationApplicationError(
        "CAPACITY_EXCEEDED",
        "La capacità disponibile è stata superata.",
      );
    case "PARTY_SIZE_INVALID":
      throw validationError("Il numero di coperti non è valido.");
    case "CONFIGURATION_INVALID":
      throw new ReservationApplicationError(
        "CONFIGURATION_INVALID",
        "La configurazione del servizio non è coerente.",
      );
    case "ONLINE_CUTOFF_REACHED":
      throw new ReservationApplicationError(
        "SLOT_NOT_AVAILABLE",
        "Lo slot selezionato non è utilizzabile.",
      );
  }
}

export async function createReservation(input: {
  actor: ReservationActor;
  rawPayload: unknown;
  rawIdempotencyKey: string | null | undefined;
  now?: Date;
  config?: ReservationConfig;
}): Promise<CreateReservationResult> {
  const { actor } = input;
  const { command, idempotencyKey } = parseCreateInput(
    input.rawPayload,
    input.rawIdempotencyKey,
  );
  const now = input.now ?? new Date();

  if (Number.isNaN(now.getTime())) {
    throw validationError("La data di elaborazione non è valida.");
  }

  if (!canUseCapacityOverride(actor.role, command.capacityOverride)) {
    throw new ReservationApplicationError(
      "FORBIDDEN",
      "L'override della capacità è riservato a Staff e Admin.",
    );
  }

  const config = input.config ?? resolveReservationConfig();
  const keyHash = hashIdempotencyKey(actor.restaurantId, idempotencyKey);
  const requestHash = hashReservationRequest(command);

  return runReservationTransaction(async (client) => {
    await acquireIdempotencyLock(client, actor.restaurantId, keyHash);

    const existing = await findIdempotencyKey(client, {
      restaurantId: actor.restaurantId,
      keyHash,
    });

    if (existing && existing.expiresAt.getTime() <= now.getTime()) {
      await deleteIdempotencyKey(client, existing.id);
    } else if (existing) {
      if (
        classifyIdempotencyRequest(existing.requestHash, requestHash) ===
        "CONFLICT"
      ) {
        throw new ReservationApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "La chiave di idempotenza è già associata a dati differenti.",
        );
      }

      if (!existing.reservationId || !existing.reservation) {
        throw new ReservationApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "La richiesta con questa chiave non è ripetibile.",
        );
      }

      return {
        reservation: toReservationDto(existing.reservation),
        replayed: true,
      };
    }

    const idempotencyRecordId = await createIdempotencyKey(client, {
      restaurantId: actor.restaurantId,
      keyHash,
      requestHash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + config.idempotencyTtlMs),
    });

    await acquireCapacityLock(client, {
      restaurantId: actor.restaurantId,
      localDate: command.localDate,
      serviceType: command.serviceType,
    });

    const configuration = await readTransactionalAvailabilityConfiguration(
      client,
      {
        restaurantId: actor.restaurantId,
        localDate: command.localDate,
        serviceType: command.serviceType,
      },
    );

    if (!configuration) {
      throw new ReservationApplicationError(
        "CONFIGURATION_INVALID",
        "La configurazione del servizio non è disponibile.",
      );
    }

    const arrivals = await readConfirmedArrivals(client, {
      restaurantId: actor.restaurantId,
      localDate: command.localDate,
      serviceType: command.serviceType,
    });
    const availability = calculateAvailability({
      date: command.localDate,
      serviceType: command.serviceType,
      partySize: command.partySize,
      now,
      channel: "STAFF",
      arrivals,
      configuration,
    });

    if (!availability.isOpen) {
      availabilityError(availability.reason ?? "CONFIGURATION_INVALID");
    }

    const selectedSlot = availability.slots.find(
      (slot) => slot.time === command.arrivalTime,
    );

    if (!selectedSlot) {
      throw new ReservationApplicationError(
        "SLOT_NOT_AVAILABLE",
        "L'orario selezionato non appartiene agli slot configurati.",
      );
    }

    if (command.capacityOverride && selectedSlot.reason !== "CAPACITY_EXCEEDED") {
      throw new ReservationApplicationError(
        "OVERRIDE_NOT_REQUIRED",
        "L'override è consentito solo quando la capacità del turno è superata.",
      );
    }

    if (
      selectedSlot.reason &&
      !(
        selectedSlot.reason === "CAPACITY_EXCEEDED" &&
        command.capacityOverride
      )
    ) {
      availabilityError(selectedSlot.reason);
    }

    const reservation = await insertReservation(client, {
      actorId: actor.id,
      restaurantId: actor.restaurantId,
      command,
      privacyPolicyVersion: config.privacyPolicyVersion,
      privacyConsentAt: now,
    });
    await attachReservationToIdempotencyKey(
      client,
      idempotencyRecordId,
      reservation.id,
    );

    return {
      reservation: toReservationDto(reservation),
      replayed: false,
    };
  });
}

export async function getReservationById(input: {
  actor: ReservationActor;
  reservationId: string;
}): Promise<ReservationDto> {
  const reservation = await findReservationById(
    input.actor.restaurantId,
    input.reservationId,
  );

  if (!reservation) {
    throw new ReservationApplicationError(
      "NOT_FOUND",
      "Prenotazione non trovata.",
    );
  }

  return toReservationDto(reservation);
}
