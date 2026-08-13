import "server-only";

import { randomUUID } from "node:crypto";

import { calculateAvailability } from "@/modules/availability/domain/availability-engine";
import type { AvailabilityReason } from "@/modules/availability/domain/types";
import { operationalTimeToMinutes } from "@/modules/configuration/domain/operational-time";
import {
  managementViewExpiry,
  originalManagementLinkDurationHours,
} from "@/modules/reservations/domain/management-time";
import {
  classifyIdempotencyRequest,
  hashIdempotencyKey,
  hashReservationRequest,
} from "@/modules/reservations/domain/idempotency";
import {
  parsePublicPreferences,
  serializePublicAllergies,
  serializePublicPreferences,
} from "@/modules/reservations/domain/public-validation";
import {
  toStaffReservationDto,
  type StaffReservationDto,
} from "@/modules/reservations/domain/staff-dto";
import { reservationAuditSnapshot } from "@/modules/reservations/domain/reservation-audit-snapshot";
import {
  phoneReservationSchema,
  staffCancelReservationSchema,
  staffUpdateReservationSchema,
  type PhoneReservationInput,
  type StaffUpdateReservationInput,
} from "@/modules/reservations/domain/staff-validation";
import type {
  CreateReservationCommand,
  ReservationActor,
} from "@/modules/reservations/domain/types";
import { idempotencyKeySchema } from "@/modules/reservations/domain/validation";
import { ReservationApplicationError } from "@/modules/reservations/application/reservation-errors";
import {
  findManagementTokenByReservationId,
  readPublicManagementSettings,
} from "@/modules/reservations/infrastructure/public-reservation-repository";
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
  acquireCapacityLocks,
  acquireIdempotencyLock,
  acquireReservationMutationLock,
} from "@/modules/reservations/infrastructure/reservation-locks";
import {
  cancelReservationForStaff,
  insertAuthenticatedAuditEvent,
  updatePublicManagementExpiry,
  updateReservationForStaff,
} from "@/modules/reservations/infrastructure/staff-reservation-repository";
import {
  findAvailableRoomForService,
  materializeServiceInstance,
} from "@/modules/rooms/infrastructure/service-instance-repository";
import {
  resolveReservationConfig,
  type ReservationConfig,
} from "@/shared/config/reservation-config";

export interface StaffReservationMutationResult {
  reservation: StaffReservationDto;
  changed: boolean;
}

export interface PhoneReservationResult {
  reservation: StaffReservationDto;
  replayed: boolean;
}

interface CapacityOverrideAuditResult extends Record<string, number> {
  capacityLimit: number;
  totalBefore: number;
  totalAfter: number;
}

function validationError(message: string): ReservationApplicationError {
  return new ReservationApplicationError("VALIDATION", message);
}

function parsePhoneInput(
  rawPayload: unknown,
  rawIdempotencyKey: string | null | undefined,
): { command: PhoneReservationInput; idempotencyKey: string } {
  const payload = phoneReservationSchema.safeParse(rawPayload);
  const key = idempotencyKeySchema.safeParse(rawIdempotencyKey);

  if (!payload.success) {
    throw validationError(
      payload.error.issues[0]?.message ?? "I dati non sono validi.",
    );
  }

  if (!key.success) {
    throw validationError(
      key.error.issues[0]?.message ??
        "L'header Idempotency-Key non è valido.",
    );
  }

  return { command: payload.data, idempotencyKey: key.data };
}

function parseUpdateInput(rawPayload: unknown): StaffUpdateReservationInput {
  const parsed = staffUpdateReservationSchema.safeParse(rawPayload);

  if (!parsed.success) {
    throw validationError(
      parsed.error.issues[0]?.message ?? "I dati non sono validi.",
    );
  }

  return parsed.data;
}

function parseCancelInput(rawPayload: unknown): { version: number } {
  const parsed = staffCancelReservationSchema.safeParse(rawPayload);

  if (!parsed.success) {
    throw validationError("La versione della prenotazione non è valida.");
  }

  return parsed.data;
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
      throw validationError("Il numero di persone non è valido.");
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

function assertStaffSlot(input: {
  command: Pick<
    PhoneReservationInput | StaffUpdateReservationInput,
    "localDate" | "serviceType" | "arrivalTime" | "partySize" | "capacityOverride"
  >;
  now: Date;
  configuration: Parameters<typeof calculateAvailability>[0]["configuration"];
  arrivals: Parameters<typeof calculateAvailability>[0]["arrivals"];
}): CapacityOverrideAuditResult | null {
  const availability = calculateAvailability({
    date: input.command.localDate,
    serviceType: input.command.serviceType,
    partySize: input.command.partySize,
    now: input.now,
    channel: "STAFF",
    configuration: input.configuration,
    arrivals: input.arrivals,
  });

  if (!availability.isOpen) {
    availabilityError(availability.reason ?? "CONFIGURATION_INVALID");
  }

  const slot = availability.slots.find(
    (candidate) => candidate.time === input.command.arrivalTime,
  );

  if (!slot) {
    throw new ReservationApplicationError(
      "SLOT_NOT_AVAILABLE",
      "L'orario selezionato non appartiene agli slot configurati.",
    );
  }

  if (slot.reason === "CAPACITY_EXCEEDED") {
    if (!input.command.capacityOverride) availabilityError(slot.reason);

    if (
      availability.capacityLimit === null ||
      availability.rollingWindowMinutes === null
    ) {
      availabilityError("CONFIGURATION_INVALID");
    }

    const candidateMinutes = operationalTimeToMinutes(
      input.command.arrivalTime,
    );
    const affectedWindowStarts = availability.slots
      .map((candidate) => operationalTimeToMinutes(candidate.time))
      .filter(
        (windowStart) =>
          candidateMinutes >= windowStart &&
          candidateMinutes <
            windowStart + availability.rollingWindowMinutes!,
      );
    if (affectedWindowStarts.length === 0) {
      availabilityError("CONFIGURATION_INVALID");
    }
    const totalBefore = Math.max(
      ...affectedWindowStarts.map((windowStart) =>
        input.arrivals
          .filter(
            (arrival) =>
              arrival.countsTowardCapacity &&
              operationalTimeToMinutes(arrival.arrivalTime) >= windowStart &&
              operationalTimeToMinutes(arrival.arrivalTime) <
                windowStart + availability.rollingWindowMinutes!,
          )
          .reduce((total, arrival) => total + arrival.covers, 0),
      ),
    );

    return {
      capacityLimit: availability.capacityLimit,
      totalBefore,
      totalAfter: totalBefore + input.command.partySize,
    };
  }

  if (slot.reason) availabilityError(slot.reason);

  if (input.command.capacityOverride) {
    throw new ReservationApplicationError(
      "OVERRIDE_NOT_REQUIRED",
      "L'override è utilizzabile soltanto quando la capacità è superata.",
    );
  }

  return null;
}

function staffAuditState(
  reservation: Parameters<typeof reservationAuditSnapshot>[0],
  overrideResult: CapacityOverrideAuditResult | null,
) {
  const snapshot = reservationAuditSnapshot(reservation);

  return overrideResult
    ? { ...snapshot, capacityOverrideResult: overrideResult }
    : snapshot;
}

function isSameStaffReservationState(input: {
  current: Parameters<typeof reservationAuditSnapshot>[0];
  command: StaffUpdateReservationInput;
  preferences: string;
  allergies: string;
}): boolean {
  return (
    input.current.localDate === input.command.localDate &&
    input.current.serviceType === input.command.serviceType &&
    input.current.arrivalTime === input.command.arrivalTime &&
    input.current.partySize === input.command.partySize &&
    input.current.customerFirstName === input.command.customerFirstName &&
    input.current.customerLastName === input.command.customerLastName &&
    input.current.customerPhone === input.command.customerPhone &&
    input.current.customerEmail === input.command.customerEmail &&
    input.current.notes === input.command.notes &&
    input.current.preferences === input.preferences &&
    input.current.allergies === input.allergies &&
    input.current.capacityOverride === input.command.capacityOverride &&
    input.current.capacityOverrideReason ===
      input.command.capacityOverrideReason
  );
}

function phoneCreateCommand(input: PhoneReservationInput): CreateReservationCommand {
  return {
    localDate: input.localDate,
    serviceType: input.serviceType,
    arrivalTime: input.arrivalTime,
    partySize: input.partySize,
    origin: "PHONE",
    customerFirstName: input.customerFirstName,
    customerLastName: input.customerLastName,
    customerPhone: input.customerPhone,
    customerEmail: input.customerEmail,
    notes: input.notes,
    preferences: serializePublicPreferences(input),
    allergies: serializePublicAllergies(input),
    privacyConsentMethod: "VERBAL",
    capacityOverride: input.capacityOverride,
    capacityOverrideReason: input.capacityOverrideReason,
  };
}

export async function createPhoneReservation(input: {
  actor: ReservationActor;
  rawPayload: unknown;
  rawIdempotencyKey: string | null | undefined;
  now?: Date;
  config?: ReservationConfig;
}): Promise<PhoneReservationResult> {
  const parsed = parsePhoneInput(input.rawPayload, input.rawIdempotencyKey);
  const now = input.now ?? new Date();

  if (Number.isNaN(now.getTime())) {
    throw validationError("La data di elaborazione non è valida.");
  }

  const command = phoneCreateCommand(parsed.command);
  const config = input.config ?? resolveReservationConfig();
  const keyHash = hashIdempotencyKey(
    input.actor.restaurantId,
    `phone\u0000${parsed.idempotencyKey}`,
  );
  const requestHash = hashReservationRequest(command);

  return runReservationTransaction(async (client) => {
    await acquireIdempotencyLock(client, input.actor.restaurantId, keyHash);
    const existing = await findIdempotencyKey(client, {
      restaurantId: input.actor.restaurantId,
      keyHash,
    });

    if (existing && existing.expiresAt.getTime() <= now.getTime()) {
      await deleteIdempotencyKey(client, existing.id);
    } else if (existing) {
      if (
        classifyIdempotencyRequest(existing.requestHash, requestHash) ===
          "CONFLICT" ||
        !existing.reservation ||
        existing.reservation.origin !== "PHONE"
      ) {
        throw new ReservationApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "La chiave di idempotenza è già associata a dati differenti.",
        );
      }

      return {
        reservation: toStaffReservationDto(existing.reservation),
        replayed: true,
      };
    }

    const idempotencyRecordId = await createIdempotencyKey(client, {
      restaurantId: input.actor.restaurantId,
      keyHash,
      requestHash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + config.idempotencyTtlMs),
    });

    await acquireCapacityLock(client, {
      restaurantId: input.actor.restaurantId,
      localDate: command.localDate,
      serviceType: command.serviceType,
    });

    const configuration = await readTransactionalAvailabilityConfiguration(
      client,
      {
        restaurantId: input.actor.restaurantId,
        localDate: command.localDate,
        serviceType: command.serviceType,
      },
    );
    const arrivals = await readConfirmedArrivals(client, {
      restaurantId: input.actor.restaurantId,
      localDate: command.localDate,
      serviceType: command.serviceType,
    });
    const room = await findAvailableRoomForService(client, {
      restaurantId: input.actor.restaurantId,
      roomCode: parsed.command.roomCode,
      localDate: command.localDate,
      serviceType: command.serviceType,
      now,
    });

    if (!configuration) {
      throw new ReservationApplicationError(
        "CONFIGURATION_INVALID",
        "La configurazione del servizio non è disponibile.",
      );
    }

    if (!room) {
      throw validationError("La sala preferita non è disponibile.");
    }

    const overrideResult = assertStaffSlot({
      command: parsed.command,
      now,
      configuration,
      arrivals,
    });

    const reservation = await insertReservation(client, {
      actorId: input.actor.id,
      restaurantId: input.actor.restaurantId,
      command,
      privacyPolicyVersion: config.privacyPolicyVersion,
      privacyConsentAt: now,
    });
    await materializeServiceInstance(client, {
      restaurantId: input.actor.restaurantId,
      localDate: command.localDate,
      serviceType: command.serviceType,
    });
    await attachReservationToIdempotencyKey(
      client,
      idempotencyRecordId,
      reservation.id,
    );
    await insertAuthenticatedAuditEvent(client, {
      actor: input.actor,
      reservationId: reservation.id,
      action: "CREATED",
      actorOrigin: "PHONE",
      correlationId: randomUUID(),
      previousState: null,
      newState: staffAuditState(reservation, overrideResult),
      capacityOverride: command.capacityOverride,
      capacityOverrideReason: command.capacityOverrideReason,
      createdAt: now,
    });

    return {
      reservation: toStaffReservationDto(reservation),
      replayed: false,
    };
  });
}

export async function getStaffReservation(input: {
  actor: ReservationActor;
  reservationId: string;
}): Promise<StaffReservationDto> {
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

  return toStaffReservationDto(reservation);
}

export async function updateStaffReservation(input: {
  actor: ReservationActor;
  reservationId: string;
  rawPayload: unknown;
  now?: Date;
}): Promise<StaffReservationMutationResult> {
  const command = parseUpdateInput(input.rawPayload);
  const now = input.now ?? new Date();

  if (Number.isNaN(now.getTime())) {
    throw validationError("La data di elaborazione non è valida.");
  }

  return runReservationTransaction(async (client) => {
    await acquireReservationMutationLock(
      client,
      input.actor.restaurantId,
      input.reservationId,
    );
    const current = await findReservationById(
      input.actor.restaurantId,
      input.reservationId,
      client,
    );

    if (!current) {
      throw new ReservationApplicationError(
        "NOT_FOUND",
        "Prenotazione non trovata.",
      );
    }
    if (current.status === "CANCELLED") {
      throw new ReservationApplicationError(
        "RESERVATION_CANCELLED",
        "Una prenotazione cancellata non può essere modificata.",
      );
    }
    if (current.version !== command.version) {
      throw new ReservationApplicationError(
        "VERSION_CONFLICT",
        "La prenotazione è stata modificata da un altro utente. Ricarica i dati.",
      );
    }

    await acquireCapacityLocks(client, [
      {
        restaurantId: input.actor.restaurantId,
        localDate: current.localDate,
        serviceType: current.serviceType,
      },
      {
        restaurantId: input.actor.restaurantId,
        localDate: command.localDate,
        serviceType: command.serviceType,
      },
    ]);

    const capacityChanged =
      current.localDate !== command.localDate ||
      current.serviceType !== command.serviceType ||
      current.arrivalTime !== command.arrivalTime ||
      current.partySize !== command.partySize;

    const configuration = capacityChanged
      ? await readTransactionalAvailabilityConfiguration(client, {
          restaurantId: input.actor.restaurantId,
          localDate: command.localDate,
          serviceType: command.serviceType,
        })
      : null;
    const arrivals = capacityChanged
      ? await readConfirmedArrivals(client, {
          restaurantId: input.actor.restaurantId,
          localDate: command.localDate,
          serviceType: command.serviceType,
          excludeReservationId: current.id,
        })
      : [];
    const currentRoomCode = parsePublicPreferences(current.preferences).roomCode;
    const roomSelectionChanged =
      current.localDate !== command.localDate ||
      current.serviceType !== command.serviceType ||
      currentRoomCode !== command.roomCode;
    const room = roomSelectionChanged
      ? await findAvailableRoomForService(client, {
          restaurantId: input.actor.restaurantId,
          roomCode: command.roomCode,
          localDate: command.localDate,
          serviceType: command.serviceType,
          now,
        })
      : true;

    if (capacityChanged && !configuration) {
      throw new ReservationApplicationError(
        "CONFIGURATION_INVALID",
        "La configurazione del servizio non è disponibile.",
      );
    }
    if (!room) {
      throw validationError("La sala preferita non è disponibile.");
    }

    let overrideResult: CapacityOverrideAuditResult | null = null;

    if (capacityChanged && configuration) {
      overrideResult = assertStaffSlot({ command, now, configuration, arrivals });
    } else if (command.capacityOverride) {
      throw new ReservationApplicationError(
        "OVERRIDE_NOT_REQUIRED",
        "L'override è utilizzabile soltanto per una modifica che supera la capacità.",
      );
    }

    const preferences = serializePublicPreferences(command);
    const allergies = serializePublicAllergies(command);
    const effectiveCommand: StaffUpdateReservationInput = capacityChanged
      ? command
      : {
          ...command,
          capacityOverride: current.capacityOverride,
          capacityOverrideReason: current.capacityOverrideReason,
        };

    if (
      isSameStaffReservationState({
        current,
        command: effectiveCommand,
        preferences,
        allergies,
      })
    ) {
      return { reservation: toStaffReservationDto(current), changed: false };
    }

    const publicScheduleChanged =
      current.origin === "PUBLIC" &&
      (current.localDate !== command.localDate ||
        current.serviceType !== command.serviceType ||
        current.arrivalTime !== command.arrivalTime);
    let publicLinkContext:
      | { timezone: string; originalDurationHours: number }
      | null = null;

    if (publicScheduleChanged) {
      const [settings, token] = await Promise.all([
        readPublicManagementSettings(client, input.actor.restaurantId),
        findManagementTokenByReservationId(client, current.id),
      ]);
      if (!settings || !token) {
        throw new ReservationApplicationError(
          "CONFIGURATION_INVALID",
          "Il link personale della prenotazione non è disponibile.",
        );
      }
      try {
        publicLinkContext = {
          timezone: settings.timezone,
          originalDurationHours: originalManagementLinkDurationHours({
            localDate: current.localDate,
            arrivalTime: current.arrivalTime,
            timezone: settings.timezone,
            viewExpiresAt: token.viewExpiresAt,
          }),
        };
      } catch {
        throw new ReservationApplicationError(
          "CONFIGURATION_INVALID",
          "La durata originaria del link personale non è coerente.",
        );
      }
    }

    const updated = await updateReservationForStaff(client, {
      reservationId: current.id,
      restaurantId: input.actor.restaurantId,
      expectedVersion: command.version,
      command: effectiveCommand,
      preferences,
      allergies,
    });

    if (!updated) {
      throw new ReservationApplicationError(
        "VERSION_CONFLICT",
        "La prenotazione è stata modificata da un altro utente. Ricarica i dati.",
      );
    }

    if (
      current.localDate !== command.localDate ||
      current.serviceType !== command.serviceType
    ) {
      await materializeServiceInstance(client, {
        restaurantId: input.actor.restaurantId,
        localDate: command.localDate,
        serviceType: command.serviceType,
      });
    }

    if (publicLinkContext) {
      const expiry = managementViewExpiry({
        localDate: updated.localDate,
        arrivalTime: updated.arrivalTime,
        timezone: publicLinkContext.timezone,
        durationHours: publicLinkContext.originalDurationHours,
      });
      const tokenUpdated = await updatePublicManagementExpiry(
        client,
        updated.id,
        expiry,
      );

      if (!tokenUpdated) {
        throw new ReservationApplicationError(
          "CONFIGURATION_INVALID",
          "Il link personale della prenotazione non è disponibile.",
        );
      }
    }

    await insertAuthenticatedAuditEvent(client, {
      actor: input.actor,
      reservationId: updated.id,
      action: "UPDATED",
      actorOrigin: "STAFF",
      correlationId: randomUUID(),
      previousState: reservationAuditSnapshot(current),
      newState: staffAuditState(updated, overrideResult),
      capacityOverride: overrideResult !== null,
      capacityOverrideReason: overrideResult
        ? command.capacityOverrideReason
        : null,
      createdAt: now,
    });

    return { reservation: toStaffReservationDto(updated), changed: true };
  });
}

export async function cancelStaffReservation(input: {
  actor: ReservationActor;
  reservationId: string;
  rawPayload: unknown;
  now?: Date;
}): Promise<StaffReservationMutationResult> {
  const command = parseCancelInput(input.rawPayload);
  const now = input.now ?? new Date();

  if (Number.isNaN(now.getTime())) {
    throw validationError("La data di elaborazione non è valida.");
  }

  return runReservationTransaction(async (client) => {
    await acquireReservationMutationLock(
      client,
      input.actor.restaurantId,
      input.reservationId,
    );
    const current = await findReservationById(
      input.actor.restaurantId,
      input.reservationId,
      client,
    );

    if (!current) {
      throw new ReservationApplicationError(
        "NOT_FOUND",
        "Prenotazione non trovata.",
      );
    }
    if (current.status === "CANCELLED") {
      return { reservation: toStaffReservationDto(current), changed: false };
    }
    if (current.version !== command.version) {
      throw new ReservationApplicationError(
        "VERSION_CONFLICT",
        "La prenotazione è stata modificata da un altro utente. Ricarica i dati.",
      );
    }

    await acquireCapacityLock(client, {
      restaurantId: input.actor.restaurantId,
      localDate: current.localDate,
      serviceType: current.serviceType,
    });
    const cancelled = await cancelReservationForStaff(client, {
      reservationId: current.id,
      restaurantId: input.actor.restaurantId,
      expectedVersion: command.version,
      cancelledAt: now,
    });

    if (!cancelled) {
      throw new ReservationApplicationError(
        "VERSION_CONFLICT",
        "La prenotazione è stata modificata da un altro utente. Ricarica i dati.",
      );
    }

    await insertAuthenticatedAuditEvent(client, {
      actor: input.actor,
      reservationId: cancelled.id,
      action: "CANCELLED",
      actorOrigin: "STAFF",
      correlationId: randomUUID(),
      previousState: reservationAuditSnapshot(current),
      newState: reservationAuditSnapshot(cancelled),
      capacityOverride: false,
      capacityOverrideReason: null,
      createdAt: now,
    });

    return { reservation: toStaffReservationDto(cancelled), changed: true };
  });
}
