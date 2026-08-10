import "server-only";

import {
  Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import {
  localDateToDatabase,
  operationalTimeFromDatabase,
  operationalTimeToDatabase,
} from "@/modules/configuration/domain/operational-time";
import type { StoredReservation } from "@/modules/reservations/domain/types";
import {
  serializePublicAllergies,
  serializePublicPreferences,
  type PublicCreateReservationInput,
  type PublicUpdateReservationInput,
} from "@/modules/reservations/domain/public-validation";
import { mapReservation } from "@/modules/reservations/infrastructure/reservation-repository";
import { prisma } from "@/server/db/prisma";

type PublicLookupClient = Pick<
  PrismaClient,
  | "reservationManagementToken"
  | "restaurant"
  | "restaurantBookingSettings"
  | "room"
>;

export interface PublicManagementSettings {
  timezone: string;
  lunchModificationCutoff: string;
  dinnerModificationCutoff: string;
  managementLinkDurationHours: number;
}

export interface PublicReservationAccess {
  reservation: StoredReservation;
  tokenId: string;
  tokenHash: string;
  viewExpiresAt: Date;
  revokedAt: Date | null;
  settings: PublicManagementSettings;
}

export async function readPublicManagementSettings(
  client: PublicLookupClient,
  restaurantId: string,
): Promise<PublicManagementSettings | null> {
  const restaurant = await client.restaurant.findUnique({
    where: { id: restaurantId },
    select: { timezone: true },
  });
  const settings = await client.restaurantBookingSettings.findUnique({
    where: { restaurantId },
    select: {
      lunchModificationCutoff: true,
      dinnerModificationCutoff: true,
      managementLinkDurationHours: true,
    },
  });

  if (!restaurant || !settings) {
    return null;
  }

  return {
    timezone: restaurant.timezone,
    lunchModificationCutoff: operationalTimeFromDatabase(
      settings.lunchModificationCutoff,
    ),
    dinnerModificationCutoff: operationalTimeFromDatabase(
      settings.dinnerModificationCutoff,
    ),
    managementLinkDurationHours: settings.managementLinkDurationHours,
  };
}

export async function findPublicReservationAccess(
  tokenHash: string,
  restaurantId: string,
  client: PublicLookupClient = prisma,
): Promise<PublicReservationAccess | null> {
  const token = await client.reservationManagementToken.findUnique({
    where: { tokenHash },
    include: { reservation: true },
  });

  if (
    !token ||
    token.reservation.restaurantId !== restaurantId ||
    token.reservation.origin !== "PUBLIC"
  ) {
    return null;
  }

  const settings = await readPublicManagementSettings(client, restaurantId);

  return settings
    ? {
        reservation: mapReservation(token.reservation),
        tokenId: token.id,
        tokenHash: token.tokenHash,
        viewExpiresAt: token.viewExpiresAt,
        revokedAt: token.revokedAt,
        settings,
      }
    : null;
}

export async function findManagementTokenByReservationId(
  client: Pick<PrismaClient, "reservationManagementToken">,
  reservationId: string,
) {
  return client.reservationManagementToken.findUnique({
    where: { reservationId },
  });
}

export async function findActivePublicRoom(
  client: Pick<PrismaClient, "room">,
  input: { restaurantId: string; roomCode: string },
): Promise<{ code: string; name: string } | null> {
  return client.room.findFirst({
    where: {
      restaurantId: input.restaurantId,
      code: input.roomCode,
      isActive: true,
    },
    select: { code: true, name: true },
  });
}

export async function listActivePublicRooms(
  restaurantId: string,
  client: Pick<PrismaClient, "room"> = prisma,
) {
  return client.room.findMany({
    where: { restaurantId, isActive: true },
    select: { code: true, name: true },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });
}

export async function insertPublicReservation(
  client: Prisma.TransactionClient,
  input: {
    restaurantId: string;
    command: PublicCreateReservationInput;
    privacyPolicyVersion: string;
    termsVersion: string;
    consentAt: Date;
  },
): Promise<StoredReservation> {
  const reservation = await client.reservation.create({
    data: {
      restaurantId: input.restaurantId,
      localDate: localDateToDatabase(input.command.localDate),
      serviceType: input.command.serviceType,
      arrivalTime: operationalTimeToDatabase(input.command.arrivalTime),
      partySize: input.command.partySize,
      status: "CONFIRMED",
      origin: "PUBLIC",
      customerFirstName: input.command.customerFirstName,
      customerLastName: input.command.customerLastName,
      customerPhone: input.command.customerPhone,
      customerEmail: input.command.customerEmail,
      notes: input.command.notes,
      preferences: serializePublicPreferences(input.command),
      allergies: serializePublicAllergies(input.command),
      privacyPolicyVersion: input.privacyPolicyVersion,
      privacyConsentAt: input.consentAt,
      privacyConsentMethod: "WEB_CHECKBOX",
      termsPolicyVersion: input.termsVersion,
      termsConsentAt: input.consentAt,
      termsConsentMethod: "WEB_CHECKBOX",
      consentLanguage: input.command.language,
      createdByUserId: null,
      capacityOverride: false,
      capacityOverrideReason: null,
    },
  });

  return mapReservation(reservation);
}

export async function insertManagementToken(
  client: Prisma.TransactionClient,
  input: {
    reservationId: string;
    tokenHash: string;
    createdAt: Date;
    viewExpiresAt: Date;
  },
): Promise<void> {
  await client.reservationManagementToken.create({ data: input });
}

export async function updatePublicReservation(
  client: Prisma.TransactionClient,
  input: {
    reservationId: string;
    command: PublicUpdateReservationInput;
    viewExpiresAt: Date;
  },
): Promise<StoredReservation> {
  const reservation = await client.reservation.update({
    where: { id: input.reservationId },
    data: {
      localDate: localDateToDatabase(input.command.localDate),
      serviceType: input.command.serviceType,
      arrivalTime: operationalTimeToDatabase(input.command.arrivalTime),
      partySize: input.command.partySize,
      notes: input.command.notes,
      preferences: serializePublicPreferences(input.command),
      allergies: serializePublicAllergies(input.command),
      version: { increment: 1 },
    },
  });
  await client.reservationManagementToken.update({
    where: { reservationId: input.reservationId },
    data: { viewExpiresAt: input.viewExpiresAt },
  });

  return mapReservation(reservation);
}

export async function cancelPublicReservation(
  client: Prisma.TransactionClient,
  reservationId: string,
  cancelledAt: Date,
): Promise<StoredReservation> {
  const reservation = await client.reservation.update({
    where: { id: reservationId },
    data: {
      status: "CANCELLED",
      cancelledAt,
      version: { increment: 1 },
    },
  });
  return mapReservation(reservation);
}

export async function insertPublicAuditEvent(
  client: Prisma.TransactionClient,
  input: {
    restaurantId: string;
    reservationId: string;
    action: "CREATED" | "UPDATED" | "CANCELLED";
    correlationId: string;
    previousState: Prisma.InputJsonValue | null;
    newState: Prisma.InputJsonValue;
  },
): Promise<void> {
  await client.reservationAuditEvent.create({
    data: {
      restaurantId: input.restaurantId,
      reservationId: input.reservationId,
      action: input.action,
      actorOrigin: "PUBLIC",
      correlationId: input.correlationId,
      previousState:
        input.previousState === null ? Prisma.DbNull : input.previousState,
      newState: input.newState,
    },
  });
}
