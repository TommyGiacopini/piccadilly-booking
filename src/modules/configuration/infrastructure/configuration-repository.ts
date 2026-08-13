import "server-only";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
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

export type ConfigurationClient = Pick<
  PrismaClient,
  | "restaurant"
  | "restaurantBookingSettings"
  | "room"
  | "diningTable"
  | "weeklyServiceSchedule"
  | "bookingCutoffRule"
  | "specialDateOverride"
  | "auditEvent"
>;

export function runConfigurationTransaction<T>(
  callback: (client: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(callback);
}

export async function readOperationalConfigurationForRestaurant(
  restaurantId: string,
  client: ConfigurationClient = prisma,
) {
  const restaurant = await client.restaurant.findUnique({
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
      bookingCutoffRules: true,
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
    bookingCutoffRules: restaurant.bookingCutoffRules.map((rule) => ({
      ...rule,
      cutoffTime: operationalTimeFromDatabase(rule.cutoffTime),
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

export async function readBookingSettingsForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
) {
  return client.restaurantBookingSettings.findUnique({
    where: { restaurantId },
  });
}

export async function largestSlotIntervalForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
): Promise<number> {
  const result = await client.weeklyServiceSchedule.aggregate({
    where: { restaurantId },
    _max: { slotIntervalMinutes: true },
  });
  return result._max.slotIntervalMinutes ?? 0;
}

export async function writeBookingSettingsForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
  input: BookingSettingsUpdateInput,
): Promise<boolean> {
  const result = await client.restaurantBookingSettings.updateMany({
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
      managementLinkDurationHours: input.managementLinkDurationHours,
    },
  });
  return result.count === 1;
}

export async function readRoomForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
  id: string,
) {
  return client.room.findFirst({ where: { id, restaurantId } });
}

export async function writeRoomForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
  input: RoomUpdateInput,
): Promise<boolean> {
  const result = await client.room.updateMany({
    where: { id: input.id, restaurantId },
    data: {
      displayOrder: input.displayOrder,
      isActive: input.isActive,
    },
  });
  return result.count === 1;
}

export async function readDiningTableForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
  id: string,
) {
  return client.diningTable.findFirst({
    where: { id, room: { restaurantId } },
  });
}

export async function writeDiningTableForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
  input: DiningTableUpdateInput,
): Promise<boolean> {
  const result = await client.diningTable.updateMany({
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

export async function readWeeklyScheduleForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
  input: Pick<WeeklyScheduleUpdateInput, "id" | "dayOfWeek" | "serviceType">,
) {
  return client.weeklyServiceSchedule.findFirst({
    where: {
      id: input.id,
      restaurantId,
      dayOfWeek: input.dayOfWeek,
      serviceType: input.serviceType,
    },
  });
}

export async function writeWeeklyScheduleForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
  input: WeeklyScheduleUpdateInput,
): Promise<boolean> {
  const result = await client.weeklyServiceSchedule.updateMany({
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
  return result.count === 1;
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

export async function readSpecialDateByIdentity(
  client: ConfigurationClient,
  restaurantId: string,
  input: Pick<SpecialDateInput, "date" | "scope">,
) {
  return client.specialDateOverride.findUnique({
    where: {
      restaurantId_date_scope: {
        restaurantId,
        date: localDateToDatabase(input.date),
        scope: input.scope,
      },
    },
  });
}

export async function readSpecialDateForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
  id: string,
) {
  return client.specialDateOverride.findFirst({
    where: { id, restaurantId },
  });
}

export async function createSpecialDateForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
  input: SpecialDateInput,
) {
  return client.specialDateOverride.create({
    data: { restaurantId, ...specialDateData(input) },
  });
}

export async function writeSpecialDateForRestaurant(
  client: ConfigurationClient,
  restaurantId: string,
  input: SpecialDateInput & { id: string },
  archivedAt?: Date | null,
): Promise<boolean> {
  const result = await client.specialDateOverride.updateMany({
    where: { id: input.id, restaurantId },
    data: {
      ...specialDateData(input),
      ...(archivedAt === undefined ? {} : { archivedAt }),
    },
  });
  return result.count === 1;
}

export async function setSpecialDateArchivedState(
  client: ConfigurationClient,
  restaurantId: string,
  id: string,
  archivedAt: Date | null,
): Promise<boolean> {
  const result = await client.specialDateOverride.updateMany({
    where: { id, restaurantId },
    data: { archivedAt },
  });
  return result.count === 1;
}
