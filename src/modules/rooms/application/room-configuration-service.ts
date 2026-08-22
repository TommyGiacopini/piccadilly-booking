import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { insertAuditEvent } from "@/modules/audit/infrastructure/audit-repository";
import { getZonedDateTimeParts } from "@/modules/availability/domain/local-calendar";
import {
  localDateFromDatabase,
  localDateToDatabase,
  operationalTimeFromDatabase,
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
  type RoomImpactClassification,
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
  version: number;
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  partySize: number;
  roomCode: string;
  preferenceAffected: boolean;
  assignmentAffected: boolean;
  assignment: {
    id: string;
    roomId: string;
    roomCode: string;
    roomIsActive: boolean;
    tableIds: string[];
    tableStates: Array<{ id: string; isActive: boolean }>;
  } | null;
}

type ImpactTarget =
  | { kind: "ROOM"; roomId: string; roomCode: string }
  | { kind: "TABLE"; tableId: string; roomId: string; roomCode: string };

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
    target: ImpactTarget;
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
      version: true,
      localDate: true,
      serviceType: true,
      arrivalTime: true,
      partySize: true,
      preferences: true,
      assignment: {
        select: {
          id: true,
          restaurantId: true,
          roomId: true,
          clearedAt: true,
          room: {
            select: { code: true, isActive: true },
          },
          tables: {
            select: {
              diningTableId: true,
              diningTable: { select: { isActive: true } },
            },
            orderBy: { diningTableId: "asc" },
          },
        },
      },
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
    const activeAssignment =
      row.assignment?.restaurantId === input.restaurantId &&
      row.assignment.clearedAt === null
        ? row.assignment
        : null;
    const preferenceAffected =
      input.target.kind === "ROOM" && roomCode === input.target.roomCode;
    const targetTableId =
      input.target.kind === "TABLE" ? input.target.tableId : null;
    const assignmentAffected =
      activeAssignment !== null &&
      (input.target.kind === "ROOM"
        ? activeAssignment.roomId === input.target.roomId
        : activeAssignment.tables.some(
            (table) => table.diningTableId === targetTableId,
          ));

    return preferenceAffected || assignmentAffected
      ? [
          {
            id: row.id,
            status: "CONFIRMED" as const,
            version: row.version,
            localDate: localDateFromDatabase(row.localDate),
            serviceType: row.serviceType,
            arrivalTime: operationalTimeFromDatabase(row.arrivalTime),
            partySize: row.partySize,
            roomCode,
            preferenceAffected,
            assignmentAffected,
            assignment: assignmentAffected
              ? {
                  id: activeAssignment!.id,
                  roomId: activeAssignment!.roomId,
                  roomCode: activeAssignment!.room.code,
                  roomIsActive: activeAssignment!.room.isActive,
                  tableIds: activeAssignment!.tables.map(
                    (table) => table.diningTableId,
                  ),
                  tableStates: activeAssignment!.tables.map((table) => ({
                    id: table.diningTableId,
                    isActive: table.diningTable.isActive,
                  })),
                }
              : null,
          },
        ]
      : [];
  });
}

function impact(input: {
  proposal: RoomConfigurationProposal;
  roomCode: string;
  previousAvailable: boolean;
  destructive: boolean;
  relevantReservations: RelevantReservation[];
}): RoomConfigurationImpact {
  const reservations = input.destructive ? input.relevantReservations : [];
  const covers = reservations.reduce(
    (total, reservation) => total + reservation.partySize,
    0,
  );
  const preferenceReservationCount = reservations.filter(
    (reservation) => reservation.preferenceAffected,
  ).length;
  const assignmentReservationCount = reservations.filter(
    (reservation) => reservation.assignmentAffected,
  ).length;
  const classification =
    reservations.length === 0
      ? "NO_EXISTING_RESERVATION_IMPACT"
      : input.proposal.kind === "SERVICE_ROOM_AVAILABILITY"
        ? "ROOM_UNAVAILABLE"
        : input.proposal.kind === "ROOM_CATALOG"
          ? "ROOM_DISABLED"
          : "TABLE_DISABLED";
  const proposedAvailable =
    input.proposal.kind === "SERVICE_ROOM_AVAILABILITY"
      ? input.proposal.isAvailable
      : input.proposal.isActive;
  const classifications: RoomImpactClassification[] = [
    classification,
    ...(preferenceReservationCount > 0
      ? (["RESERVATION_WITH_AFFECTED_ROOM_PREFERENCE"] as const)
      : []),
    ...(assignmentReservationCount > 0
      ? (["RESERVATION_WITH_AFFECTED_FINAL_ASSIGNMENT"] as const)
      : []),
  ];

  return {
    reservationCount: reservations.length,
    covers,
    preferenceReservationCount,
    assignmentReservationCount,
    items: [
      {
        classification,
        classifications,
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
        preferenceReservationCount,
        assignmentReservationCount,
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
    const destructive = room.isAvailable && !proposal.isAvailable;
    const reservations = destructive
      ? await readRelevantReservations(client, {
          restaurantId: actor.restaurantId,
          localToday,
          localDate: proposal.localDate,
          serviceType: proposal.serviceType,
          target: { kind: "ROOM", roomId: room.id, roomCode: room.code },
        })
      : [];
    const calculatedImpact = impact({
      proposal,
      roomCode: room.code,
      previousAvailable: room.configuredAvailable,
      destructive,
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

  if (proposal.kind === "ROOM_CATALOG") {
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
            target: { kind: "ROOM", roomId: room.id, roomCode: room.code },
          })
        : [];
    const calculatedImpact = impact({
      proposal,
      roomCode: room.code,
      previousAvailable: room.isActive,
      destructive: room.isActive && !proposal.isActive,
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

  const table = await client.diningTable.findFirst({
    where: {
      id: proposal.tableId,
      room: { restaurantId: actor.restaurantId },
    },
    select: {
      id: true,
      roomId: true,
      name: true,
      minimumSeats: true,
      maximumSeats: true,
      displayOrder: true,
      isActive: true,
      room: { select: { code: true, isActive: true } },
    },
  });
  if (!table) {
    throw new RoomAvailabilityError("NOT_FOUND", "Tavolo non disponibile.");
  }
  const destructive = table.isActive && !proposal.isActive;
  const reservations = destructive
    ? await readRelevantReservations(client, {
        restaurantId: actor.restaurantId,
        localToday,
        target: {
          kind: "TABLE",
          tableId: table.id,
          roomId: table.roomId,
          roomCode: table.room.code,
        },
      })
    : [];
  const calculatedImpact = impact({
    proposal,
    roomCode: table.room.code,
    previousAvailable: table.isActive,
    destructive,
    relevantReservations: reservations,
  });
  const changed =
    table.name !== proposal.name ||
    table.minimumSeats !== proposal.minimumSeats ||
    table.maximumSeats !== proposal.maximumSeats ||
    table.displayOrder !== proposal.displayOrder ||
    table.isActive !== proposal.isActive;

  return {
    proposal,
    fingerprint: hashFingerprint({ proposal, current: table, reservations }),
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
    await acquireOperationalConfigurationLock(client, actor.restaurantId);
    if (parsed.data.proposal.kind === "SERVICE_ROOM_AVAILABILITY") {
      await acquireCapacityLock(client, {
        restaurantId: actor.restaurantId,
        localDate: parsed.data.proposal.localDate,
        serviceType: parsed.data.proposal.serviceType,
      });
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
          classifications: before?.classifications ?? [],
          preferenceReservationCount:
            preview.impact.preferenceReservationCount,
          assignmentReservationCount:
            preview.impact.assignmentReservationCount,
        },
        createdAt: now,
      });
      return { changed: true };
    }

    const proposal = parsed.data.proposal;
    if (proposal.kind === "ROOM_CATALOG") {
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
          classifications: preview.impact.items[0]?.classifications ?? [],
          preferenceReservationCount:
            preview.impact.preferenceReservationCount,
          assignmentReservationCount:
            preview.impact.assignmentReservationCount,
        },
        createdAt: now,
      });
      return { changed: true };
    }

    const current = await client.diningTable.findFirstOrThrow({
      where: {
        id: proposal.tableId,
        room: { restaurantId: actor.restaurantId },
      },
    });
    const previousState = tableSnapshot(current);
    const updated = await client.diningTable.update({
      where: { id: current.id },
      data: {
        name: proposal.name,
        minimumSeats: proposal.minimumSeats,
        maximumSeats: proposal.maximumSeats,
        displayOrder: proposal.displayOrder,
        isActive: proposal.isActive,
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
      metadata: {
        reservationCount: preview.impact.reservationCount,
        covers: preview.impact.covers,
        classification: preview.impact.items[0]?.classification ?? null,
        classifications: preview.impact.items[0]?.classifications ?? [],
        preferenceReservationCount:
          preview.impact.preferenceReservationCount,
        assignmentReservationCount:
          preview.impact.assignmentReservationCount,
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

  if (command.action === "UPDATE_TABLE") {
    throw new RoomAvailabilityError(
      "VALIDATION",
      "Gli aggiornamenti dei tavoli richiedono il protocollo di anteprima e applicazione.",
    );
  }

  try {
    return await runOperationalConfigurationTransaction(async (client) => {
      await requireFreshAdmin(client, actor);
      await acquireOperationalConfigurationLock(client, actor.restaurantId);

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
