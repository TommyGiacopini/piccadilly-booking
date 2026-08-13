import "server-only";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { resolveEffectiveAvailabilityConfiguration } from "@/modules/availability/domain/effective-configuration";
import {
  getLocalDayOfWeek,
  getZonedDateTimeParts,
} from "@/modules/availability/domain/local-calendar";
import { readAvailabilityConfiguration } from "@/modules/availability/infrastructure/availability-repository";
import { localDateToDatabase } from "@/modules/configuration/domain/operational-time";
import { RoomAvailabilityError } from "@/modules/rooms/application/room-availability-errors";
import { acquireCapacityLock } from "@/modules/reservations/infrastructure/reservation-locks";

export type ServiceInstanceClient = Prisma.TransactionClient;
type ServiceInstanceReadClient = Pick<
  PrismaClient,
  "restaurant" | "room" | "serviceInstance" | "reservation"
>;

export interface ServiceRoomIdentity {
  restaurantId: string;
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
}

export async function readEffectiveServiceRooms(
  client: ServiceInstanceReadClient,
  input: ServiceRoomIdentity & { now: Date },
) {
  const restaurant = await client.restaurant.findUnique({
    where: { id: input.restaurantId },
    select: { timezone: true },
  });
  const configuration = await readAvailabilityConfiguration(
    {
      restaurantId: input.restaurantId,
      date: input.localDate,
      dayOfWeek: getLocalDayOfWeek(input.localDate),
      serviceType: input.serviceType,
    },
    client,
  );
  const rooms = await client.room.findMany({
    where: { restaurantId: input.restaurantId },
    select: {
      id: true,
      code: true,
      name: true,
      displayOrder: true,
      isActive: true,
      serviceAvailabilityPolicy: true,
    },
    orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
  });
  const instance = await client.serviceInstance.findUnique({
    where: {
      restaurantId_localDate_serviceType: {
        restaurantId: input.restaurantId,
        localDate: localDateToDatabase(input.localDate),
        serviceType: input.serviceType,
      },
    },
    select: {
      id: true,
      version: true,
      roomAvailabilities: {
        select: { roomId: true, isAvailable: true },
      },
    },
  });

  if (!restaurant || !configuration) {
    throw new RoomAvailabilityError(
      "NOT_FOUND",
      "La configurazione del servizio non è disponibile.",
    );
  }

  const effective = resolveEffectiveAvailabilityConfiguration(
    input.serviceType,
    configuration,
  );
  const availabilityByRoom = new Map(
    instance?.roomAvailabilities.map((row) => [row.roomId, row.isAvailable]) ??
      [],
  );

  if (
    instance &&
    (availabilityByRoom.size !== rooms.length ||
      rooms.some((room) => !availabilityByRoom.has(room.id)))
  ) {
    throw new RoomAvailabilityError(
      "INVARIANT",
      "La disponibilità delle sale per il servizio è incompleta.",
    );
  }

  const localToday = getZonedDateTimeParts(input.now, restaurant.timezone).date;
  const serviceOpen = effective.isValid && effective.isOpen;

  return {
    localDate: input.localDate,
    serviceType: input.serviceType,
    lifecycle:
      input.localDate < localToday
        ? ("HISTORICAL" as const)
        : instance
          ? ("MATERIALIZED" as const)
          : ("VIRTUAL" as const),
    instance: instance ? { id: instance.id, version: instance.version } : null,
    service: {
      source: effective.source,
      isOpen: serviceOpen,
      startTime: effective.startTime,
      endTime: effective.endTime,
      capacityLimit: effective.capacityLimit,
      rollingWindowMinutes: effective.rollingWindowMinutes,
      slotIntervalMinutes: effective.slotIntervalMinutes,
    },
    rooms: rooms.map((room) => {
      const configured = instance
        ? availabilityByRoom.get(room.id) === true
        : room.serviceAvailabilityPolicy === "DEFAULT_AVAILABLE";

      return {
        ...room,
        configuredAvailable: configured,
        isAvailable: serviceOpen && room.isActive && configured,
      };
    }),
  };
}

export async function materializeServiceInstance(
  client: ServiceInstanceClient,
  input: ServiceRoomIdentity,
) {
  await acquireCapacityLock(client, input);

  const existing = await client.serviceInstance.findUnique({
    where: {
      restaurantId_localDate_serviceType: {
        restaurantId: input.restaurantId,
        localDate: localDateToDatabase(input.localDate),
        serviceType: input.serviceType,
      },
    },
    include: { roomAvailabilities: true },
  });
  const rooms = await client.room.findMany({
    where: { restaurantId: input.restaurantId },
    select: { id: true, serviceAvailabilityPolicy: true },
    orderBy: { id: "asc" },
  });

  if (rooms.length === 0) {
    throw new RoomAvailabilityError(
      "INVARIANT",
      "Il catalogo delle sale non è inizializzato.",
    );
  }

  if (existing) {
    const expected = new Set(rooms.map((room) => room.id));
    if (
      existing.roomAvailabilities.length !== rooms.length ||
      existing.roomAvailabilities.some((row) => !expected.has(row.roomId))
    ) {
      throw new RoomAvailabilityError(
        "INVARIANT",
        "La disponibilità delle sale per il servizio è incompleta.",
      );
    }
    return { instance: existing, materialized: false };
  }

  const created = await client.serviceInstance.create({
    data: {
      restaurantId: input.restaurantId,
      localDate: localDateToDatabase(input.localDate),
      serviceType: input.serviceType,
    },
  });
  await client.serviceRoomAvailability.createMany({
    data: rooms.map((room) => ({
      restaurantId: input.restaurantId,
      serviceInstanceId: created.id,
      roomId: room.id,
      isAvailable: room.serviceAvailabilityPolicy === "DEFAULT_AVAILABLE",
    })),
  });
  const complete = await client.serviceInstance.findUniqueOrThrow({
    where: { id: created.id },
    include: { roomAvailabilities: true },
  });

  return { instance: complete, materialized: true };
}

export async function listAvailableRoomsForService(
  client: ServiceInstanceReadClient,
  input: ServiceRoomIdentity & { now: Date },
) {
  const state = await readEffectiveServiceRooms(client, input);
  return state.rooms
    .filter((room) => room.isAvailable)
    .map(({ code, name }) => ({ code, name }));
}

export async function findAvailableRoomForService(
  client: ServiceInstanceReadClient,
  input: ServiceRoomIdentity & { now: Date; roomCode: string },
) {
  const state = await readEffectiveServiceRooms(client, input);
  return (
    state.rooms.find(
      (room) => room.code === input.roomCode && room.isAvailable,
    ) ?? null
  );
}
