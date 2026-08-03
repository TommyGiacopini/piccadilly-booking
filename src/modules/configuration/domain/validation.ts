import { z } from "zod";

import {
  DAY_OF_WEEK_VALUES,
  FIXED_ROLLING_WINDOW_MINUTES,
  SERVICE_TYPE_VALUES,
  SPECIAL_DATE_SCOPE_VALUES,
} from "@/modules/configuration/domain/defaults";
import {
  isLocalDate,
  isOperationalTime,
  operationalTimeToMinutes,
} from "@/modules/configuration/domain/operational-time";

const uuidSchema = z.uuid("Identificativo non valido.");
const operationalTimeSchema = z
  .string()
  .refine(isOperationalTime, "Inserisci un orario valido nel formato HH:mm.");
const optionalOperationalTimeSchema = z
  .string()
  .transform((value) => value.trim())
  .transform((value) => (value === "" ? null : value))
  .refine(
    (value) => value === null || isOperationalTime(value),
    "Inserisci un orario valido nel formato HH:mm.",
  );
const formBooleanSchema = z
  .union([z.literal("on"), z.literal("true"), z.literal("1")])
  .transform(() => true)
  .optional()
  .default(false);
const positiveIntegerSchema = z.coerce
  .number()
  .int("Inserisci un numero intero.")
  .positive("Il valore deve essere positivo.");
const displayOrderSchema = z.coerce
  .number()
  .int("L'ordine deve essere un numero intero.")
  .min(0, "L'ordine non può essere negativo.");

export const roomUpdateSchema = z.object({
  id: uuidSchema,
  displayOrder: displayOrderSchema,
  isActive: formBooleanSchema,
});

export const diningTableUpdateSchema = z
  .object({
    id: uuidSchema,
    name: z.string().trim().min(1, "Il nome del tavolo è obbligatorio.").max(40),
    minimumSeats: positiveIntegerSchema,
    maximumSeats: positiveIntegerSchema,
    displayOrder: displayOrderSchema,
    isActive: formBooleanSchema,
  })
  .refine((value) => value.maximumSeats >= value.minimumSeats, {
    message: "I posti massimi non possono essere inferiori ai posti minimi.",
    path: ["maximumSeats"],
  });

export const weeklyScheduleUpdateSchema = z
  .object({
    id: uuidSchema,
    dayOfWeek: z.enum(DAY_OF_WEEK_VALUES),
    serviceType: z.enum(SERVICE_TYPE_VALUES),
    isEnabled: formBooleanSchema,
    startTime: operationalTimeSchema,
    endTime: operationalTimeSchema,
    slotIntervalMinutes: positiveIntegerSchema,
  })
  .refine(
    (value) =>
      operationalTimeToMinutes(value.startTime) <
      operationalTimeToMinutes(value.endTime),
    {
      message: "L'orario iniziale deve precedere quello finale.",
      path: ["endTime"],
    },
  );

export const bookingSettingsUpdateSchema = z.object({
  rollingCapacityCovers: positiveIntegerSchema,
  rollingWindowMinutes: z.coerce
    .number()
    .int()
    .refine((value) => value === FIXED_ROLLING_WINDOW_MINUTES, {
      message: `La finestra mobile resta fissa a ${FIXED_ROLLING_WINDOW_MINUTES} minuti nella prima versione.`,
    }),
  lunchModificationCutoff: operationalTimeSchema,
  dinnerModificationCutoff: operationalTimeSchema,
  fridayDinnerBookingCutoff: operationalTimeSchema,
  saturdayDinnerBookingCutoff: operationalTimeSchema,
});

export const specialDateInputSchema = z
  .object({
    id: uuidSchema.optional(),
    date: z.string().refine(isLocalDate, "Inserisci una data locale valida."),
    scope: z.enum(SPECIAL_DATE_SCOPE_VALUES),
    isClosed: formBooleanSchema,
    specialStartTime: optionalOperationalTimeSchema,
    specialEndTime: optionalOperationalTimeSchema,
    specialCapacityCovers: z
      .union([z.literal(""), positiveIntegerSchema])
      .transform((value) => (value === "" ? null : value)),
    operationalNotes: z
      .string()
      .trim()
      .max(500, "Le note non possono superare 500 caratteri.")
      .transform((value) => (value === "" ? null : value)),
  })
  .superRefine((value, context) => {
    const hasStart = value.specialStartTime !== null;
    const hasEnd = value.specialEndTime !== null;

    if (hasStart !== hasEnd) {
      context.addIssue({
        code: "custom",
        message: "Gli orari speciali devono essere indicati entrambi.",
        path: ["specialEndTime"],
      });
    }

    if (
      value.specialStartTime &&
      value.specialEndTime &&
      operationalTimeToMinutes(value.specialStartTime) >=
        operationalTimeToMinutes(value.specialEndTime)
    ) {
      context.addIssue({
        code: "custom",
        message: "L'orario speciale iniziale deve precedere quello finale.",
        path: ["specialEndTime"],
      });
    }

    if (
      value.isClosed &&
      (hasStart || hasEnd || value.specialCapacityCovers !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Una chiusura non può avere orari o capacità speciali.",
        path: ["isClosed"],
      });
    }
  });

export type RoomUpdateInput = z.infer<typeof roomUpdateSchema>;
export type DiningTableUpdateInput = z.infer<typeof diningTableUpdateSchema>;
export type WeeklyScheduleUpdateInput = z.infer<
  typeof weeklyScheduleUpdateSchema
>;
export type BookingSettingsUpdateInput = z.infer<
  typeof bookingSettingsUpdateSchema
>;
export type SpecialDateInput = z.infer<typeof specialDateInputSchema>;
