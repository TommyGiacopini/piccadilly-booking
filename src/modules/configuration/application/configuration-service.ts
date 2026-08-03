import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { ConfigurationError } from "@/modules/configuration/application/configuration-errors";
import {
  createSpecialDateForRestaurant,
  deleteSpecialDateForRestaurant,
  readOperationalConfiguration,
  updateBookingSettingsForRestaurant,
  updateDiningTableForRestaurant,
  updateRoomForRestaurant,
  updateSpecialDateForRestaurant,
  updateWeeklyScheduleForRestaurant,
} from "@/modules/configuration/infrastructure/configuration-repository";
import {
  bookingSettingsUpdateSchema,
  diningTableUpdateSchema,
  roomUpdateSchema,
  specialDateInputSchema,
  weeklyScheduleUpdateSchema,
} from "@/modules/configuration/domain/validation";
import { z } from "zod";

export interface ConfigurationActor {
  restaurantId: string;
  role: "ADMIN" | "STAFF";
}

function requireAdminActor(actor: ConfigurationActor): void {
  if (actor.role !== "ADMIN") {
    throw new ConfigurationError(
      "FORBIDDEN",
      "Solo un amministratore può modificare la configurazione.",
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

function ensureFound(found: boolean): void {
  if (!found) {
    throw new ConfigurationError(
      "NOT_FOUND",
      "La configurazione richiesta non è disponibile per questo ristorante.",
    );
  }
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

export async function getOperationalConfiguration(restaurantId: string) {
  const configuration = await readOperationalConfiguration(restaurantId);

  if (!configuration || !configuration.settings) {
    throw new ConfigurationError(
      "NOT_FOUND",
      "La configurazione operativa non è stata inizializzata.",
    );
  }

  return {
    ...configuration,
    settings: configuration.settings,
  };
}

export async function updateRoom(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const input = parseInput(roomUpdateSchema, unsafeInput);
  ensureFound(await updateRoomForRestaurant(actor.restaurantId, input));
}

export async function updateDiningTable(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const input = parseInput(diningTableUpdateSchema, unsafeInput);

  try {
    ensureFound(
      await updateDiningTableForRestaurant(actor.restaurantId, input),
    );
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
  const result = await updateWeeklyScheduleForRestaurant(
    actor.restaurantId,
    input,
  );

  if (result === "WINDOW_TOO_SHORT") {
    throw new ConfigurationError(
      "VALIDATION",
      "La finestra mobile deve essere almeno pari all'intervallo degli slot.",
    );
  }

  ensureFound(result === "UPDATED");
}

export async function updateBookingSettings(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const input = parseInput(bookingSettingsUpdateSchema, unsafeInput);
  const result = await updateBookingSettingsForRestaurant(
    actor.restaurantId,
    input,
  );

  if (result === "WINDOW_TOO_SHORT") {
    throw new ConfigurationError(
      "VALIDATION",
      "La finestra mobile deve essere almeno pari all'intervallo degli slot.",
    );
  }

  ensureFound(result === "UPDATED");
}

export async function createSpecialDate(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const input = parseInput(specialDateInputSchema, unsafeInput);

  try {
    await createSpecialDateForRestaurant(actor.restaurantId, input);
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

  try {
    ensureFound(
      await updateSpecialDateForRestaurant(actor.restaurantId, {
        ...input,
        id: input.id,
      }),
    );
  } catch (error) {
    handlePersistenceError(error);
  }
}

export async function deleteSpecialDate(
  actor: ConfigurationActor,
  unsafeInput: unknown,
): Promise<void> {
  requireAdminActor(actor);
  const { id } = parseInput(z.object({ id: z.uuid() }), unsafeInput);
  ensureFound(await deleteSpecialDateForRestaurant(actor.restaurantId, id));
}
