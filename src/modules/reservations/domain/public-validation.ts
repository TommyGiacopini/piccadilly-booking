import { z } from "zod";

import {
  isLocalDate,
  isOperationalTime,
} from "@/modules/configuration/domain/operational-time";
import { RESERVATION_TEXT_LIMITS, serializedReservationEnvelopeSchema } from "@/modules/reservations/domain/validation";
import { partyCompositionFields, validatePartyComposition } from "@/modules/reservations/domain/party-composition";

const normalizeRequiredText = (value: string) =>
  value.trim().replace(/\s+/gu, " ");

const optionalText = (maximumLength: number) =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) =>
      typeof value === "string"
        ? value.replace(/\r\n?/gu, "\n").trim() || null
        : null,
    )
    .pipe(z.string().max(maximumLength).nullable());

const requiredName = z
  .string()
  .transform(normalizeRequiredText)
  .pipe(z.string().min(1).max(RESERVATION_TEXT_LIMITS.customerName));

const customerPhone = z
  .string()
  .transform(normalizeRequiredText)
  .pipe(z.string().min(1).max(RESERVATION_TEXT_LIMITS.customerPhone));

const customerEmail = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) =>
    typeof value === "string" ? value.trim().toLowerCase() || null : null,
  )
  .pipe(
    z.union([
      z.null(),
      z.string().email().max(RESERVATION_TEXT_LIMITS.customerEmail),
    ]),
  );

const reservationSelection = {
  localDate: z.string().refine(isLocalDate),
  serviceType: z.enum(["LUNCH", "DINNER"]),
  arrivalTime: z.string().refine(isOperationalTime),
  partySize: z.number().int().positive(),
  roomCode: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/u),
  highChair: z.boolean(),
  stroller: z.boolean(),
  accessibility: z.boolean(),
  children: z.boolean(),
  celiac: z.boolean(),
  allergies: optionalText(300),
  intolerances: optionalText(300),
  celebration: optionalText(200),
  animals: z.boolean(),
  notes: optionalText(RESERVATION_TEXT_LIMITS.notes),
} as const;

// Frozen pre-Foundation representation: accepted by the service for replay only.
export const legacyPublicCreateReservationSchema = z
  .object({
    ...reservationSelection,
    customerFirstName: requiredName,
    customerLastName: requiredName,
    customerPhone,
    customerEmail,
    language: z.enum(["it", "en"]),
    privacyAccepted: z.literal(true),
    termsAccepted: z.literal(true),
  })
  .strict();

export const publicUpdateReservationSchema = z
  .object(reservationSelection)
  .omit({ roomCode: true, children: true })
  .extend(partyCompositionFields)
  .strict()
  .superRefine(validatePartyComposition);

export const publicCreateReservationSchema = legacyPublicCreateReservationSchema
  .omit({ roomCode: true, children: true })
  .extend(partyCompositionFields)
  .strict()
  .superRefine(validatePartyComposition)
  .refine((value) => value.childrenCount !== null, { path: ["childrenCount"], message: "Dichiara la composizione della prenotazione." });

export type PublicCreateReservationInput = z.infer<
  typeof publicCreateReservationSchema
>;
export type PublicUpdateReservationInput = z.infer<
  typeof publicUpdateReservationSchema
>;

export interface PublicPreferenceData {
  roomCode: string;
  highChair: boolean;
  stroller: boolean;
  accessibility: boolean;
  children: boolean;
  celebration: string | null;
  animals: boolean;
}

export interface PublicAllergyData {
  celiac: boolean;
  allergies: string | null;
  intolerances: string | null;
}

export interface ParsedPublicPreferenceData extends PublicPreferenceData {
  legacyText: string | null;
}

export interface ParsedPublicAllergyData extends PublicAllergyData {
  legacyText: string | null;
}

export function serializePublicPreferences(
  input: Omit<PublicPreferenceData, "roomCode" | "children"> &
    ({ childrenCount: number | null } | { roomCode: string; children: boolean }),
  previousPreferences: string | null = null,
): string {
  const previous = parsePublicPreferences(previousPreferences);
  const desired: PublicPreferenceData = {
    roomCode: "roomCode" in input ? input.roomCode : previous.roomCode,
    highChair: input.highChair,
    stroller: input.stroller,
    accessibility: input.accessibility,
    children: "children" in input ? input.children : input.childrenCount === null ? previous.children : input.childrenCount > 0,
    celebration: input.celebration,
    animals: input.animals,
  };
  // The persisted value, never the request, owns historical preference text.
  // Keep equivalent legacy/plain-text representations byte-identical for no-op.
  if (previousPreferences !== null &&
      (Object.keys(desired) as Array<keyof PublicPreferenceData>)
        .every((key) => desired[key] === previous[key])) {
    return previousPreferences;
  }
  return serializedReservationEnvelopeSchema.parse(JSON.stringify({
    ...desired,
    ...(previous.legacyText === null ? {} : { legacyText: previous.legacyText }),
  }));
}

export function serializePublicAllergies(
  input: PublicAllergyData,
  previousAllergies: string | null = null,
): string {
  const previous = parsePublicAllergies(previousAllergies);
  const desired: PublicAllergyData = {
    celiac: input.celiac,
    allergies: input.allergies,
    intolerances: input.intolerances,
  };
  // Historical health-related text is owned by persisted state, not the browser.
  if (previousAllergies !== null &&
      (Object.keys(desired) as Array<keyof PublicAllergyData>)
        .every((key) => desired[key] === previous[key])) {
    return previousAllergies;
  }
  return serializedReservationEnvelopeSchema.parse(JSON.stringify({
    ...desired,
    ...(previous.legacyText === null ? {} : { legacyText: previous.legacyText }),
  }));
}

function legacyText(value: string | null): string | null {
  const normalized = value?.replace(/\r\n?/gu, "\n").trim();
  return normalized || null;
}

function parsedWithLegacyText<T extends object>(
  value: T,
  legacy: string | null,
): T & { legacyText: string | null } {
  return Object.defineProperty(value, "legacyText", {
    value: legacy,
    enumerable: false,
    configurable: false,
    writable: false,
  }) as T & { legacyText: string | null };
}

export function parsePublicPreferences(
  value: string | null,
): ParsedPublicPreferenceData {
  try {
    const parsed = z
      .object({
        roomCode: z.string(),
        highChair: z.boolean(),
        stroller: z.boolean(),
        accessibility: z.boolean(),
        children: z.boolean(),
        celebration: z.string().nullable(),
        animals: z.boolean(),
        legacyText: z.string().nullable().optional(),
      })
      .safeParse(JSON.parse(value ?? "null") as unknown);

    if (parsed.success) {
      const { legacyText: storedLegacyText, ...structured } = parsed.data;
      return parsedWithLegacyText(structured, storedLegacyText ?? null);
    }
  } catch {
    // M6 stored free-form text. It remains readable but is never interpreted as JSON.
  }

  return parsedWithLegacyText({
    roomCode: "",
    highChair: false,
    stroller: false,
    accessibility: false,
    children: false,
    celebration: null,
    animals: false,
  }, legacyText(value));
}

export function parsePublicAllergies(
  value: string | null,
): ParsedPublicAllergyData {
  try {
    const parsed = z
      .object({
        celiac: z.boolean(),
        allergies: z.string().nullable(),
        intolerances: z.string().nullable(),
        legacyText: z.string().nullable().optional(),
      })
      .safeParse(JSON.parse(value ?? "null") as unknown);

    if (parsed.success) {
      const { legacyText: storedLegacyText, ...structured } = parsed.data;
      return parsedWithLegacyText(structured, storedLegacyText ?? null);
    }
  } catch {
    // M6 stored free-form text. Preserve it as a legacy declaration.
  }

  return parsedWithLegacyText({
    celiac: false,
    allergies: null,
    intolerances: null,
  }, legacyText(value));
}
