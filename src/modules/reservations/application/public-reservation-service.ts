import "server-only";

import { randomUUID } from "node:crypto";

import { calculateAvailability } from "@/modules/availability/domain/availability-engine";
import type { AvailabilityReason } from "@/modules/availability/domain/types";
import { acquireOperationalConfigurationLock } from "@/modules/configuration/infrastructure/operational-configuration-repository";
import {
  PublicReservationError,
} from "@/modules/reservations/application/public-reservation-errors";
import {
  toPublicReservationDto,
  type PublicReservationDto,
} from "@/modules/reservations/domain/public-dto";
import { reservationAuditSnapshot } from "@/modules/reservations/domain/reservation-audit-snapshot";
import { hashPublicReservationRequest } from "@/modules/reservations/domain/public-idempotency";
import {
  deriveManagementToken,
  hashManagementToken,
  isManagementToken,
  managementPath,
} from "@/modules/reservations/domain/management-token";
import {
  isBeforeModificationCutoff,
  managementViewExpiry,
  originalManagementLinkDurationHours,
} from "@/modules/reservations/domain/management-time";
import {
  publicCreateReservationSchema,
  publicUpdateReservationSchema,
  parsePublicPreferences,
  serializePublicAllergies,
  serializePublicPreferences,
  type PublicCreateReservationInput,
  type PublicUpdateReservationInput,
} from "@/modules/reservations/domain/public-validation";
import {
  classifyIdempotencyRequest,
  hashIdempotencyKey,
} from "@/modules/reservations/domain/idempotency";
import type { StoredReservation } from "@/modules/reservations/domain/types";
import {
  attachReservationToIdempotencyKey,
  createIdempotencyKey,
  deleteIdempotencyKey,
  findIdempotencyKey,
  readConfirmedArrivals,
  readTransactionalAvailabilityConfiguration,
  runReservationTransaction,
} from "@/modules/reservations/infrastructure/reservation-repository";
import {
  cancelPublicReservation,
  findManagementTokenByReservationId,
  findPublicReservationAccess,
  insertManagementToken,
  insertPublicAuditEvent,
  insertPublicReservation,
  readPublicManagementSettings,
  updatePublicReservation,
  type PublicManagementSettings,
  type PublicReservationAccess,
} from "@/modules/reservations/infrastructure/public-reservation-repository";
import {
  findAvailableRoomForService,
  materializeServiceInstance,
} from "@/modules/rooms/infrastructure/service-instance-repository";
import { clearReservationAssignmentForScheduleChange } from "@/modules/rooms/application/reservation-assignment-service";
import {
  acquireCapacityLock,
  acquireCapacityLocks,
  acquireIdempotencyLock,
  acquireManagementLock,
  acquireReservationMutationLock,
} from "@/modules/reservations/infrastructure/reservation-locks";
import { idempotencyKeySchema } from "@/modules/reservations/domain/validation";
import {
  resolveReservationConfig,
  type ReservationConfig,
} from "@/shared/config/reservation-config";

export interface PublicCreateReservationResult {
  reservation: PublicReservationDto;
  managementPath: string;
  replayed: boolean;
}

function parseCreateInput(
  rawPayload: unknown,
  rawIdempotencyKey: string | null | undefined,
): { command: PublicCreateReservationInput; idempotencyKey: string } {
  const payload = publicCreateReservationSchema.safeParse(rawPayload);
  const key = idempotencyKeySchema.safeParse(rawIdempotencyKey);

  if (!payload.success || !key.success) {
    throw new PublicReservationError("VALIDATION");
  }

  return { command: payload.data, idempotencyKey: key.data };
}

function parseUpdateInput(rawPayload: unknown): PublicUpdateReservationInput {
  const payload = publicUpdateReservationSchema.safeParse(rawPayload);

  if (!payload.success) {
    throw new PublicReservationError("VALIDATION");
  }

  return payload.data;
}

function parseToken(rawToken: string): { rawToken: string; tokenHash: string } {
  if (!isManagementToken(rawToken)) {
    throw new PublicReservationError("INVALID_LINK");
  }

  return { rawToken, tokenHash: hashManagementToken(rawToken) };
}

function assertValidAccess(
  access: PublicReservationAccess | null,
  now: Date,
): asserts access is PublicReservationAccess {
  if (
    !access ||
    access.revokedAt !== null ||
    access.viewExpiresAt.getTime() <= now.getTime()
  ) {
    throw new PublicReservationError("INVALID_LINK");
  }
}

function canMutate(
  reservation: Pick<StoredReservation, "localDate" | "serviceType">,
  settings: PublicManagementSettings,
  now: Date,
): boolean {
  return isBeforeModificationCutoff({
    now,
    localDate: reservation.localDate,
    serviceType: reservation.serviceType,
    timezone: settings.timezone,
    lunchCutoff: settings.lunchModificationCutoff,
    dinnerCutoff: settings.dinnerModificationCutoff,
  });
}

function throwAvailabilityError(reason: AvailabilityReason): never {
  switch (reason) {
    case "CAPACITY_EXCEEDED":
      throw new PublicReservationError("CAPACITY_EXCEEDED");
    case "SERVICE_CLOSED":
      throw new PublicReservationError("SERVICE_CLOSED");
    case "CONFIGURATION_INVALID":
      throw new PublicReservationError("CONFIGURATION_INVALID");
    case "PARTY_SIZE_INVALID":
      throw new PublicReservationError("VALIDATION");
    case "ONLINE_CUTOFF_REACHED":
    case "SLOT_IN_PAST":
      throw new PublicReservationError("SLOT_NOT_AVAILABLE");
  }
}

function assertAvailableSlot(input: {
  command: Pick<
    PublicCreateReservationInput | PublicUpdateReservationInput,
    "localDate" | "serviceType" | "arrivalTime" | "partySize"
  >;
  now: Date;
  channel: "PUBLIC" | "STAFF";
  configuration: Parameters<typeof calculateAvailability>[0]["configuration"];
  arrivals: Parameters<typeof calculateAvailability>[0]["arrivals"];
}): void {
  const result = calculateAvailability({
    date: input.command.localDate,
    serviceType: input.command.serviceType,
    partySize: input.command.partySize,
    now: input.now,
    channel: input.channel,
    configuration: input.configuration,
    arrivals: input.arrivals,
  });

  if (!result.isOpen) {
    throwAvailabilityError(result.reason ?? "CONFIGURATION_INVALID");
  }

  const slot = result.slots.find(
    (candidate) => candidate.time === input.command.arrivalTime,
  );

  if (!slot) {
    throw new PublicReservationError("SLOT_NOT_AVAILABLE");
  }

  if (!slot.available) {
    throwAvailabilityError(slot.reason ?? "CONFIGURATION_INVALID");
  }
}

function publicResult(input: {
  reservation: StoredReservation;
  settings: PublicManagementSettings;
  viewExpiresAt: Date;
  rawToken: string;
  now: Date;
  replayed: boolean;
}): PublicCreateReservationResult {
  return {
    reservation: toPublicReservationDto({
      reservation: input.reservation,
      canMutate: canMutate(input.reservation, input.settings, input.now),
      viewExpiresAt: input.viewExpiresAt,
    }),
    managementPath: managementPath(input.rawToken),
    replayed: input.replayed,
  };
}

export async function createPublicReservation(input: {
  restaurantId: string;
  managementSecret: string;
  rawPayload: unknown;
  rawIdempotencyKey: string | null | undefined;
  now?: Date;
  config?: ReservationConfig;
}): Promise<PublicCreateReservationResult> {
  const { command, idempotencyKey } = parseCreateInput(
    input.rawPayload,
    input.rawIdempotencyKey,
  );
  const now = input.now ?? new Date();
  const config = input.config ?? resolveReservationConfig();
  const keyHash = hashIdempotencyKey(
    input.restaurantId,
    `public\u0000${idempotencyKey}`,
  );
  const requestHash = hashPublicReservationRequest(command);

  return runReservationTransaction(async (client) => {
    await acquireIdempotencyLock(client, input.restaurantId, keyHash);
    const existing = await findIdempotencyKey(client, {
      restaurantId: input.restaurantId,
      keyHash,
    });

    if (existing && existing.expiresAt.getTime() <= now.getTime()) {
      await deleteIdempotencyKey(client, existing.id);
    } else if (existing) {
      if (
        classifyIdempotencyRequest(existing.requestHash, requestHash) ===
          "CONFLICT" ||
        !existing.reservation ||
        existing.reservation.origin !== "PUBLIC"
      ) {
        throw new PublicReservationError("IDEMPOTENCY_CONFLICT");
      }

      const rawToken = deriveManagementToken(
        existing.reservation.id,
        input.managementSecret,
      );
      const token = await findManagementTokenByReservationId(
        client,
        existing.reservation.id,
      );
      const settings = await readPublicManagementSettings(
        client,
        input.restaurantId,
      );

      if (
        !token ||
        !settings ||
        token.tokenHash !== hashManagementToken(rawToken)
      ) {
        throw new PublicReservationError("CONFIGURATION_INVALID");
      }

      return publicResult({
        reservation: existing.reservation,
        settings,
        viewExpiresAt: token.viewExpiresAt,
        rawToken,
        now,
        replayed: true,
      });
    }

    const idempotencyRecordId = await createIdempotencyKey(client, {
      restaurantId: input.restaurantId,
      keyHash,
      requestHash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + config.idempotencyTtlMs),
    });

    await acquireCapacityLock(client, {
      restaurantId: input.restaurantId,
      localDate: command.localDate,
      serviceType: command.serviceType,
    });

    const configuration = await readTransactionalAvailabilityConfiguration(
      client,
      {
        restaurantId: input.restaurantId,
        localDate: command.localDate,
        serviceType: command.serviceType,
      },
    );
    const arrivals = await readConfirmedArrivals(client, {
      restaurantId: input.restaurantId,
      localDate: command.localDate,
      serviceType: command.serviceType,
    });
    const settings = await readPublicManagementSettings(
      client,
      input.restaurantId,
    );
    const room = await findAvailableRoomForService(client, {
      restaurantId: input.restaurantId,
      roomCode: command.roomCode,
      localDate: command.localDate,
      serviceType: command.serviceType,
      now,
    });

    if (!configuration || !settings) {
      throw new PublicReservationError("CONFIGURATION_INVALID");
    }
    if (!room) {
      throw new PublicReservationError("VALIDATION");
    }

    assertAvailableSlot({
      command,
      now,
      channel: "PUBLIC",
      configuration,
      arrivals,
    });

    const reservation = await insertPublicReservation(client, {
      restaurantId: input.restaurantId,
      command,
      privacyPolicyVersion: config.privacyPolicyVersion,
      termsVersion: config.termsVersion,
      consentAt: now,
    });
    await materializeServiceInstance(client, {
      restaurantId: input.restaurantId,
      localDate: command.localDate,
      serviceType: command.serviceType,
    });
    const rawToken = deriveManagementToken(
      reservation.id,
      input.managementSecret,
    );
    const viewExpiresAt = managementViewExpiry({
      localDate: reservation.localDate,
      arrivalTime: reservation.arrivalTime,
      timezone: settings.timezone,
      durationHours: settings.managementLinkDurationHours,
    });

    await insertManagementToken(client, {
      reservationId: reservation.id,
      tokenHash: hashManagementToken(rawToken),
      createdAt: now,
      viewExpiresAt,
    });
    await attachReservationToIdempotencyKey(
      client,
      idempotencyRecordId,
      reservation.id,
    );
    await insertPublicAuditEvent(client, {
      restaurantId: input.restaurantId,
      reservationId: reservation.id,
      action: "CREATED",
      correlationId: randomUUID(),
      previousState: null,
      newState: reservationAuditSnapshot(reservation),
    });

    return publicResult({
      reservation,
      settings,
      viewExpiresAt,
      rawToken,
      now,
      replayed: false,
    });
  });
}

export async function readPublicReservation(input: {
  restaurantId: string;
  rawToken: string;
  now?: Date;
}): Promise<PublicReservationDto> {
  const { tokenHash } = parseToken(input.rawToken);
  const now = input.now ?? new Date();
  const access = await findPublicReservationAccess(
    tokenHash,
    input.restaurantId,
  );
  assertValidAccess(access, now);

  return toPublicReservationDto({
    reservation: access.reservation,
    canMutate: canMutate(access.reservation, access.settings, now),
    viewExpiresAt: access.viewExpiresAt,
  });
}

export async function updateManagedPublicReservation(input: {
  restaurantId: string;
  rawToken: string;
  rawPayload: unknown;
  now?: Date;
}): Promise<PublicReservationDto> {
  const { tokenHash } = parseToken(input.rawToken);
  const command = parseUpdateInput(input.rawPayload);
  const now = input.now ?? new Date();

  return runReservationTransaction(async (client) => {
    await acquireManagementLock(client, tokenHash);
    let access = await findPublicReservationAccess(
      tokenHash,
      input.restaurantId,
      client,
    );
    assertValidAccess(access, now);
    await acquireReservationMutationLock(
      client,
      input.restaurantId,
      access.reservation.id,
    );
    await acquireOperationalConfigurationLock(client, input.restaurantId);
    access = await findPublicReservationAccess(
      tokenHash,
      input.restaurantId,
      client,
    );
    assertValidAccess(access, now);

    if (access.reservation.status === "CANCELLED") {
      throw new PublicReservationError("RESERVATION_CANCELLED");
    }
    if (!canMutate(access.reservation, access.settings, now)) {
      throw new PublicReservationError("CUTOFF_REACHED");
    }
    if (!canMutate(command, access.settings, now)) {
      throw new PublicReservationError("CUTOFF_REACHED");
    }

    const requestedPreferences = serializePublicPreferences(command);
    const requestedAllergies = serializePublicAllergies(command);
    const scheduleChanged =
      access.reservation.localDate !== command.localDate ||
      access.reservation.serviceType !== command.serviceType ||
      access.reservation.arrivalTime !== command.arrivalTime;
    const changed =
      scheduleChanged ||
      access.reservation.partySize !== command.partySize ||
      access.reservation.notes !== command.notes ||
      access.reservation.preferences !== requestedPreferences ||
      access.reservation.allergies !== requestedAllergies;
    if (!changed) {
      return toPublicReservationDto({
        reservation: access.reservation,
        canMutate: true,
        viewExpiresAt: access.viewExpiresAt,
      });
    }

    await acquireCapacityLocks(client, [
      {
        restaurantId: input.restaurantId,
        localDate: access.reservation.localDate,
        serviceType: access.reservation.serviceType,
      },
      {
        restaurantId: input.restaurantId,
        localDate: command.localDate,
        serviceType: command.serviceType,
      },
    ]);

    const configuration = await readTransactionalAvailabilityConfiguration(
      client,
      {
        restaurantId: input.restaurantId,
        localDate: command.localDate,
        serviceType: command.serviceType,
      },
    );
    const arrivals = await readConfirmedArrivals(client, {
      restaurantId: input.restaurantId,
      localDate: command.localDate,
      serviceType: command.serviceType,
      excludeReservationId: access.reservation.id,
    });
    const currentRoomCode = parsePublicPreferences(
      access.reservation.preferences,
    ).roomCode;
    const roomSelectionChanged =
      access.reservation.localDate !== command.localDate ||
      access.reservation.serviceType !== command.serviceType ||
      currentRoomCode !== command.roomCode;
    const room = roomSelectionChanged
      ? await findAvailableRoomForService(client, {
          restaurantId: input.restaurantId,
          roomCode: command.roomCode,
          localDate: command.localDate,
          serviceType: command.serviceType,
          now,
        })
      : true;

    if (!configuration) {
      throw new PublicReservationError("CONFIGURATION_INVALID");
    }
    if (!room) {
      throw new PublicReservationError("VALIDATION");
    }

    assertAvailableSlot({
      command,
      now,
      channel: "PUBLIC",
      configuration,
      arrivals,
    });

    let originalDurationHours: number;
    try {
      originalDurationHours = originalManagementLinkDurationHours({
        localDate: access.reservation.localDate,
        arrivalTime: access.reservation.arrivalTime,
        timezone: access.settings.timezone,
        viewExpiresAt: access.viewExpiresAt,
      });
    } catch {
      throw new PublicReservationError("CONFIGURATION_INVALID");
    }
    const viewExpiresAt = managementViewExpiry({
      localDate: command.localDate,
      arrivalTime: command.arrivalTime,
      timezone: access.settings.timezone,
      durationHours: originalDurationHours,
    });
    const updated = await updatePublicReservation(client, {
      reservationId: access.reservation.id,
      command,
      viewExpiresAt,
    });
    if (
      access.reservation.localDate !== command.localDate ||
      access.reservation.serviceType !== command.serviceType
    ) {
      await materializeServiceInstance(client, {
        restaurantId: input.restaurantId,
        localDate: command.localDate,
        serviceType: command.serviceType,
      });
    }
    const correlationId = randomUUID();
    await insertPublicAuditEvent(client, {
      restaurantId: input.restaurantId,
      reservationId: updated.id,
      action: "UPDATED",
      correlationId,
      previousState: reservationAuditSnapshot(access.reservation),
      newState: reservationAuditSnapshot(updated),
    });
    if (scheduleChanged) {
      await clearReservationAssignmentForScheduleChange(client, {
        restaurantId: input.restaurantId,
        reservationId: updated.id,
        actor: { origin: "PUBLIC", id: null, role: null },
        correlationId,
        now: new Date(now.getTime() + 1),
      });
    }

    return toPublicReservationDto({
      reservation: updated,
      canMutate: canMutate(updated, access.settings, now),
      viewExpiresAt,
    });
  });
}

export async function cancelManagedPublicReservation(input: {
  restaurantId: string;
  rawToken: string;
  now?: Date;
}): Promise<PublicReservationDto> {
  const { tokenHash } = parseToken(input.rawToken);
  const now = input.now ?? new Date();

  return runReservationTransaction(async (client) => {
    await acquireManagementLock(client, tokenHash);
    let access = await findPublicReservationAccess(
      tokenHash,
      input.restaurantId,
      client,
    );
    assertValidAccess(access, now);
    await acquireReservationMutationLock(
      client,
      input.restaurantId,
      access.reservation.id,
    );
    await acquireOperationalConfigurationLock(client, input.restaurantId);
    access = await findPublicReservationAccess(
      tokenHash,
      input.restaurantId,
      client,
    );
    assertValidAccess(access, now);

    if (access.reservation.status === "CANCELLED") {
      return toPublicReservationDto({
        reservation: access.reservation,
        canMutate: false,
        viewExpiresAt: access.viewExpiresAt,
      });
    }
    if (!canMutate(access.reservation, access.settings, now)) {
      throw new PublicReservationError("CUTOFF_REACHED");
    }

    await acquireCapacityLock(client, {
      restaurantId: input.restaurantId,
      localDate: access.reservation.localDate,
      serviceType: access.reservation.serviceType,
    });
    const cancelled = await cancelPublicReservation(
      client,
      access.reservation.id,
      now,
    );
    await insertPublicAuditEvent(client, {
      restaurantId: input.restaurantId,
      reservationId: cancelled.id,
      action: "CANCELLED",
      correlationId: randomUUID(),
      previousState: reservationAuditSnapshot(access.reservation),
      newState: reservationAuditSnapshot(cancelled),
    });

    return toPublicReservationDto({
      reservation: cancelled,
      canMutate: false,
      viewExpiresAt: access.viewExpiresAt,
    });
  });
}
