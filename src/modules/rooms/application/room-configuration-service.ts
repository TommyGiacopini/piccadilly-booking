import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { auditStatesEqual } from "@/modules/audit/domain/audit-event";
import { insertAuditEvent } from "@/modules/audit/infrastructure/audit-repository";
import { getZonedDateTimeParts } from "@/modules/availability/domain/local-calendar";
import {
  localDateFromDatabase,
  localDateToDatabase,
} from "@/modules/configuration/domain/operational-time";
import {
  acquireOperationalConfigurationLock,
  runOperationalConfigurationTransaction,
  type OperationalConfigurationClient,
} from "@/modules/configuration/infrastructure/operational-configuration-repository";
import {
  diningTableMutationSchema,
  roomConfigurationConfirmationSchema,
  roomConfigurationProposalSchema,
  type DiningTableMutation,
  type RoomConfigurationImpact,
  type RoomConfigurationProposal,
} from "@/modules/rooms/domain/room-configuration";
import { RoomAvailabilityError } from "@/modules/rooms/application/room-availability-errors";
import {
  materializeServiceInstance,
  readEffectiveServiceRooms,
} from "@/modules/rooms/infrastructure/service-instance-repository";
import { parsePublicPreferences } from "@/modules/reservations/domain/public-validation";
import { acquireCapacityLock } from "@/modules/reservations/infrastructure/reservation-locks";

export interface RoomConfigurationActor {
  id: string;
  restaurantId: string;
}

interface RelevantReservation {
  id: string;
  status: "CONFIRMED";
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  partySize: number;
  roomCode: string;
}

export interface RoomConfigurationPreview {
  proposal: RoomConfigurationProposal;
  fingerprint: string;
  changed: boolean;
  confirmationRequired: boolean;
  impact: RoomConfigurationImpact;
}

export class RoomConfigurationImpactChangedError extends RoomAvailabilityError {
  constructor(readonly preview: RoomConfigurationPreview) {
    super(
      "IMPACT_CHANGED",
      "La configurazione o le prenotazioni sono cambiate. Controlla la nuova anteprima e conferma di nuovo.",
    );
    this.name = "RoomConfigurationImpactChangedError";
  }
}

async function requireFreshAdmin(
  client: OperationalConfigurationClient,
  actor: RoomConfigurationActor,
) {
  const current = await client.user.findFirst({
    where: {
      id: actor.id,
      restaurantId: actor.restaurantId,
      isActive: true,
      disabledAt: null,
      role: "ADMIN",
      mustChangePassword: false,
    },
    select: { id: true, restaurantId: true, role: true },
  });
  if (!current) {
    throw new RoomAvailabilityError(
      "FORBIDDEN",
      "Solo un amministratore attivo può gestire sale e tavoli.",
    );
  }
  return current;
}

function parseProposal(input: unknown): RoomConfigurationProposal {
  const parsed = roomConfigurationProposalSchema.safeParse(input);
  if (!parsed.success) {
    throw new RoomAvailabilityError(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "La proposta non è valida.",
    );
  }
  return parsed.data;
}

async function readRelevantReservations(
  client: OperationalConfigurationClient,
  input: {
    restaurantId: string;
    roomCode: string;
    localToday: string;
    localDate?: string;
    serviceType?: "LUNCH" | "DINNER";
  },
): Promise<RelevantReservation[]> {
  const rows = await client.reservation.findMany({
    where: {
      restaurantId: input.restaurantId,
      status: "CONFIRMED",
      localDate: input.localDate
        ? localDateToDatabase(input.localDate)
        : { gte: localDateToDatabase(input.localToday) },
      ...(input.serviceType ? { serviceType: input.serviceType } : {}),
    },
    select: {
      id: true,
      status: true,
      localDate: true,
      serviceType: true,
      partySize: true,
      preferences: true,
    },
    orderBy: [
      { localDate: "asc" },
      { serviceType: "asc" },
      { arrivalTime: "asc" },
      { id: "asc" },
    ],
  });

  return rows.flatMap((row) => {
    const roomCode = parsePublicPreferences(row.preferences).roomCode;
    return roomCode === input.roomCode
      ? [
          {
            id: row.id,
            status: "CONFIRMED" as const,
            localDate: localDateFromDatabase(row.localDate),
            serviceType: row.serviceType,
            partySize: row.partySize,
            roomCode,
          },
        ]
      : [];
  });
}

function impact(input: {
  proposal: RoomConfigurationProposal;
  roomCode: string;
  previousAvailable: boolean;
  relevantReservations: RelevantReservation[];
}): RoomConfigurationImpact {
  const reservations =
    input.proposal.kind === "SERVICE_ROOM_AVAILABILITY"
      ? input.proposal.isAvailable
        ? []
        : input.relevantReservations
      : input.proposal.isActive
        ? []
        : input.relevantReservations;
  const covers = reservations.reduce(
    (total, reservation) => total + reservation.partySize,
    0,
  );
  const classification =
    reservations.length === 0
      ? "NO_EXISTING_RESERVATION_IMPACT"
      : input.proposal.kind === "SERVICE_ROOM_AVAILABILITY"
        ? "ROOM_UNAVAILABLE"
        : "ROOM_DISABLED";
  const proposedAvailable =
    input.proposal.kind === "SERVICE_ROOM_AVAILABILITY"
      ? input.proposal.isAvailable
      : input.proposal.isActive;

  return {
    reservationCount: reservations.length,
    covers,
    items: [
      {
        classification,
        localDate:
          input.proposal.kind === "SERVICE_ROOM_AVAILABILITY"
            ? input.proposal.localDate
            : null,
        serviceType:
          input.proposal.kind === "SERVICE_ROOM_AVAILABILITY"
            ? input.proposal.serviceType
            : null,
        roomCode: input.roomCode,
        reservationCount: reservations.length,
        covers,
        previousAvailable: input.previousAvailable,
        proposedAvailable,
      },
    ],
  };
}

function hashFingerprint(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

async function calculatePreview(
  client: OperationalConfigurationClient,
  actor: RoomConfigurationActor,
  proposal: RoomConfigurationProposal,
  now: Date,
): Promise<RoomConfigurationPreview> {
  const restaurant = await client.restaurant.findUnique({
    where: { id: actor.restaurantId },
    select: { timezone: true },
  });
  if (!restaurant) {
    throw new RoomAvailabilityError("NOT_FOUND", "Ristorante non disponibile.");
  }
  const localToday = getZonedDateTimeParts(now, restaurant.timezone).date;

  if (proposal.kind === "SERVICE_ROOM_AVAILABILITY") {
    if (proposal.localDate < localToday) {
      throw new RoomAvailabilityError(
        "HISTORICAL",
        "Le istanze storiche sono consultabili ma non modificabili.",
      );
    }
    const state = await readEffectiveServiceRooms(client, {
      restaurantId: actor.restaurantId,
      localDate: proposal.localDate,
      serviceType: proposal.serviceType,
      now,
    });
    const room = state.rooms.find((candidate) => candidate.id === proposal.roomId);
    if (!room) {
      throw new RoomAvailabilityError("NOT_FOUND", "Sala non disponibile.");
    }
    const reservations = proposal.isAvailable
      ? []
      : await readRelevantReservations(client, {
          restaurantId: actor.restaurantId,
          localToday,
          localDate: proposal.localDate,
          serviceType: proposal.serviceType,
          roomCode: room.code,
        });
    const calculatedImpact = impact({
      proposal,
      roomCode: room.code,
      previousAvailable: room.configuredAvailable,
      relevantReservations: reservations,
    });
    const changed = room.configuredAvailable !== proposal.isAvailable;

    return {
      proposal,
      fingerprint: hashFingerprint({
        proposal,
        current: {
          instance: state.instance,
          service: state.service,
          room: {
            id: room.id,
            code: room.code,
            isActive: room.isActive,
            policy: room.serviceAvailabilityPolicy,
            configuredAvailable: room.configuredAvailable,
          },
        },
        reservations,
      }),
      changed,
      confirmationRequired:
        changed && calculatedImpact.reservationCount > 0,
      impact: calculatedImpact,
    };
  }

  const room = await client.room.findFirst({
    where: { id: proposal.roomId, restaurantId: actor.restaurantId },
    select: {
      id: true,
      code: true,
      displayOrder: true,
      isActive: true,
      serviceAvailabilityPolicy: true,
    },
  });
  if (!room) {
    throw new RoomAvailabilityError("NOT_FOUND", "Sala non disponibile.");
  }
  const reservations =
    room.isActive && !proposal.isActive
      ? await readRelevantReservations(client, {
          restaurantId: actor.restaurantId,
          localToday,
          roomCode: room.code,
        })
      : [];
  const calculatedImpact = impact({
    proposal,
    roomCode: room.code,
    previousAvailable: room.isActive,
    relevantReservations: reservations,
  });
  const changed =
    room.displayOrder !== proposal.displayOrder ||
    room.isActive !== proposal.isActive;

  return {
    proposal,
    fingerprint: hashFingerprint({ proposal, current: room, reservations }),
    changed,
    confirmationRequired: changed && calculatedImpact.reservationCount > 0,
    impact: calculatedImpact,
  };
}

export async function getAdminRoomConfiguration(
  actor: RoomConfigurationActor,
  input: {
    localDate: string;
    serviceType: "LUNCH" | "DINNER";
    now?: Date;
  },
) {
  return runOperationalConfigurationTransaction(async (client) => {
    await requireFreshAdmin(client, actor);
    const service = await readEffectiveServiceRooms(client, {
      restaurantId: actor.restaurantId,
      localDate: input.localDate,
      serviceType: input.serviceType,
      now: input.now ?? new Date(),
    });
    const rooms = await client.room.findMany({
      where: { restaurantId: actor.restaurantId },
      include: {
        diningTables: {
          orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
        },
      },
      orderBy: [{ displayOrder: "asc" }, { code: "asc" }],
    });
    return { service, rooms };
  });
}

export async function previewRoomConfigurationChange(
  actor: RoomConfigurationActor,
  unsafeInput: unknown,
  options: { now?: Date } = {},
): Promise<RoomConfigurationPreview> {
  const proposal = parseProposal(unsafeInput);
  return runOperationalConfigurationTransaction(async (client) => {
    await requireFreshAdmin(client, actor);
    return calculatePreview(client, actor, proposal, options.now ?? new Date());
  });
}

export async function applyRoomConfigurationChange(
  actor: RoomConfigurationActor,
  unsafeInput: unknown,
  options: { now?: Date } = {},
): Promise<{ changed: boolean }> {
  const parsed = roomConfigurationConfirmationSchema.safeParse(unsafeInput);
  if (!parsed.success) {
    throw new RoomAvailabilityError(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "La conferma non è valida.",
    );
  }
  const now = options.now ?? new Date();

  return runOperationalConfigurationTransaction(async (client) => {
    await requireFreshAdmin(client, actor);
    if (parsed.data.proposal.kind === "SERVICE_ROOM_AVAILABILITY") {
      await acquireCapacityLock(client, {
        restaurantId: actor.restaurantId,
        localDate: parsed.data.proposal.localDate,
        serviceType: parsed.data.proposal.serviceType,
      });
    } else {
      await acquireOperationalConfigurationLock(client, actor.restaurantId);
    }

    const preview = await calculatePreview(
      client,
      actor,
      parsed.data.proposal,
      now,
    );
    if (preview.fingerprint !== parsed.data.fingerprint) {
      throw new RoomConfigurationImpactChangedError(preview);
    }
    if (!preview.changed) return { changed: false };

    if (parsed.data.proposal.kind === "SERVICE_ROOM_AVAILABILITY") {
      const proposal = parsed.data.proposal;
      const before = preview.impact.items[0];
      const materialized = await materializeServiceInstance(client, {
        restaurantId: actor.restaurantId,
        localDate: proposal.localDate,
        serviceType: proposal.serviceType,
      });
      const availability = materialized.instance.roomAvailabilities.find(
        (row) => row.roomId === proposal.roomId,
      );
      if (!availability) {
        throw new RoomAvailabilityError(
          "INVARIANT",
          "La disponibilità della sala non è stata inizializzata.",
        );
      }
      await client.serviceRoomAvailability.update({
        where: { id: availability.id },
        data: { isAvailable: proposal.isAvailable },
      });
      await client.serviceInstance.update({
        where: { id: materialized.instance.id },
        data: { version: { increment: 1 } },
      });
      await insertAuditEvent(client, {
        restaurantId: actor.restaurantId,
        category: "CONFIGURATION",
        action: "ROOM_AVAILABILITY_UPDATED",
        outcome: "SUCCESS",
        actorUserId: actor.id,
        actorRole: "ADMIN",
        entityType: "SERVICE_ROOM_AVAILABILITY",
        entityId: availability.id,
        correlationId: randomUUID(),
        previousState: {
          localDate: proposal.localDate,
          serviceType: proposal.serviceType,
          roomCode: before?.roomCode ?? null,
          isAvailable: before?.previousAvailable ?? false,
        },
        newState: {
          localDate: proposal.localDate,
          serviceType: proposal.serviceType,
          roomCode: before?.roomCode ?? null,
          isAvailable: proposal.isAvailable,
        },
        metadata: {
          instanceMaterialized: materialized.materialized,
          reservationCount: preview.impact.reservationCount,
          covers: preview.impact.covers,
          classification: before?.classification ?? null,
        },
        createdAt: now,
      });
      return { changed: true };
    }

    const proposal = parsed.data.proposal;
    const current = await client.room.findFirstOrThrow({
      where: { id: proposal.roomId, restaurantId: actor.restaurantId },
    });
    const previousState = {
      code: current.code,
      displayOrder: current.displayOrder,
      isActive: current.isActive,
    };
    await client.room.update({
      where: { id: current.id },
      data: {
        displayOrder: proposal.displayOrder,
        isActive: proposal.isActive,
      },
    });
    const action =
      current.isActive !== proposal.isActive
        ? proposal.isActive
          ? "ROOM_ENABLED"
          : "ROOM_DISABLED"
        : "ROOM_ORDER_UPDATED";
    await insertAuditEvent(client, {
      restaurantId: actor.restaurantId,
      category: "CONFIGURATION",
      action,
      outcome: "SUCCESS",
      actorUserId: actor.id,
      actorRole: "ADMIN",
      entityType: "ROOM",
      entityId: current.id,
      correlationId: randomUUID(),
      previousState,
      newState: {
        code: current.code,
        displayOrder: proposal.displayOrder,
        isActive: proposal.isActive,
      },
      metadata: {
        reservationCount: preview.impact.reservationCount,
        covers: preview.impact.covers,
        classification: preview.impact.items[0]?.classification ?? null,
      },
      createdAt: now,
    });
    return { changed: true };
  });
}

function tableSnapshot(table: {
  roomId: string;
  name: string;
  minimumSeats: number;
  maximumSeats: number;
  displayOrder: number;
  isActive: boolean;
}) {
  return {
    roomId: table.roomId,
    name: table.name,
    minimumSeats: table.minimumSeats,
    maximumSeats: table.maximumSeats,
    displayOrder: table.displayOrder,
    isActive: table.isActive,
  };
}

export async function mutateDiningTable(
  actor: RoomConfigurationActor,
  unsafeInput: unknown,
  options: { now?: Date } = {},
): Promise<{ changed: boolean; id: string }> {
  const parsed = diningTableMutationSchema.safeParse(unsafeInput);
  if (!parsed.success) {
    throw new RoomAvailabilityError(
      "VALIDATION",
      parsed.error.issues[0]?.message ?? "I dati del tavolo non sono validi.",
    );
  }
  const command: DiningTableMutation = parsed.data;
  const now = options.now ?? new Date();

  try {
    return await runOperationalConfigurationTransaction(async (client) => {
      await requireFreshAdmin(client, actor);
      await acquireOperationalConfigurationLock(client, actor.restaurantId);

      if (command.action === "CREATE_TABLE") {
        const room = await client.room.findFirst({
          where: { id: command.roomId, restaurantId: actor.restaurantId },
          select: { id: true },
        });
        if (!room) {
          throw new RoomAvailabilityError("NOT_FOUND", "Sala non disponibile.");
        }
        const created = await client.diningTable.create({
          data: {
            roomId: room.id,
            name: command.name,
            minimumSeats: command.minimumSeats,
            maximumSeats: command.maximumSeats,
            displayOrder: command.displayOrder,
          },
        });
        await insertAuditEvent(client, {
          restaurantId: actor.restaurantId,
          category: "CONFIGURATION",
          action: "DINING_TABLE_CREATED",
          outcome: "SUCCESS",
          actorUserId: actor.id,
          actorRole: "ADMIN",
          entityType: "DINING_TABLE",
          entityId: created.id,
          correlationId: randomUUID(),
          previousState: null,
          newState: tableSnapshot(created),
          metadata: null,
          createdAt: now,
        });
        return { changed: true, id: created.id };
      }

      const current = await client.diningTable.findFirst({
        where: { id: command.id, room: { restaurantId: actor.restaurantId } },
      });
      if (!current) {
        throw new RoomAvailabilityError("NOT_FOUND", "Tavolo non disponibile.");
      }
      const previousState = tableSnapshot(current);
      const requestedState = {
        ...previousState,
        name: command.name,
        minimumSeats: command.minimumSeats,
        maximumSeats: command.maximumSeats,
        displayOrder: command.displayOrder,
        isActive: command.isActive,
      };
      if (auditStatesEqual(previousState, requestedState)) {
        return { changed: false, id: current.id };
      }
      const updated = await client.diningTable.update({
        where: { id: current.id },
        data: {
          name: command.name,
          minimumSeats: command.minimumSeats,
          maximumSeats: command.maximumSeats,
          displayOrder: command.displayOrder,
          isActive: command.isActive,
        },
      });
      const action =
        current.isActive !== updated.isActive
          ? updated.isActive
            ? "DINING_TABLE_ENABLED"
            : "DINING_TABLE_DISABLED"
          : "DINING_TABLE_UPDATED";
      await insertAuditEvent(client, {
        restaurantId: actor.restaurantId,
        category: "CONFIGURATION",
        action,
        outcome: "SUCCESS",
        actorUserId: actor.id,
        actorRole: "ADMIN",
        entityType: "DINING_TABLE",
        entityId: current.id,
        correlationId: randomUUID(),
        previousState,
        newState: tableSnapshot(updated),
        metadata: null,
        createdAt: now,
      });
      return { changed: true, id: current.id };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new RoomAvailabilityError(
        "VALIDATION",
        "Esiste già un tavolo con questo nome nella sala.",
      );
    }
    throw error;
  }
}
