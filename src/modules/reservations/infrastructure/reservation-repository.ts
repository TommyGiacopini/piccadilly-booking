import "server-only";

import {
  DayOfWeek,
  Prisma,
  ServiceType,
  SpecialDateScope,
  type PrismaClient,
  type Reservation as PrismaReservation,
} from "@/generated/prisma/client";
import { getLocalDayOfWeek } from "@/modules/availability/domain/local-calendar";
import type {
  AvailabilityConfigurationInput,
  CapacityArrival,
  SpecialDateAvailabilityRule,
} from "@/modules/availability/domain/types";
import {
  localDateFromDatabase,
  localDateToDatabase,
  operationalTimeFromDatabase,
  operationalTimeToDatabase,
} from "@/modules/configuration/domain/operational-time";
import type {
  CreateReservationCommand,
  StoredReservation,
} from "@/modules/reservations/domain/types";
import { prisma } from "@/server/db/prisma";

type ReservationLookupClient = Pick<PrismaClient, "reservation">;
type IdempotencyCleanupClient = Pick<
  PrismaClient,
  "reservationIdempotencyKey"
>;

export interface ExistingIdempotencyKey {
  id: string;
  requestHash: string;
  reservationId: string | null;
  expiresAt: Date;
  reservation: StoredReservation | null;
}

function mapSpecialDateRule(override: {
  scope: SpecialDateScope;
  isClosed: boolean;
  specialStartTime: Date | null;
  specialEndTime: Date | null;
  specialCapacityCovers: number | null;
}): SpecialDateAvailabilityRule {
  return {
    scope: override.scope,
    isClosed: override.isClosed,
    specialStartTime: override.specialStartTime
      ? operationalTimeFromDatabase(override.specialStartTime)
      : null,
    specialEndTime: override.specialEndTime
      ? operationalTimeFromDatabase(override.specialEndTime)
      : null,
    specialCapacityCovers: override.specialCapacityCovers,
  };
}

export function mapReservation(row: PrismaReservation): StoredReservation {
  return {
    id: row.id,
    restaurantId: row.restaurantId,
    localDate: localDateFromDatabase(row.localDate),
    serviceType: row.serviceType,
    arrivalTime: operationalTimeFromDatabase(row.arrivalTime),
    partySize: row.partySize,
    status: row.status,
    origin: row.origin,
    customerFirstName: row.customerFirstName,
    customerLastName: row.customerLastName,
    customerPhone: row.customerPhone,
    customerEmail: row.customerEmail,
    notes: row.notes,
    preferences: row.preferences,
    allergies: row.allergies,
    privacyPolicyVersion: row.privacyPolicyVersion,
    privacyConsentAt: row.privacyConsentAt,
    privacyConsentMethod: row.privacyConsentMethod,
    termsPolicyVersion: row.termsPolicyVersion,
    termsConsentAt: row.termsConsentAt,
    termsConsentMethod: row.termsConsentMethod,
    consentLanguage:
      row.consentLanguage === "it" || row.consentLanguage === "en"
        ? row.consentLanguage
        : null,
    createdByUserId: row.createdByUserId,
    capacityOverride: row.capacityOverride,
    capacityOverrideReason: row.capacityOverrideReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cancelledAt: row.cancelledAt,
    version: row.version,
  };
}

export function runReservationTransaction<T>(
  operation: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(operation, {
    maxWait: 10_000,
    timeout: 15_000,
  });
}

export async function findIdempotencyKey(
  client: Prisma.TransactionClient,
  input: { restaurantId: string; keyHash: string },
): Promise<ExistingIdempotencyKey | null> {
  const row = await client.reservationIdempotencyKey.findUnique({
    where: {
      restaurantId_keyHash: input,
    },
  });

  if (!row) {
    return null;
  }

  const reservation = row.reservationId
    ? await client.reservation.findUnique({
        where: { id: row.reservationId },
      })
    : null;

  return {
    id: row.id,
    requestHash: row.requestHash,
    reservationId: row.reservationId,
    expiresAt: row.expiresAt,
    reservation: reservation ? mapReservation(reservation) : null,
  };
}

export async function deleteIdempotencyKey(
  client: Prisma.TransactionClient,
  id: string,
): Promise<void> {
  await client.reservationIdempotencyKey.delete({ where: { id } });
}

export async function createIdempotencyKey(
  client: Prisma.TransactionClient,
  input: {
    restaurantId: string;
    keyHash: string;
    requestHash: string;
    createdAt: Date;
    expiresAt: Date;
  },
): Promise<string> {
  const row = await client.reservationIdempotencyKey.create({ data: input });
  return row.id;
}

export async function attachReservationToIdempotencyKey(
  client: Prisma.TransactionClient,
  id: string,
  reservationId: string,
): Promise<void> {
  await client.reservationIdempotencyKey.update({
    where: { id },
    data: { reservationId },
  });
}

export async function readTransactionalAvailabilityConfiguration(
  client: Prisma.TransactionClient,
  input: {
    restaurantId: string;
    localDate: string;
    serviceType: "LUNCH" | "DINNER";
  },
): Promise<AvailabilityConfigurationInput | null> {
  const serviceType = ServiceType[input.serviceType];
  const restaurant = await client.restaurant.findUnique({
    where: { id: input.restaurantId },
    select: { timezone: true },
  });

  if (!restaurant) {
    return null;
  }

  const bookingSettings = await client.restaurantBookingSettings.findUnique({
    where: { restaurantId: input.restaurantId },
    select: {
      rollingCapacityCovers: true,
      rollingWindowMinutes: true,
      fridayDinnerBookingCutoff: true,
      saturdayDinnerBookingCutoff: true,
    },
  });
  const weeklyRules = await client.weeklyServiceSchedule.findMany({
    where: {
      restaurantId: input.restaurantId,
      dayOfWeek: DayOfWeek[getLocalDayOfWeek(input.localDate)],
      serviceType,
    },
    select: {
      serviceType: true,
      isEnabled: true,
      startTime: true,
      endTime: true,
      slotIntervalMinutes: true,
    },
    take: 1,
  });
  const specialDateOverrides = await client.specialDateOverride.findMany({
    where: {
      restaurantId: input.restaurantId,
      date: localDateToDatabase(input.localDate),
      scope: {
        in: [SpecialDateScope.ALL, SpecialDateScope[input.serviceType]],
      },
    },
    select: {
      scope: true,
      isClosed: true,
      specialStartTime: true,
      specialEndTime: true,
      specialCapacityCovers: true,
    },
  });
  const weeklyRule = weeklyRules[0];
  const allDateOverride = specialDateOverrides.find(
    (override) => override.scope === SpecialDateScope.ALL,
  );
  const serviceDateOverride = specialDateOverrides.find(
    (override) => override.scope === SpecialDateScope[input.serviceType],
  );

  return {
    timezone: restaurant.timezone,
    settings: bookingSettings
      ? {
          rollingCapacityCovers: bookingSettings.rollingCapacityCovers,
          rollingWindowMinutes: bookingSettings.rollingWindowMinutes,
          fridayDinnerBookingCutoff: operationalTimeFromDatabase(
            bookingSettings.fridayDinnerBookingCutoff,
          ),
          saturdayDinnerBookingCutoff: operationalTimeFromDatabase(
            bookingSettings.saturdayDinnerBookingCutoff,
          ),
        }
      : null,
    weeklyRule: weeklyRule
      ? {
          serviceType: weeklyRule.serviceType,
          isEnabled: weeklyRule.isEnabled,
          startTime: operationalTimeFromDatabase(weeklyRule.startTime),
          endTime: operationalTimeFromDatabase(weeklyRule.endTime),
          slotIntervalMinutes: weeklyRule.slotIntervalMinutes,
        }
      : null,
    allDateOverride: allDateOverride
      ? mapSpecialDateRule(allDateOverride)
      : null,
    serviceDateOverride: serviceDateOverride
      ? mapSpecialDateRule(serviceDateOverride)
      : null,
  };
}

export async function readConfirmedArrivals(
  client: Prisma.TransactionClient,
  input: {
    restaurantId: string;
    localDate: string;
    serviceType: "LUNCH" | "DINNER";
    excludeReservationId?: string;
  },
): Promise<CapacityArrival[]> {
  const rows = await client.reservation.findMany({
    where: {
      restaurantId: input.restaurantId,
      localDate: localDateToDatabase(input.localDate),
      serviceType: input.serviceType,
      status: "CONFIRMED",
      ...(input.excludeReservationId
        ? { id: { not: input.excludeReservationId } }
        : {}),
    },
    select: { arrivalTime: true, partySize: true },
  });

  return rows.map((row) => ({
    arrivalTime: operationalTimeFromDatabase(row.arrivalTime),
    covers: row.partySize,
    countsTowardCapacity: true,
  }));
}

export async function insertReservation(
  client: Prisma.TransactionClient,
  input: {
    actorId: string;
    restaurantId: string;
    command: CreateReservationCommand;
    privacyPolicyVersion: string;
    privacyConsentAt: Date;
  },
): Promise<StoredReservation> {
  const row = await client.reservation.create({
    data: {
      restaurantId: input.restaurantId,
      localDate: localDateToDatabase(input.command.localDate),
      serviceType: input.command.serviceType,
      arrivalTime: operationalTimeToDatabase(input.command.arrivalTime),
      partySize: input.command.partySize,
      status: "CONFIRMED",
      origin: input.command.origin,
      customerFirstName: input.command.customerFirstName,
      customerLastName: input.command.customerLastName,
      customerPhone: input.command.customerPhone,
      customerEmail: input.command.customerEmail,
      notes: input.command.notes,
      preferences: input.command.preferences,
      allergies: input.command.allergies,
      privacyPolicyVersion: input.privacyPolicyVersion,
      privacyConsentAt: input.privacyConsentAt,
      privacyConsentMethod: input.command.privacyConsentMethod,
      createdByUserId: input.actorId,
      capacityOverride: input.command.capacityOverride,
      capacityOverrideReason: input.command.capacityOverrideReason,
    },
  });

  return mapReservation(row);
}

export async function findReservationById(
  restaurantId: string,
  reservationId: string,
  client: ReservationLookupClient = prisma,
): Promise<StoredReservation | null> {
  const row = await client.reservation.findFirst({
    where: { id: reservationId, restaurantId },
  });

  return row ? mapReservation(row) : null;
}

export async function cleanupExpiredReservationIdempotencyKeys(
  before: Date,
  client: IdempotencyCleanupClient = prisma,
): Promise<number> {
  const result = await client.reservationIdempotencyKey.deleteMany({
    where: { expiresAt: { lte: before } },
  });

  return result.count;
}
