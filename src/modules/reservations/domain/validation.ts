import { z } from "zod";

import {
  isLocalDate,
  isOperationalTime,
} from "@/modules/configuration/domain/operational-time";
import {
  PRIVACY_CONSENT_METHODS,
  RESERVATION_ORIGINS,
} from "@/modules/reservations/domain/types";

export const RESERVATION_TEXT_LIMITS = {
  customerName: 80,
  customerPhone: 40,
  customerEmail: 254,
  notes: 1000,
  preferences: 1000,
  allergies: 1000,
  capacityOverrideReason: 500,
  idempotencyKey: 200,
} as const;

export function normalizePersonName(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t ]+/gu, " ")
    .trim();

  return normalized || null;
}

function requiredNormalizedString(label: string, maximumLength: number) {
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
    .transform(normalizeOptionalText)
    .pipe(
      z
        .string()
        .max(maximumLength, `${label} è troppo lungo.`)
        .nullable(),
    );
}

const optionalEmailSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (typeof value !== "string") {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    return normalized || null;
  })
  .pipe(
    z.union([
      z.null(),
      z
        .string()
        .max(
          RESERVATION_TEXT_LIMITS.customerEmail,
          "L'email è troppo lunga.",
        )
        .email("L'email non è valida."),
    ]),
  );

export const createReservationSchema = z
  .object({
    localDate: z
      .string()
      .refine(
        isLocalDate,
        "La data deve essere valida e nel formato YYYY-MM-DD.",
      ),
    serviceType: z.enum(["LUNCH", "DINNER"], {
      error: "Il servizio deve essere LUNCH o DINNER.",
    }),
    arrivalTime: z
      .string()
      .refine(isOperationalTime, "L'orario deve essere nel formato HH:MM."),
    partySize: z
      .number({ error: "Il numero di coperti è obbligatorio." })
      .int("Il numero di coperti deve essere un intero positivo.")
      .positive("Il numero di coperti deve essere un intero positivo."),
    origin: z.enum(RESERVATION_ORIGINS, {
      error: "L'origine deve essere STAFF o PHONE.",
    }),
    customerFirstName: requiredNormalizedString(
      "Il nome",
      RESERVATION_TEXT_LIMITS.customerName,
    ),
    customerLastName: requiredNormalizedString(
      "Il cognome",
      RESERVATION_TEXT_LIMITS.customerName,
    ),
    customerPhone: z
      .string({ error: "Il telefono è obbligatorio." })
      .transform((value) => value.trim().replace(/\s+/gu, " "))
      .pipe(
        z
          .string()
          .min(1, "Il telefono è obbligatorio.")
          .max(
            RESERVATION_TEXT_LIMITS.customerPhone,
            "Il telefono è troppo lungo.",
          ),
      ),
    customerEmail: optionalEmailSchema,
    notes: optionalText("Le note", RESERVATION_TEXT_LIMITS.notes),
    preferences: optionalText(
      "Le preferenze",
      RESERVATION_TEXT_LIMITS.preferences,
    ),
    allergies: optionalText(
      "Le allergie",
      RESERVATION_TEXT_LIMITS.allergies,
    ),
    privacyConsentMethod: z.enum(PRIVACY_CONSENT_METHODS, {
      error: "Il metodo di consenso privacy è obbligatorio.",
    }),
    capacityOverride: z.boolean().default(false),
    capacityOverrideReason: optionalText(
      "Il motivo dell'override",
      RESERVATION_TEXT_LIMITS.capacityOverrideReason,
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedMethod =
      value.origin === "PHONE" ? "VERBAL" : "STAFF_RECORDED";

    if (value.privacyConsentMethod !== expectedMethod) {
      context.addIssue({
        code: "custom",
        path: ["privacyConsentMethod"],
        message:
          value.origin === "PHONE"
            ? "Una prenotazione PHONE richiede consenso VERBAL."
            : "Una prenotazione STAFF richiede consenso STAFF_RECORDED.",
      });
    }

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
  });

export const idempotencyKeySchema = z
  .string({ error: "L'header Idempotency-Key è obbligatorio." })
  .min(16, "L'header Idempotency-Key non è valido.")
  .max(
    RESERVATION_TEXT_LIMITS.idempotencyKey,
    "L'header Idempotency-Key non è valido.",
  )
  .regex(/^[\x21-\x7e]+$/u, "L'header Idempotency-Key non è valido.");

export type CreateReservationRequest = z.infer<
  typeof createReservationSchema
>;
