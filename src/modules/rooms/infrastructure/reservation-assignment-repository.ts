import "server-only";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  localDateFromDatabase,
  operationalTimeFromDatabase,
} from "@/modules/configuration/domain/operational-time";
import type { PutReservationAssignmentInput } from "@/modules/rooms/domain/reservation-assignment";
import { prisma } from "@/server/db/prisma";

export type ReservationAssignmentTransactionClient = Prisma.TransactionClient;
export type ReservationAssignmentReadClient = Pick<
  PrismaClient,
  | "user"
  | "restaurant"
  | "reservation"
  | "reservationAssignment"
  | "reservationAssignmentTable"
  | "room"
  | "serviceInstance"
  | "weeklyServiceSchedule"
  | "restaurantBookingSettings"
  | "bookingCutoffRule"
  | "specialDateOverride"
>;

export interface FreshAssignmentActor {
  id: string;
  restaurantId: string;
  role: "ADMIN" | "STAFF";
}

export async function readFreshAssignmentActor(
  client: ReservationAssignmentReadClient,
  input: { actorId: string; restaurantId: string },
): Promise<FreshAssignmentActor | null> {
  const actor = await client.user.findFirst({
    where: { id: input.actorId, restaurantId: input.restaurantId },
    select: {
      id: true,
      restaurantId: true,
      role: true,
      isActive: true,
      disabledAt: true,
      mustChangePassword: true,
    },
  });

  if (
    !actor ||
    !actor.isActive ||
    actor.disabledAt !== null ||
    actor.mustChangePassword ||
    (actor.role !== "ADMIN" && actor.role !== "STAFF")
  ) {
    return null;
  }

  return {
    id: actor.id,
    restaurantId: actor.restaurantId,
    role: actor.role,
  };
}

export async function readAssignmentReservationIdentity(
  client: Pick<PrismaClient, "reservation">,
  input: { restaurantId: string; reservationId: string },
) {
  const reservation = await client.reservation.findFirst({
    where: {
      id: input.reservationId,
      restaurantId: input.restaurantId,
    },
    select: { localDate: true, serviceType: true },
  });

  return reservation
    ? {
        localDate: localDateFromDatabase(reservation.localDate),
        serviceType: reservation.serviceType,
      }
    : null;
}

export async function readAssignmentReservation(
  client: Pick<PrismaClient, "reservation">,
  input: { restaurantId: string; reservationId: string },
) {
  const reservation = await client.reservation.findFirst({
    where: {
      id: input.reservationId,
      restaurantId: input.restaurantId,
    },
    select: {
      id: true,
      restaurantId: true,
      localDate: true,
      serviceType: true,
      arrivalTime: true,
      status: true,
      preferences: true,
      version: true,
      updatedAt: true,
    },
  });

  return reservation
    ? {
        ...reservation,
        localDate: localDateFromDatabase(reservation.localDate),
        arrivalTime: operationalTimeFromDatabase(reservation.arrivalTime),
      }
    : null;
}

export async function readReservationAssignment(
  client: Pick<PrismaClient, "reservationAssignment">,
  input: { restaurantId: string; reservationId: string },
) {
  return client.reservationAssignment.findUnique({
    where: {
      restaurantId_reservationId: input,
    },
    include: {
      room: {
        select: {
          id: true,
          code: true,
          name: true,
          displayOrder: true,
          isActive: true,
        },
      },
      tables: {
        include: { diningTable: true },
        orderBy: { diningTableId: "asc" },
      },
    },
  });
}

export async function readAssignmentRoomCatalog(
  client: Pick<PrismaClient, "room">,
  restaurantId: string,
) {
  return client.room.findMany({
    where: { restaurantId },
    include: {
      diningTables: {
        orderBy: [
          { displayOrder: "asc" },
          { name: "asc" },
          { id: "asc" },
        ],
      },
    },
    orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
  });
}

export async function readAssignmentRestaurant(
  client: Pick<PrismaClient, "restaurant">,
  restaurantId: string,
) {
  return client.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, timezone: true },
  });
}

export async function incrementReservationAssignmentVersion(
  client: ReservationAssignmentTransactionClient,
  input: {
    restaurantId: string;
    reservationId: string;
    expectedVersion: number;
    updatedAt: Date;
  },
) {
  const updated = await client.reservation.updateMany({
    where: {
      id: input.reservationId,
      restaurantId: input.restaurantId,
      status: "CONFIRMED",
      version: input.expectedVersion,
    },
    data: {
      version: { increment: 1 },
      updatedAt: input.updatedAt,
    },
  });

  if (updated.count !== 1) return null;
  return readAssignmentReservation(client, {
    restaurantId: input.restaurantId,
    reservationId: input.reservationId,
  });
}

export async function createReservationAssignment(
  client: ReservationAssignmentTransactionClient,
  input: {
    actorId: string;
    restaurantId: string;
    reservationId: string;
    command: PutReservationAssignmentInput;
    now: Date;
  },
) {
  const assignment = await client.reservationAssignment.create({
    data: {
      restaurantId: input.restaurantId,
      reservationId: input.reservationId,
      roomId: input.command.roomId,
      internalNotes: input.command.internalNotes,
      assignedByUserId: input.actorId,
      updatedByUserId: input.actorId,
      createdAt: input.now,
      updatedAt: input.now,
    },
  });
  await client.reservationAssignmentTable.createMany({
    data: input.command.tableIds.map((diningTableId) => ({
      restaurantId: input.restaurantId,
      assignmentId: assignment.id,
      roomId: input.command.roomId,
      diningTableId,
    })),
  });
  return assignment;
}

export async function updateReservationAssignment(
  client: ReservationAssignmentTransactionClient,
  input: {
    assignmentId: string;
    actorId: string;
    restaurantId: string;
    command: PutReservationAssignmentInput;
    replaceTables: boolean;
    now: Date;
  },
): Promise<void> {
  if (input.replaceTables) {
    await client.reservationAssignmentTable.deleteMany({
      where: {
        restaurantId: input.restaurantId,
        assignmentId: input.assignmentId,
      },
    });
  }

  const updated = await client.reservationAssignment.updateMany({
    where: {
      id: input.assignmentId,
      restaurantId: input.restaurantId,
    },
    data: {
      roomId: input.command.roomId,
      internalNotes: input.command.internalNotes,
      updatedByUserId: input.actorId,
      updatedAt: input.now,
      clearedAt: null,
    },
  });
  if (updated.count !== 1) {
    throw new Error("Reservation assignment update invariant failed.");
  }

  if (input.replaceTables) {
    await client.reservationAssignmentTable.createMany({
      data: input.command.tableIds.map((diningTableId) => ({
        restaurantId: input.restaurantId,
        assignmentId: input.assignmentId,
        roomId: input.command.roomId,
        diningTableId,
      })),
    });
  }
}

export async function clearReservationAssignment(
  client: ReservationAssignmentTransactionClient,
  input: {
    assignmentId: string;
    actorId?: string;
    restaurantId: string;
    now: Date;
  },
): Promise<void> {
  const updated = await client.reservationAssignment.updateMany({
    where: {
      id: input.assignmentId,
      restaurantId: input.restaurantId,
    },
    data: {
      ...(input.actorId ? { updatedByUserId: input.actorId } : {}),
      updatedAt: input.now,
      clearedAt: input.now,
    },
  });
  if (updated.count !== 1) {
    throw new Error("Reservation assignment clear invariant failed.");
  }
}

export async function insertReservationAssignmentAudit(
  client: ReservationAssignmentTransactionClient,
  input: {
    actor: FreshAssignmentActor;
    reservationId: string;
    action: "ASSIGNED" | "REASSIGNED" | "UNASSIGNED";
    correlationId: string;
    previousState: Prisma.InputJsonValue;
    newState: Prisma.InputJsonValue;
    createdAt: Date;
  },
): Promise<void> {
  await client.reservationAuditEvent.create({
    data: {
      restaurantId: input.actor.restaurantId,
      reservationId: input.reservationId,
      action: input.action,
      actorOrigin: "STAFF",
      actorUserId: input.actor.id,
      actorRole: input.actor.role,
      correlationId: input.correlationId,
      previousState: input.previousState,
      newState: input.newState,
      capacityOverride: false,
      capacityOverrideReason: null,
      createdAt: input.createdAt,
    },
  });
}

export async function insertAutomaticReservationUnassignmentAudit(
  client: ReservationAssignmentTransactionClient,
  input: {
    restaurantId: string;
    reservationId: string;
    actor:
      | { origin: "PUBLIC"; id: null; role: null }
      | { origin: "STAFF"; id: string; role: "ADMIN" | "STAFF" };
    correlationId: string;
    previousState: Prisma.InputJsonValue;
    newState: Prisma.InputJsonValue;
    createdAt: Date;
  },
): Promise<void> {
  await client.reservationAuditEvent.create({
    data: {
      restaurantId: input.restaurantId,
      reservationId: input.reservationId,
      action: "UNASSIGNED",
      actorOrigin: input.actor.origin,
      actorUserId: input.actor.id,
      actorRole: input.actor.role,
      correlationId: input.correlationId,
      previousState: input.previousState,
      newState: input.newState,
      capacityOverride: false,
      capacityOverrideReason: null,
      createdAt: input.createdAt,
    },
  });
}

export const reservationAssignmentReadClient = prisma;
