import "server-only";

import type {
  BookingSettingsUpdateInput,
  DiningTableUpdateInput,
  RoomUpdateInput,
  SpecialDateInput,
  WeeklyScheduleUpdateInput,
} from "@/modules/configuration/domain/validation";
import {
  localDateFromDatabase,
  localDateToDatabase,
  operationalTimeFromDatabase,
  operationalTimeToDatabase,
} from "@/modules/configuration/domain/operational-time";
import { prisma } from "@/server/db/prisma";

export async function readOperationalConfiguration(restaurantId: string) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      name: true,
      timezone: true,
      bookingSettings: true,
      rooms: {
        include: {
          diningTables: {
            orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
          },
        },
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      },
      weeklySchedules: true,
      specialDateOverrides: {
        orderBy: [{ date: "asc" }, { scope: "asc" }],
      },
    },
  });

  if (!restaurant) {
    return null;
  }

  return {
    id: restaurant.id,
    name: restaurant.name,
    timezone: restaurant.timezone,
    settings: restaurant.bookingSettings
      ? {
          rollingCapacityCovers:
            restaurant.bookingSettings.rollingCapacityCovers,
          rollingWindowMinutes:
            restaurant.bookingSettings.rollingWindowMinutes,
          lunchModificationCutoff: operationalTimeFromDatabase(
            restaurant.bookingSettings.lunchModificationCutoff,
          ),
          dinnerModificationCutoff: operationalTimeFromDatabase(
            restaurant.bookingSettings.dinnerModificationCutoff,
          ),
          fridayDinnerBookingCutoff: operationalTimeFromDatabase(
            restaurant.bookingSettings.fridayDinnerBookingCutoff,
          ),
          saturdayDinnerBookingCutoff: operationalTimeFromDatabase(
            restaurant.bookingSettings.saturdayDinnerBookingCutoff,
          ),
          managementLinkDurationHours:
            restaurant.bookingSettings.managementLinkDurationHours,
        }
      : null,
    rooms: restaurant.rooms,
    weeklySchedules: restaurant.weeklySchedules.map((schedule) => ({
      ...schedule,
      startTime: operationalTimeFromDatabase(schedule.startTime),
      endTime: operationalTimeFromDatabase(schedule.endTime),
    })),
    specialDateOverrides: restaurant.specialDateOverrides.map((override) => ({
      ...override,
      date: localDateFromDatabase(override.date),
      specialStartTime: override.specialStartTime
        ? operationalTimeFromDatabase(override.specialStartTime)
        : null,
      specialEndTime: override.specialEndTime
        ? operationalTimeFromDatabase(override.specialEndTime)
        : null,
    })),
  };
}

export async function updateRoomForRestaurant(
  restaurantId: string,
  input: RoomUpdateInput,
): Promise<boolean> {
  const result = await prisma.room.updateMany({
    where: { id: input.id, restaurantId },
    data: {
      displayOrder: input.displayOrder,
      isActive: input.isActive,
    },
  });

  return result.count === 1;
}

export async function updateDiningTableForRestaurant(
  restaurantId: string,
  input: DiningTableUpdateInput,
): Promise<boolean> {
  const result = await prisma.diningTable.updateMany({
    where: { id: input.id, room: { restaurantId } },
    data: {
      name: input.name,
      minimumSeats: input.minimumSeats,
      maximumSeats: input.maximumSeats,
      displayOrder: input.displayOrder,
      isActive: input.isActive,
    },
  });

  return result.count === 1;
}

export async function updateWeeklyScheduleForRestaurant(
  restaurantId: string,
  input: WeeklyScheduleUpdateInput,
): Promise<"UPDATED" | "NOT_FOUND" | "WINDOW_TOO_SHORT"> {
  return prisma.$transaction(async (transaction) => {
    const settings = await transaction.restaurantBookingSettings.findUnique({
      where: { restaurantId },
      select: { rollingWindowMinutes: true },
    });

    if (!settings || settings.rollingWindowMinutes < input.slotIntervalMinutes) {
      return "WINDOW_TOO_SHORT";
    }

    const result = await transaction.weeklyServiceSchedule.updateMany({
      where: {
        id: input.id,
        restaurantId,
        dayOfWeek: input.dayOfWeek,
        serviceType: input.serviceType,
      },
      data: {
        isEnabled: input.isEnabled,
        startTime: operationalTimeToDatabase(input.startTime),
        endTime: operationalTimeToDatabase(input.endTime),
        slotIntervalMinutes: input.slotIntervalMinutes,
      },
    });

    return result.count === 1 ? "UPDATED" : "NOT_FOUND";
  });
}

export async function updateBookingSettingsForRestaurant(
  restaurantId: string,
  input: BookingSettingsUpdateInput,
): Promise<"UPDATED" | "NOT_FOUND" | "WINDOW_TOO_SHORT"> {
  return prisma.$transaction(async (transaction) => {
    const largestSlot = await transaction.weeklyServiceSchedule.aggregate({
      where: { restaurantId },
      _max: { slotIntervalMinutes: true },
    });

    if (
      input.rollingWindowMinutes <
      (largestSlot._max.slotIntervalMinutes ?? 0)
    ) {
      return "WINDOW_TOO_SHORT";
    }

    const result = await transaction.restaurantBookingSettings.updateMany({
      where: { restaurantId },
      data: {
        rollingCapacityCovers: input.rollingCapacityCovers,
        rollingWindowMinutes: input.rollingWindowMinutes,
        lunchModificationCutoff: operationalTimeToDatabase(
          input.lunchModificationCutoff,
        ),
        dinnerModificationCutoff: operationalTimeToDatabase(
          input.dinnerModificationCutoff,
        ),
        fridayDinnerBookingCutoff: operationalTimeToDatabase(
          input.fridayDinnerBookingCutoff,
        ),
        saturdayDinnerBookingCutoff: operationalTimeToDatabase(
          input.saturdayDinnerBookingCutoff,
        ),
        managementLinkDurationHours: input.managementLinkDurationHours,
      },
    });

    return result.count === 1 ? "UPDATED" : "NOT_FOUND";
  });
}

function specialDateData(input: SpecialDateInput) {
  return {
    date: localDateToDatabase(input.date),
    scope: input.scope,
    isClosed: input.isClosed,
    specialStartTime: input.specialStartTime
      ? operationalTimeToDatabase(input.specialStartTime)
      : null,
    specialEndTime: input.specialEndTime
      ? operationalTimeToDatabase(input.specialEndTime)
      : null,
    specialCapacityCovers: input.specialCapacityCovers,
    operationalNotes: input.operationalNotes,
  };
}

export async function createSpecialDateForRestaurant(
  restaurantId: string,
  input: SpecialDateInput,
) {
  return prisma.specialDateOverride.create({
    data: {
      restaurantId,
      ...specialDateData(input),
    },
  });
}

export async function updateSpecialDateForRestaurant(
  restaurantId: string,
  input: SpecialDateInput & { id: string },
): Promise<boolean> {
  const result = await prisma.specialDateOverride.updateMany({
    where: { id: input.id, restaurantId },
    data: specialDateData(input),
  });

  return result.count === 1;
}

export async function deleteSpecialDateForRestaurant(
  restaurantId: string,
  id: string,
): Promise<boolean> {
  const result = await prisma.specialDateOverride.deleteMany({
    where: { id, restaurantId },
  });

  return result.count === 1;
}
