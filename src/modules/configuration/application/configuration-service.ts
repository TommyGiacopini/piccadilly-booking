import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import { auditStatesEqual } from "@/modules/audit/domain/audit-event";
import { insertAuditEvent } from "@/modules/audit/infrastructure/audit-repository";
import { ConfigurationError } from "@/modules/configuration/application/configuration-errors";
import {
  localDateFromDatabase,
  operationalTimeFromDatabase,
} from "@/modules/configuration/domain/operational-time";
import {
  bookingSettingsUpdateSchema,
  diningTableUpdateSchema,
  roomUpdateSchema,
  specialDateInputSchema,
  weeklyScheduleUpdateSchema,
} from "@/modules/configuration/domain/validation";
import {
  createSpecialDateForRestaurant,
  largestSlotIntervalForRestaurant,
  readBookingSettingsForRestaurant,
  readDiningTableForRestaurant,
  readOperationalConfigurationForRestaurant,
  readRoomForRestaurant,
  readSpecialDateByIdentity,
  readSpecialDateForRestaurant,
  readWeeklyScheduleForRestaurant,
  runConfigurationTransaction,
  setSpecialDateArchivedState,
  writeBookingSettingsForRestaurant,
  writeDiningTableForRestaurant,
  writeRoomForRestaurant,
  writeSpecialDateForRestaurant,
  writeWeeklyScheduleForRestaurant,
  type ConfigurationClient,
} from "@/modules/configuration/infrastructure/configuration-repository";
import { z } from "zod";

export interface ConfigurationActor {
  id: string;
  restaurantId: string;
  role: "ADMIN" | "STAFF";
}

function requireAdminActor(actor: ConfigurationActor): void {
  if (actor.role !== "ADMIN") {
    throw new ConfigurationError(
      "FORBIDDEN",
      "Solo un amministratore può accedere alla configurazione.",
    );
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new ConfigurationError(
      "VALIDATION",
      result.error.issues[0]?.message ?? "I dati inseriti non sono validi.",
    );
  }

  return result.data;
}

function ensureFound<T>(value: T | null): T {
  if (!value) {
    throw new ConfigurationError(
      "NOT_FOUND",
      "La configurazione richiesta non è disponibile per questo ristorante.",
    );
  }
  return value;
}

function handlePersistenceError(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new ConfigurationError(
      "DUPLICATE",
      "Esiste già una configurazione con gli stessi dati.",
    );
  }

  throw error;
}

function bookingSettingsSnapshot(settings: {
  rollingCapacityCovers: number;
  rollingWindowMinutes: number;
  lunchModificationCutoff: Date;
  dinnerModificationCutoff: Date;
  managementLinkDurationHours: number;
}) {
  return {
    rollingCapacityCovers: settings.rollingCapacityCovers,
    rollingWindowMinutes: settings.rollingWindowMinutes,
    lunchModificationCutoff: operationalTimeFromDatabase(
      settings.lunchModificationCutoff,
    ),
    dinnerModificationCutoff: operationalTimeFromDatabase(
      settings.dinnerModificationCutoff,
    ),
    managementLinkDurationHours: settings.managementLinkDurationHours,
  };
}

function roomSnapshot(room: {
  code: string;
  displayOrder: number;
  isActive: boolean;
}) {
  return {
    code: room.code,
    displayOrder: room.displayOrder,
    isActive: room.isActive,
  };
}

function diningTableSnapshot(table: {
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

function weeklyScheduleSnapshot(schedule: {
  dayOfWeek: string;
  serviceType: string;
  isEnabled: boolean;
  startTime: Date;
  endTime: Date;
  slotIntervalMinutes: number;
}) {
  return {
    dayOfWeek: schedule.dayOfWeek,
    serviceType: schedule.serviceType,
    isEnabled: schedule.isEnabled,
    startTime: operationalTimeFromDatabase(schedule.startTime),
    endTime: operationalTimeFromDatabase(schedule.endTime),
    slotIntervalMinutes: schedule.slotIntervalMinutes,
  };
}

function specialDateSnapshot(override: {
  date: Date;
  scope: string;
  isClosed: boolean;
  specialStartTime: Date | null;
  specialEndTime: Date | null;
  specialCapacityCovers: number | null;
  operationalNotes: string | null;
  archivedAt: Date | null;
}) {
  return {
    date: localDateFromDatabase(override.date),
    scope: override.scope,
    isClosed: override.isClosed,
    specialStartTime: override.specialStartTime
      ? operationalTimeFromDatabase(override.specialStartTime)
      : null,
    specialEndTime: override.specialEndTime
      ? operationalTimeFromDatabase(override.specialEndTime)
      : null,
    specialCapacityCovers: override.specialCapacityCovers,
    operationalNotesPresent:
      override.operationalNotes !== null &&
      override.operationalNotes.trim().length > 0,
    archived: override.archivedAt !== null,
  };
}

async function writeConfigurationAudit(
  client: ConfigurationClient,
  input: {
    actor: ConfigurationActor;
    action:
      | "BOOKING_SETTINGS_UPDATED"
      | "ROOM_UPDATED"
      | "DINING_TABLE_UPDATED"
      | "WEEKLY_SCHEDULE_UPDATED"
      | "SPECIAL_DATE_CREATED"
      | "SPECIAL_DATE_UPDATED"
      | "SPECIAL_DATE_ARCHIVED"
      | "SPECIAL_DATE_REACTIVATED";
    entityType: string;
    entityId: string;
    previousState: Prisma.InputJsonValue | null;
    newState: Prisma.InputJsonValue;
    createdAt: Date;
  },
): Promise<void> {
  await insertAuditEvent(client, {
    restaurantId: input.actor.restaurantId,
    category: "CONFIGURATION",
    action: input.action,
    outcome: "SUCCESS",
    actorUserId: input.actor.id,
    actorRole: input.actor.role,
    entityType: input.entityType,
    entityId: input.entityId,
    correlationId: randomUUID(),
    previousState: input.previousState,
    newState: input.newState,
    metadata: null,
    createdAt: input.createdAt,
  });
}

export async function getOperationalConfiguration(actor: ConfigurationActor) {
  requireAdminActor(actor);
  const configuration = await readOperationalConfigurationForRestaurant(
    actor.restaurantId,
  );

  if (!configuration || !configuration.settings) {
    throw new ConfigurationError(
      "NOT_FOUND",
      "La configurazione operativa non è stata inizializzata.",
    );
  }

  return { ...configuration, settings: configuration.settings };
}

export async function updateRoom(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const input = parseInput(roomUpdateSchema, unsafeInput);
  const now = new Date();

  await runConfigurationTransaction(async (client) => {
    const current = ensureFound(
      await readRoomForRestaurant(client, actor.restaurantId, input.id),
    );
    const previousState = roomSnapshot(current);
    const requestedState = {
      ...previousState,
      displayOrder: input.displayOrder,
      isActive: input.isActive,
    };

    if (auditStatesEqual(previousState, requestedState)) return;
    ensureFound(
      (await writeRoomForRestaurant(client, actor.restaurantId, input)) || null,
    );
    const updated = ensureFound(
      await readRoomForRestaurant(client, actor.restaurantId, input.id),
    );
    await writeConfigurationAudit(client, {
      actor,
      action: "ROOM_UPDATED",
      entityType: "ROOM",
      entityId: updated.id,
      previousState,
      newState: roomSnapshot(updated),
      createdAt: now,
    });
  });
}

export async function updateDiningTable(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const input = parseInput(diningTableUpdateSchema, unsafeInput);
  const now = new Date();

  try {
    await runConfigurationTransaction(async (client) => {
      const current = ensureFound(
        await readDiningTableForRestaurant(
          client,
          actor.restaurantId,
          input.id,
        ),
      );
      const previousState = diningTableSnapshot(current);
      const requestedState = {
        ...previousState,
        name: input.name,
        minimumSeats: input.minimumSeats,
        maximumSeats: input.maximumSeats,
        displayOrder: input.displayOrder,
        isActive: input.isActive,
      };

      if (auditStatesEqual(previousState, requestedState)) return;
      ensureFound(
        (await writeDiningTableForRestaurant(
          client,
          actor.restaurantId,
          input,
        )) || null,
      );
      const updated = ensureFound(
        await readDiningTableForRestaurant(
          client,
          actor.restaurantId,
          input.id,
        ),
      );
      await writeConfigurationAudit(client, {
        actor,
        action: "DINING_TABLE_UPDATED",
        entityType: "DINING_TABLE",
        entityId: updated.id,
        previousState,
        newState: diningTableSnapshot(updated),
        createdAt: now,
      });
    });
  } catch (error) {
    handlePersistenceError(error);
  }
}

export async function updateWeeklySchedule(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const input = parseInput(weeklyScheduleUpdateSchema, unsafeInput);
  const now = new Date();

  await runConfigurationTransaction(async (client) => {
    const settings = await readBookingSettingsForRestaurant(
      client,
      actor.restaurantId,
    );
    if (!settings || settings.rollingWindowMinutes < input.slotIntervalMinutes) {
      throw new ConfigurationError(
        "VALIDATION",
        "La finestra mobile deve essere almeno pari all'intervallo degli slot.",
      );
    }

    const current = ensureFound(
      await readWeeklyScheduleForRestaurant(client, actor.restaurantId, input),
    );
    const previousState = weeklyScheduleSnapshot(current);
    const requestedState = {
      dayOfWeek: input.dayOfWeek,
      serviceType: input.serviceType,
      isEnabled: input.isEnabled,
      startTime: input.startTime,
      endTime: input.endTime,
      slotIntervalMinutes: input.slotIntervalMinutes,
    };

    if (auditStatesEqual(previousState, requestedState)) return;
    ensureFound(
      (await writeWeeklyScheduleForRestaurant(
        client,
        actor.restaurantId,
        input,
      )) || null,
    );
    const updated = ensureFound(
      await readWeeklyScheduleForRestaurant(client, actor.restaurantId, input),
    );
    await writeConfigurationAudit(client, {
      actor,
      action: "WEEKLY_SCHEDULE_UPDATED",
      entityType: "WEEKLY_SERVICE_SCHEDULE",
      entityId: updated.id,
      previousState,
      newState: weeklyScheduleSnapshot(updated),
      createdAt: now,
    });
  });
}

export async function updateBookingSettings(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const input = parseInput(bookingSettingsUpdateSchema, unsafeInput);
  const now = new Date();

  await runConfigurationTransaction(async (client) => {
    if (
      input.rollingWindowMinutes <
      (await largestSlotIntervalForRestaurant(client, actor.restaurantId))
    ) {
      throw new ConfigurationError(
        "VALIDATION",
        "La finestra mobile deve essere almeno pari all'intervallo degli slot.",
      );
    }

    const current = ensureFound(
      await readBookingSettingsForRestaurant(client, actor.restaurantId),
    );
    const previousState = bookingSettingsSnapshot(current);
    const requestedState = { ...input };

    if (auditStatesEqual(previousState, requestedState)) return;
    ensureFound(
      (await writeBookingSettingsForRestaurant(
        client,
        actor.restaurantId,
        input,
      )) || null,
    );
    const updated = ensureFound(
      await readBookingSettingsForRestaurant(client, actor.restaurantId),
    );
    await writeConfigurationAudit(client, {
      actor,
      action: "BOOKING_SETTINGS_UPDATED",
      entityType: "RESTAURANT_BOOKING_SETTINGS",
      entityId: actor.restaurantId,
      previousState,
      newState: bookingSettingsSnapshot(updated),
      createdAt: now,
    });
  });
}

export async function createSpecialDate(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const input = parseInput(specialDateInputSchema, unsafeInput);
  const now = new Date();

  try {
    await runConfigurationTransaction(async (client) => {
      const existing = await readSpecialDateByIdentity(
        client,
        actor.restaurantId,
        input,
      );

      if (existing && existing.archivedAt === null) {
        throw new ConfigurationError(
          "DUPLICATE",
          "Esiste già una configurazione con gli stessi dati.",
        );
      }

      if (existing) {
        const previousState = specialDateSnapshot(existing);
        ensureFound(
          (await writeSpecialDateForRestaurant(
            client,
            actor.restaurantId,
            { ...input, id: existing.id },
            null,
          )) || null,
        );
        const reactivated = ensureFound(
          await readSpecialDateForRestaurant(
            client,
            actor.restaurantId,
            existing.id,
          ),
        );
        await writeConfigurationAudit(client, {
          actor,
          action: "SPECIAL_DATE_REACTIVATED",
          entityType: "SPECIAL_DATE_OVERRIDE",
          entityId: existing.id,
          previousState,
          newState: specialDateSnapshot(reactivated),
          createdAt: now,
        });
        return;
      }

      const created = await createSpecialDateForRestaurant(
        client,
        actor.restaurantId,
        input,
      );
      await writeConfigurationAudit(client, {
        actor,
        action: "SPECIAL_DATE_CREATED",
        entityType: "SPECIAL_DATE_OVERRIDE",
        entityId: created.id,
        previousState: null,
        newState: specialDateSnapshot(created),
        createdAt: now,
      });
    });
  } catch (error) {
    handlePersistenceError(error);
  }
}

export async function updateSpecialDate(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const input = parseInput(specialDateInputSchema, unsafeInput);
  if (!input.id) {
    throw new ConfigurationError(
      "VALIDATION",
      "L'identificativo della data speciale è obbligatorio.",
    );
  }
  const id = input.id;
  const now = new Date();

  try {
    await runConfigurationTransaction(async (client) => {
      const current = ensureFound(
        await readSpecialDateForRestaurant(client, actor.restaurantId, id),
      );
      if (current.archivedAt !== null) {
        throw new ConfigurationError(
          "NOT_FOUND",
          "Una data archiviata deve essere ripristinata prima di modificarla.",
        );
      }
      const previousState = specialDateSnapshot(current);
      const requestedState = {
        date: input.date,
        scope: input.scope,
        isClosed: input.isClosed,
        specialStartTime: input.specialStartTime,
        specialEndTime: input.specialEndTime,
        specialCapacityCovers: input.specialCapacityCovers,
        operationalNotesPresent:
          input.operationalNotes !== null && input.operationalNotes.length > 0,
        archived: false,
      };

      if (auditStatesEqual(previousState, requestedState)) return;
      ensureFound(
        (await writeSpecialDateForRestaurant(
          client,
          actor.restaurantId,
          { ...input, id },
        )) || null,
      );
      const updated = ensureFound(
        await readSpecialDateForRestaurant(client, actor.restaurantId, id),
      );
      await writeConfigurationAudit(client, {
        actor,
        action: "SPECIAL_DATE_UPDATED",
        entityType: "SPECIAL_DATE_OVERRIDE",
        entityId: id,
        previousState,
        newState: specialDateSnapshot(updated),
        createdAt: now,
      });
    });
  } catch (error) {
    handlePersistenceError(error);
  }
}

async function setSpecialDateLifecycle(input: {
  actor: ConfigurationActor;
  unsafeInput: unknown;
  archived: boolean;
}): Promise<void> {
  requireAdminActor(input.actor);
  const { id } = parseInput(z.object({ id: z.uuid() }), input.unsafeInput);
  const now = new Date();

  await runConfigurationTransaction(async (client) => {
    const current = ensureFound(
      await readSpecialDateForRestaurant(
        client,
        input.actor.restaurantId,
        id,
      ),
    );

    if ((current.archivedAt !== null) === input.archived) return;
    const previousState = specialDateSnapshot(current);
    ensureFound(
      (await setSpecialDateArchivedState(
        client,
        input.actor.restaurantId,
        id,
        input.archived ? now : null,
      )) || null,
    );
    const updated = ensureFound(
      await readSpecialDateForRestaurant(
        client,
        input.actor.restaurantId,
        id,
      ),
    );
    await writeConfigurationAudit(client, {
      actor: input.actor,
      action: input.archived
        ? "SPECIAL_DATE_ARCHIVED"
        : "SPECIAL_DATE_REACTIVATED",
      entityType: "SPECIAL_DATE_OVERRIDE",
      entityId: id,
      previousState,
      newState: specialDateSnapshot(updated),
      createdAt: now,
    });
  });
}

export async function archiveSpecialDate(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  return setSpecialDateLifecycle({ actor, unsafeInput, archived: true });
}

export async function reactivateSpecialDate(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  return setSpecialDateLifecycle({ actor, unsafeInput, archived: false });
}
