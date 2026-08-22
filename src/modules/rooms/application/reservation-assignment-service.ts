import "server-only";

import { randomUUID } from "node:crypto";

import { getZonedDateTimeParts } from "@/modules/availability/domain/local-calendar";
import { acquireOperationalConfigurationLock } from "@/modules/configuration/infrastructure/operational-configuration-repository";
import { runReservationTransaction } from "@/modules/reservations/infrastructure/reservation-repository";
import {
  acquireCapacityLock,
  acquireReservationMutationLock,
} from "@/modules/reservations/infrastructure/reservation-locks";
import { parsePublicPreferences } from "@/modules/reservations/domain/public-validation";
import { ReservationAssignmentError } from "@/modules/rooms/application/reservation-assignment-errors";
import {
  assignmentTableIdsEqual,
  deleteReservationAssignmentSchema,
  putReservationAssignmentSchema,
  reservationAssignmentAuditSnapshot,
  reservationScheduleChangedAuditSnapshot,
  reservationAssignmentStatesEqual,
  type ActiveReservationAssignmentDto,
  type AssignmentRoomDto,
  type DeleteReservationAssignmentInput,
  type PutReservationAssignmentInput,
  type ReservationAssignmentContextDto,
} from "@/modules/rooms/domain/reservation-assignment";
import {
  clearReservationAssignment,
  createReservationAssignment,
  incrementReservationAssignmentVersion,
  insertReservationAssignmentAudit,
  insertAutomaticReservationUnassignmentAudit,
  readAssignmentReservation,
  readAssignmentReservationIdentity,
  readAssignmentRestaurant,
  readAssignmentRoomCatalog,
  readFreshAssignmentActor,
  readReservationAssignment,
  reservationAssignmentReadClient,
  updateReservationAssignment,
  type FreshAssignmentActor,
  type ReservationAssignmentReadClient,
  type ReservationAssignmentTransactionClient,
} from "@/modules/rooms/infrastructure/reservation-assignment-repository";
import { readEffectiveServiceRooms } from "@/modules/rooms/infrastructure/service-instance-repository";

export interface ReservationAssignmentActor {
  id: string;
  restaurantId: string;
}

export interface ReservationAssignmentMutationResult {
  changed: boolean;
  reservationVersion: number;
  assignment: ActiveReservationAssignmentDto | null;
}

type StoredAssignment = NonNullable<
  Awaited<ReturnType<typeof readReservationAssignment>>
>;
type AssignmentReservation = NonNullable<
  Awaited<ReturnType<typeof readAssignmentReservation>>
>;
type AssignmentRoomCatalog = Awaited<
  ReturnType<typeof readAssignmentRoomCatalog>
>;

interface AssignmentAvailabilityContext {
  isHistorical: boolean;
  roomAvailability: Map<string, boolean> | null;
}

function validationError(message: string): ReservationAssignmentError {
  return new ReservationAssignmentError("VALIDATION", message);
}

function parsePutInput(rawPayload: unknown): PutReservationAssignmentInput {
  const parsed = putReservationAssignmentSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw validationError(
      parsed.error.issues[0]?.message ?? "I dati dell'assegnazione non sono validi.",
    );
  }
  return parsed.data;
}

function parseDeleteInput(
  rawPayload: unknown,
): DeleteReservationAssignmentInput {
  const parsed = deleteReservationAssignmentSchema.safeParse(rawPayload);
  if (!parsed.success) {
    throw validationError("La versione della prenotazione non è valida.");
  }
  return parsed.data;
}

function assertNow(now: Date): void {
  if (Number.isNaN(now.getTime())) {
    throw validationError("La data di elaborazione non è valida.");
  }
}

function requireActor(
  actor: ReservationAssignmentActor,
  freshActor: FreshAssignmentActor | null,
): FreshAssignmentActor {
  if (!freshActor || freshActor.restaurantId !== actor.restaurantId) {
    throw new ReservationAssignmentError(
      "FORBIDDEN",
      "L'utente non può gestire le assegnazioni.",
    );
  }
  return freshActor;
}

function mapTable(table: AssignmentRoomCatalog[number]["diningTables"][number]) {
  return {
    id: table.id,
    name: table.name,
    minimumSeats: table.minimumSeats,
    maximumSeats: table.maximumSeats,
    displayOrder: table.displayOrder,
    isActive: table.isActive,
  };
}

function mapRooms(
  rooms: AssignmentRoomCatalog,
  availability: AssignmentAvailabilityContext,
): AssignmentRoomDto[] {
  return rooms.map((room) => ({
    id: room.id,
    code: room.code,
    name: room.name,
    displayOrder: room.displayOrder,
    isActive: room.isActive,
    isAvailableForService: availability.roomAvailability
      ? availability.roomAvailability.get(room.id) === true
      : null,
    tables: room.diningTables.map(mapTable),
  }));
}

function activeAssignmentDto(
  assignment: StoredAssignment | null,
  rooms: AssignmentRoomDto[],
): ActiveReservationAssignmentDto | null {
  if (!assignment || assignment.clearedAt !== null) return null;
  if (assignment.tables.length === 0) {
    throw new ReservationAssignmentError(
      "INVARIANT",
      "L'assegnazione attiva non contiene tavoli.",
    );
  }

  const room = rooms.find((candidate) => candidate.id === assignment.roomId);
  if (!room) {
    throw new ReservationAssignmentError(
      "INVARIANT",
      "La sala assegnata non appartiene al ristorante.",
    );
  }
  const tables = assignment.tables
    .map((row) => {
      if (row.roomId !== assignment.roomId) {
        throw new ReservationAssignmentError(
          "INVARIANT",
          "Un tavolo assegnato non appartiene alla sala finale.",
        );
      }
      return mapTable(row.diningTable);
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    id: assignment.id,
    room: {
      id: room.id,
      code: room.code,
      name: room.name,
      displayOrder: room.displayOrder,
      isActive: room.isActive,
      isAvailableForService: room.isAvailableForService,
    },
    tables,
    internalNotes: assignment.internalNotes,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
    hasInactiveReferences:
      !room.isActive || tables.some((table) => !table.isActive),
    hasUnavailableRoomReference:
      room.isAvailableForService === false,
  };
}

async function availabilityContext(
  client: ReservationAssignmentReadClient,
  input: {
    restaurantId: string;
    reservation: AssignmentReservation;
    now: Date;
  },
): Promise<AssignmentAvailabilityContext> {
  const restaurant = await readAssignmentRestaurant(
    client,
    input.restaurantId,
  );
  if (!restaurant) {
    throw new ReservationAssignmentError(
      "NOT_FOUND",
      "Prenotazione non trovata.",
    );
  }
  const localToday = getZonedDateTimeParts(
    input.now,
    restaurant.timezone,
  ).date;
  const isHistorical = input.reservation.localDate < localToday;
  if (isHistorical) {
    return { isHistorical: true, roomAvailability: null };
  }

  try {
    const effectiveRooms = await readEffectiveServiceRooms(client, {
      restaurantId: input.restaurantId,
      localDate: input.reservation.localDate,
      serviceType: input.reservation.serviceType,
      now: input.now,
    });
    return {
      isHistorical: false,
      roomAvailability: new Map(
        effectiveRooms.rooms.map((room) => [room.id, room.isAvailable]),
      ),
    };
  } catch {
    throw new ReservationAssignmentError(
      "INVARIANT",
      "La configurazione delle sale non è disponibile.",
    );
  }
}

function assignmentContextDto(input: {
  reservation: AssignmentReservation;
  assignment: StoredAssignment | null;
  catalog: AssignmentRoomCatalog;
  availability: AssignmentAvailabilityContext;
}): ReservationAssignmentContextDto {
  const rooms = mapRooms(input.catalog, input.availability);
  const parsedPreference = parsePublicPreferences(
    input.reservation.preferences,
  );
  const preferredRoom = input.catalog.find(
    (room) => room.code === parsedPreference.roomCode,
  );

  return {
    reservation: {
      id: input.reservation.id,
      version: input.reservation.version,
      status: input.reservation.status,
      localDate: input.reservation.localDate,
      serviceType: input.reservation.serviceType,
      arrivalTime: input.reservation.arrivalTime,
      isHistorical: input.availability.isHistorical,
      originalRoomPreference: {
        roomCode: parsedPreference.roomCode || null,
        roomName: preferredRoom?.name ?? null,
        isActive: preferredRoom?.isActive ?? null,
        legacyPreferencePresent: parsedPreference.legacyText !== null,
      },
    },
    assignment: activeAssignmentDto(input.assignment, rooms),
    rooms,
  };
}

async function readContextState(
  client: ReservationAssignmentReadClient,
  input: {
    restaurantId: string;
    reservationId: string;
    now: Date;
  },
) {
  const reservation = await readAssignmentReservation(client, input);
  if (!reservation) {
    throw new ReservationAssignmentError(
      "NOT_FOUND",
      "Prenotazione non trovata.",
    );
  }
  const assignment = await readReservationAssignment(client, {
    restaurantId: input.restaurantId,
    reservationId: input.reservationId,
  });
  const catalog = await readAssignmentRoomCatalog(client, input.restaurantId);
  const availability = await availabilityContext(client, {
    restaurantId: input.restaurantId,
    reservation,
    now: input.now,
  });

  return { reservation, assignment, catalog, availability };
}

export async function getReservationAssignmentContext(input: {
  actor: ReservationAssignmentActor;
  reservationId: string;
  now?: Date;
}): Promise<ReservationAssignmentContextDto> {
  const now = input.now ?? new Date();
  assertNow(now);
  const freshActor = requireActor(
    input.actor,
    await readFreshAssignmentActor(
      reservationAssignmentReadClient,
      {
        actorId: input.actor.id,
        restaurantId: input.actor.restaurantId,
      },
    ),
  );
  const state = await readContextState(reservationAssignmentReadClient, {
    restaurantId: freshActor.restaurantId,
    reservationId: input.reservationId,
    now,
  });

  return assignmentContextDto(state);
}

function assertConfirmed(reservation: AssignmentReservation): void {
  if (reservation.status === "CANCELLED") {
    throw new ReservationAssignmentError(
      "RESERVATION_CANCELLED",
      "Una prenotazione cancellata non può essere assegnata.",
    );
  }
}

function assertVersion(
  reservation: AssignmentReservation,
  expectedVersion: number,
): void {
  if (reservation.version !== expectedVersion) {
    throw new ReservationAssignmentError(
      "VERSION_CONFLICT",
      "La prenotazione è stata modificata da un altro utente. Ricarica i dati.",
    );
  }
}

function assignmentAuditValue(assignment: StoredAssignment) {
  return {
    finalRoomCode: assignment.room.code,
    tableIds: assignment.tables.map((row) => row.diningTableId),
    internalNotes: assignment.internalNotes,
  };
}

export async function clearReservationAssignmentForScheduleChange(
  client: ReservationAssignmentTransactionClient,
  input: {
    restaurantId: string;
    reservationId: string;
    actor:
      | { origin: "PUBLIC"; id: null; role: null }
      | { origin: "STAFF"; id: string; role: "ADMIN" | "STAFF" };
    correlationId: string;
    now: Date;
  },
): Promise<boolean> {
  const assignment = await readReservationAssignment(client, {
    restaurantId: input.restaurantId,
    reservationId: input.reservationId,
  });
  if (!assignment || assignment.clearedAt !== null) return false;
  if (assignment.tables.length === 0) {
    throw new ReservationAssignmentError(
      "INVARIANT",
      "L'assegnazione attiva non contiene tavoli.",
    );
  }

  await clearReservationAssignment(client, {
    assignmentId: assignment.id,
    ...(input.actor.id ? { actorId: input.actor.id } : {}),
    restaurantId: input.restaurantId,
    now: input.now,
  });
  await insertAutomaticReservationUnassignmentAudit(client, {
    restaurantId: input.restaurantId,
    reservationId: input.reservationId,
    actor: input.actor,
    correlationId: input.correlationId,
    previousState: reservationAssignmentAuditSnapshot(
      assignmentAuditValue(assignment),
    ),
    newState: reservationScheduleChangedAuditSnapshot(null),
    createdAt: input.now,
  });
  return true;
}

function assertNewReferences(input: {
  command: PutReservationAssignmentInput;
  current: StoredAssignment | null;
  catalog: AssignmentRoomCatalog;
  availability: AssignmentAvailabilityContext;
}): { roomCode: string } {
  const selectedRoom = input.catalog.find(
    (room) => room.id === input.command.roomId,
  );
  if (!selectedRoom) {
    throw validationError("La sala o i tavoli selezionati non sono validi.");
  }

  const activeCurrent =
    input.current?.clearedAt === null ? input.current : null;
  const roomRetained = activeCurrent?.roomId === selectedRoom.id;
  if (!roomRetained) {
    if (!selectedRoom.isActive) {
      throw new ReservationAssignmentError(
        "ROOM_UNAVAILABLE",
        "La sala selezionata non è attiva.",
      );
    }
    if (
      !input.availability.isHistorical &&
      input.availability.roomAvailability?.get(selectedRoom.id) !== true
    ) {
      throw new ReservationAssignmentError(
        "ROOM_UNAVAILABLE",
        "La sala selezionata non è disponibile per il servizio.",
      );
    }
  }

  const currentTableIds = new Set(
    roomRetained
      ? activeCurrent?.tables.map((row) => row.diningTableId) ?? []
      : [],
  );
  const tablesById = new Map(
    selectedRoom.diningTables.map((table) => [table.id, table]),
  );
  for (const tableId of input.command.tableIds) {
    const table = tablesById.get(tableId);
    if (!table) {
      throw validationError("Tutti i tavoli devono appartenere alla sala finale.");
    }
    if (!currentTableIds.has(tableId) && !table.isActive) {
      throw new ReservationAssignmentError(
        "ROOM_UNAVAILABLE",
        "Un nuovo tavolo selezionato non è attivo.",
      );
    }
  }

  return { roomCode: selectedRoom.code };
}

async function lockedMutationState(
  client: ReservationAssignmentTransactionClient,
  input: {
    actor: ReservationAssignmentActor;
    reservationId: string;
    now: Date;
  },
) {
  await acquireReservationMutationLock(
    client,
    input.actor.restaurantId,
    input.reservationId,
  );
  const identity = await readAssignmentReservationIdentity(client, {
    restaurantId: input.actor.restaurantId,
    reservationId: input.reservationId,
  });
  await acquireOperationalConfigurationLock(
    client,
    input.actor.restaurantId,
  );
  if (identity) {
    await acquireCapacityLock(client, {
      restaurantId: input.actor.restaurantId,
      localDate: identity.localDate,
      serviceType: identity.serviceType,
    });
  }

  const freshActor = requireActor(
    input.actor,
    await readFreshAssignmentActor(client, {
      actorId: input.actor.id,
      restaurantId: input.actor.restaurantId,
    }),
  );
  const state = await readContextState(client, {
    restaurantId: freshActor.restaurantId,
    reservationId: input.reservationId,
    now: input.now,
  });
  return { freshActor, ...state };
}

export async function putReservationAssignment(input: {
  actor: ReservationAssignmentActor;
  reservationId: string;
  rawPayload: unknown;
  now?: Date;
}): Promise<ReservationAssignmentMutationResult> {
  const command = parsePutInput(input.rawPayload);
  const now = input.now ?? new Date();
  assertNow(now);

  return runReservationTransaction(async (client) => {
    const state = await lockedMutationState(client, {
      actor: input.actor,
      reservationId: input.reservationId,
      now,
    });
    assertConfirmed(state.reservation);
    assertVersion(state.reservation, command.version);
    const { roomCode } = assertNewReferences({
      command,
      current: state.assignment,
      catalog: state.catalog,
      availability: state.availability,
    });
    const activeCurrent =
      state.assignment?.clearedAt === null ? state.assignment : null;
    if (
      activeCurrent &&
      reservationAssignmentStatesEqual(
        {
          roomId: activeCurrent.roomId,
          tableIds: activeCurrent.tables.map((row) => row.diningTableId),
          internalNotes: activeCurrent.internalNotes,
        },
        command,
      )
    ) {
      return {
        changed: false,
        reservationVersion: state.reservation.version,
        assignment: activeAssignmentDto(
          activeCurrent,
          mapRooms(state.catalog, state.availability),
        ),
      };
    }

    const updatedReservation = await incrementReservationAssignmentVersion(
      client,
      {
        restaurantId: state.freshActor.restaurantId,
        reservationId: state.reservation.id,
        expectedVersion: command.version,
        updatedAt: now,
      },
    );
    if (!updatedReservation) {
      throw new ReservationAssignmentError(
        "VERSION_CONFLICT",
        "La prenotazione è stata modificata da un altro utente. Ricarica i dati.",
      );
    }

    if (!state.assignment) {
      await createReservationAssignment(client, {
        actorId: state.freshActor.id,
        restaurantId: state.freshActor.restaurantId,
        reservationId: state.reservation.id,
        command,
        now,
      });
    } else {
      const storedIds = state.assignment.tables.map(
        (row) => row.diningTableId,
      );
      await updateReservationAssignment(client, {
        assignmentId: state.assignment.id,
        actorId: state.freshActor.id,
        restaurantId: state.freshActor.restaurantId,
        command,
        replaceTables:
          state.assignment.roomId !== command.roomId ||
          !assignmentTableIdsEqual(storedIds, command.tableIds),
        now,
      });
    }

    const action = activeCurrent ? "REASSIGNED" : "ASSIGNED";
    await insertReservationAssignmentAudit(client, {
      actor: state.freshActor,
      reservationId: state.reservation.id,
      action,
      correlationId: randomUUID(),
      previousState: reservationAssignmentAuditSnapshot(
        activeCurrent ? assignmentAuditValue(activeCurrent) : null,
      ),
      newState: reservationAssignmentAuditSnapshot({
        finalRoomCode: roomCode,
        tableIds: command.tableIds,
        internalNotes: command.internalNotes,
      }),
      createdAt: now,
    });

    const saved = await readReservationAssignment(client, {
      restaurantId: state.freshActor.restaurantId,
      reservationId: state.reservation.id,
    });
    if (!saved || saved.clearedAt !== null) {
      throw new ReservationAssignmentError(
        "INVARIANT",
        "L'assegnazione non è stata salvata correttamente.",
      );
    }
    return {
      changed: true,
      reservationVersion: updatedReservation.version,
      assignment: activeAssignmentDto(
        saved,
        mapRooms(state.catalog, state.availability),
      ),
    };
  });
}

export async function deleteReservationAssignment(input: {
  actor: ReservationAssignmentActor;
  reservationId: string;
  rawPayload: unknown;
  now?: Date;
}): Promise<ReservationAssignmentMutationResult> {
  const command = parseDeleteInput(input.rawPayload);
  const now = input.now ?? new Date();
  assertNow(now);

  return runReservationTransaction(async (client) => {
    const state = await lockedMutationState(client, {
      actor: input.actor,
      reservationId: input.reservationId,
      now,
    });
    assertConfirmed(state.reservation);
    const activeCurrent =
      state.assignment?.clearedAt === null ? state.assignment : null;
    if (!activeCurrent) {
      return {
        changed: false,
        reservationVersion: state.reservation.version,
        assignment: null,
      };
    }
    assertVersion(state.reservation, command.version);

    const updatedReservation = await incrementReservationAssignmentVersion(
      client,
      {
        restaurantId: state.freshActor.restaurantId,
        reservationId: state.reservation.id,
        expectedVersion: command.version,
        updatedAt: now,
      },
    );
    if (!updatedReservation) {
      throw new ReservationAssignmentError(
        "VERSION_CONFLICT",
        "La prenotazione è stata modificata da un altro utente. Ricarica i dati.",
      );
    }
    await clearReservationAssignment(client, {
      assignmentId: activeCurrent.id,
      actorId: state.freshActor.id,
      restaurantId: state.freshActor.restaurantId,
      now,
    });
    await insertReservationAssignmentAudit(client, {
      actor: state.freshActor,
      reservationId: state.reservation.id,
      action: "UNASSIGNED",
      correlationId: randomUUID(),
      previousState: reservationAssignmentAuditSnapshot(
        assignmentAuditValue(activeCurrent),
      ),
      newState: reservationAssignmentAuditSnapshot(null),
      createdAt: now,
    });

    return {
      changed: true,
      reservationVersion: updatedReservation.version,
      assignment: null,
    };
  });
}
