import "server-only";

import {
  DayOfWeek,
  type PrismaClient,
  ServiceType,
  SpecialDateScope,
} from "@/generated/prisma/client";
import type { LocalDayOfWeek } from "@/modules/availability/domain/local-calendar";
import type {
  AvailabilityConfigurationInput,
  AvailabilityServiceType,
  CapacityArrival,
  SpecialDateAvailabilityRule,
} from "@/modules/availability/domain/types";
import {
  localDateToDatabase,
  operationalTimeFromDatabase,
} from "@/modules/configuration/domain/operational-time";
import { prisma } from "@/server/db/prisma";

type AvailabilityRepositoryClient = Pick<
  PrismaClient,
  "restaurant" | "reservation"
>;

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

export async function readAvailabilityConfiguration(input: {
  restaurantId: string;
  date: string;
  dayOfWeek: LocalDayOfWeek;
  serviceType: AvailabilityServiceType;
}, client: AvailabilityRepositoryClient = prisma): Promise<AvailabilityConfigurationInput | null> {
  const serviceType = ServiceType[input.serviceType];
  const restaurant = await client.restaurant.findUnique({
    where: { id: input.restaurantId },
    select: {
      timezone: true,
      bookingSettings: {
        select: {
          rollingCapacityCovers: true,
          rollingWindowMinutes: true,
          fridayDinnerBookingCutoff: true,
          saturdayDinnerBookingCutoff: true,
        },
      },
      weeklySchedules: {
        where: {
          dayOfWeek: DayOfWeek[input.dayOfWeek],
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
      },
      specialDateOverrides: {
        where: {
          date: localDateToDatabase(input.date),
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
      },
    },
  });

  if (!restaurant) {
    return null;
  }

  const weeklyRule = restaurant.weeklySchedules[0];
  const allDateOverride = restaurant.specialDateOverrides.find(
    (override) => override.scope === SpecialDateScope.ALL,
  );
  const serviceDateOverride = restaurant.specialDateOverrides.find(
    (override) => override.scope === SpecialDateScope[input.serviceType],
  );

  return {
    timezone: restaurant.timezone,
    settings: restaurant.bookingSettings
      ? {
          rollingCapacityCovers:
            restaurant.bookingSettings.rollingCapacityCovers,
          rollingWindowMinutes:
            restaurant.bookingSettings.rollingWindowMinutes,
          fridayDinnerBookingCutoff: operationalTimeFromDatabase(
            restaurant.bookingSettings.fridayDinnerBookingCutoff,
          ),
          saturdayDinnerBookingCutoff: operationalTimeFromDatabase(
            restaurant.bookingSettings.saturdayDinnerBookingCutoff,
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

export async function readAvailabilityArrivals(
  input: {
    restaurantId: string;
    date: string;
    serviceType: AvailabilityServiceType;
  },
  client: AvailabilityRepositoryClient = prisma,
): Promise<CapacityArrival[]> {
  const reservations = await client.reservation.findMany({
    where: {
      restaurantId: input.restaurantId,
      localDate: localDateToDatabase(input.date),
      serviceType: ServiceType[input.serviceType],
      status: "CONFIRMED",
    },
    select: { arrivalTime: true, partySize: true },
  });

  return reservations.map((reservation) => ({
    arrivalTime: operationalTimeFromDatabase(reservation.arrivalTime),
    covers: reservation.partySize,
    countsTowardCapacity: true,
  }));
}
