import { z } from "zod";

import {
  isLocalDate,
  isOperationalTime,
} from "@/modules/configuration/domain/operational-time";
import {
  normalizePersonName,
  RESERVATION_TEXT_LIMITS,
} from "@/modules/reservations/domain/validation";

function requiredText(label: string, maximumLength: number) {
  return z
    .string({ error: `${label} è obbligatorio.` })
    .transform(normalizePersonName)
    .pipe(
      z
        .string()
        .min(1, `${label} è obbligatorio.`)
        .max(maximumLength, `${label} è troppo lungo.`),
    );
}

function optionalText(label: string, maximumLength: number) {
  return z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (typeof value !== "string") return null;
      return value.replace(/\r\n?/gu, "\n").trim() || null;
    })
    .pipe(
      z
        .string()
        .max(maximumLength, `${label} è troppo lungo.`)
        .nullable(),
    );
}

const email = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) =>
    typeof value === "string" ? value.trim().toLowerCase() || null : null,
  )
  .pipe(
    z.union([
      z.null(),
      z
        .string()
        .email("L'email non è valida.")
        .max(RESERVATION_TEXT_LIMITS.customerEmail, "L'email è troppo lunga."),
    ]),
  );

const operationalSelection = {
  localDate: z
    .string()
    .refine(isLocalDate, "La data deve essere valida e in formato YYYY-MM-DD."),
  serviceType: z.enum(["LUNCH", "DINNER"], {
    error: "Il servizio non è valido.",
  }),
  arrivalTime: z
    .string()
    .refine(isOperationalTime, "L'orario deve essere in formato HH:MM."),
  partySize: z
    .number({ error: "Il numero di persone è obbligatorio." })
    .int("Il numero di persone deve essere intero.")
    .positive("Il numero di persone deve essere positivo."),
  roomCode: z
    .string({ error: "La sala preferita è obbligatoria." })
    .trim()
    .min(1, "La sala preferita è obbligatoria.")
    .max(80, "La sala preferita non è valida.")
    .regex(/^[a-z0-9-]+$/u, "La sala preferita non è valida."),
  highChair: z.boolean(),
  stroller: z.boolean(),
  accessibility: z.boolean(),
  children: z.boolean(),
  celiac: z.boolean(),
  allergies: optionalText("Le allergie", 300),
  intolerances: optionalText("Le intolleranze", 300),
  celebration: optionalText("La ricorrenza", 200),
  animals: z.boolean(),
  notes: optionalText("Le note", RESERVATION_TEXT_LIMITS.notes),
} as const;

const customer = {
  customerFirstName: requiredText(
    "Il nome",
    RESERVATION_TEXT_LIMITS.customerName,
  ),
  customerLastName: requiredText(
    "Il cognome",
    RESERVATION_TEXT_LIMITS.customerName,
  ),
  customerPhone: requiredText(
    "Il telefono",
    RESERVATION_TEXT_LIMITS.customerPhone,
  ),
  customerEmail: email,
} as const;

const override = {
  capacityOverride: z.boolean().default(false),
  capacityOverrideReason: optionalText(
    "Il motivo dell'override",
    RESERVATION_TEXT_LIMITS.capacityOverrideReason,
  ),
} as const;

function validateOverride(
  value: { capacityOverride: boolean; capacityOverrideReason: string | null },
  context: z.RefinementCtx,
) {
  if (value.capacityOverride && !value.capacityOverrideReason) {
    context.addIssue({
      code: "custom",
      path: ["capacityOverrideReason"],
      message: "Il motivo dell'override è obbligatorio.",
    });
  }

  if (!value.capacityOverride && value.capacityOverrideReason) {
    context.addIssue({
      code: "custom",
      path: ["capacityOverrideReason"],
      message: "Il motivo è ammesso soltanto con override esplicito.",
    });
  }
}

export const phoneReservationSchema = z
  .object({
    ...operationalSelection,
    ...customer,
    ...override,
    verbalConsentConfirmed: z.literal(true, {
      error: "Conferma l'acquisizione del consenso verbale.",
    }),
  })
  .strict()
  .superRefine(validateOverride);

export const staffUpdateReservationSchema = z
  .object({
    ...operationalSelection,
    ...customer,
    ...override,
    version: z.number().int().positive(),
  })
  .strict()
  .superRefine(validateOverride);

export const staffCancelReservationSchema = z
  .object({ version: z.number().int().positive() })
  .strict();

export type PhoneReservationInput = z.infer<typeof phoneReservationSchema>;
export type StaffUpdateReservationInput = z.infer<
  typeof staffUpdateReservationSchema
>;
