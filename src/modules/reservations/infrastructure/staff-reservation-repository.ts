import "server-only";

import { Prisma } from "@/generated/prisma/client";
import {
  localDateToDatabase,
  operationalTimeToDatabase,
} from "@/modules/configuration/domain/operational-time";
import type { StaffUpdateReservationInput } from "@/modules/reservations/domain/staff-validation";
import type {
  ReservationActor,
  StoredReservation,
} from "@/modules/reservations/domain/types";
import {
  mapReservation,
} from "@/modules/reservations/infrastructure/reservation-repository";

export async function insertAuthenticatedAuditEvent(
  client: Prisma.TransactionClient,
  input: {
    actor: ReservationActor;
    reservationId: string;
    action: "CREATED" | "UPDATED" | "CANCELLED";
    actorOrigin: "PHONE" | "STAFF";
    correlationId: string;
    previousState: Prisma.InputJsonValue | null;
    newState: Prisma.InputJsonValue;
    capacityOverride: boolean;
    capacityOverrideReason: string | null;
    createdAt: Date;
  },
): Promise<void> {
  await client.reservationAuditEvent.create({
    data: {
      restaurantId: input.actor.restaurantId,
      reservationId: input.reservationId,
      action: input.action,
      actorOrigin: input.actorOrigin,
      actorUserId: input.actor.id,
      actorRole: input.actor.role,
      correlationId: input.correlationId,
      previousState:
        input.previousState === null ? Prisma.DbNull : input.previousState,
      newState: input.newState,
      capacityOverride: input.capacityOverride,
      capacityOverrideReason: input.capacityOverrideReason,
      createdAt: input.createdAt,
    },
  });
}

export async function updateReservationForStaff(
  client: Prisma.TransactionClient,
  input: {
    reservationId: string;
    restaurantId: string;
    expectedVersion: number;
    command: StaffUpdateReservationInput;
    preferences: string;
    allergies: string;
  },
): Promise<StoredReservation | null> {
  const result = await client.reservation.updateMany({
    where: {
      id: input.reservationId,
      restaurantId: input.restaurantId,
      status: "CONFIRMED",
      version: input.expectedVersion,
    },
    data: {
      localDate: localDateToDatabase(input.command.localDate),
      serviceType: input.command.serviceType,
      arrivalTime: operationalTimeToDatabase(input.command.arrivalTime),
      partySize: input.command.partySize,
      customerFirstName: input.command.customerFirstName,
      customerLastName: input.command.customerLastName,
      customerPhone: input.command.customerPhone,
      customerEmail: input.command.customerEmail,
      notes: input.command.notes,
      preferences: input.preferences,
      allergies: input.allergies,
      capacityOverride: input.command.capacityOverride,
      capacityOverrideReason: input.command.capacityOverrideReason,
      version: { increment: 1 },
    },
  });

  if (result.count !== 1) return null;

  const updated = await client.reservation.findUnique({
    where: { id: input.reservationId },
  });

  return updated ? mapReservation(updated) : null;
}

export async function cancelReservationForStaff(
  client: Prisma.TransactionClient,
  input: {
    reservationId: string;
    restaurantId: string;
    expectedVersion: number;
    cancelledAt: Date;
  },
): Promise<StoredReservation | null> {
  const result = await client.reservation.updateMany({
    where: {
      id: input.reservationId,
      restaurantId: input.restaurantId,
      status: "CONFIRMED",
      version: input.expectedVersion,
    },
    data: {
      status: "CANCELLED",
      cancelledAt: input.cancelledAt,
      version: { increment: 1 },
    },
  });

  if (result.count !== 1) return null;

  const cancelled = await client.reservation.findUnique({
    where: { id: input.reservationId },
  });

  return cancelled ? mapReservation(cancelled) : null;
}

export async function updatePublicManagementExpiry(
  client: Prisma.TransactionClient,
  reservationId: string,
  viewExpiresAt: Date,
): Promise<boolean> {
  const result = await client.reservationManagementToken.updateMany({
    where: { reservationId },
    data: { viewExpiresAt },
  });
  return result.count === 1;
}
