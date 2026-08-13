import { z } from "zod";

export const PUBLIC_CONTENT_LOCALES = ["IT", "EN"] as const;
export const PUBLIC_CONTENT_KEYS = [
  "BOOKING_PAGE_TITLE",
  "BOOKING_PAGE_INTRO",
  "UNAVAILABLE_MESSAGE",
  "CONTACT_PROMPT",
  "CONFIRMATION_MESSAGE",
  "MANAGEMENT_PAGE_TITLE",
  "MANAGEMENT_PAGE_INTRO",
] as const;

export type PublicContentLocale = (typeof PUBLIC_CONTENT_LOCALES)[number];
export type PublicContentKey = (typeof PUBLIC_CONTENT_KEYS)[number];

const titleKeys = new Set<PublicContentKey>([
  "BOOKING_PAGE_TITLE",
  "MANAGEMENT_PAGE_TITLE",
]);
const fingerprintSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/i, "Fingerprint non valido.");
const e164Schema = z
  .string()
  .regex(/^\+[0-9]{8,15}$/, "Usa il formato E.164, ad esempio +390000000000.")
  .max(16);

function optionalString<T extends z.ZodType<string>>(schema: T) {
  return z
    .union([schema, z.literal(""), z.null()])
    .transform((value) => (value === "" ? null : value));
}

function normalizeEmailDomain(value: string): string {
  const separator = value.lastIndexOf("@");
  return `${value.slice(0, separator)}@${value.slice(separator + 1).toLowerCase()}`;
}

const emailSchema = z
  .string()
  .max(254, "L'email non può superare 254 caratteri.")
  .email("L'email non è valida.")
  .transform(normalizeEmailDomain);

const publicBookingBaseUrlSchema = z
  .string()
  .max(255, "L'URL non può superare 255 caratteri.")
  .transform((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Inserisci un URL HTTPS assoluto." });
      return z.NEVER;
    }
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "L'URL deve essere HTTPS, senza credenziali, query, fragment o percorso.",
      });
      return z.NEVER;
    }
    url.hostname = url.hostname.toLowerCase();
    url.pathname = "/";
    const normalized = url.toString();
    if (normalized.length > 255) {
      context.addIssue({ code: "custom", message: "L'URL non può superare 255 caratteri." });
      return z.NEVER;
    }
    return normalized;
  });

export const publicContactsSchema = z.strictObject({
  publicPhone: e164Schema,
  publicBookingBaseUrl: publicBookingBaseUrlSchema,
  publicEmail: optionalString(emailSchema),
  whatsappNumber: optionalString(e164Schema),
});

function contentTextSchema(key: PublicContentKey) {
  const maximum = titleKeys.has(key) ? 120 : 1_000;
  return z.string().transform((value, context) => {
    const normalized = value.replaceAll("\r\n", "\n");
    const length = Array.from(normalized).length;
    if (length < 1 || length > maximum) {
      context.addIssue({
        code: "custom",
        message: `Il testo deve contenere da 1 a ${maximum} caratteri Unicode.`,
      });
      return z.NEVER;
    }
    if (/\p{Cc}/u.test(normalized.replaceAll("\n", ""))) {
      context.addIssue({
        code: "custom",
        message: "Il testo contiene caratteri di controllo non ammessi.",
      });
      return z.NEVER;
    }
    if (
      /(?:\b(?:https?|ftp|file|data|javascript|mailto|tel):|www\.)/iu.test(
        normalized,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "I contenuti editoriali non possono includere URL arbitrari.",
      });
      return z.NEVER;
    }
    return normalized;
  });
}

const localeContentSchema = z.strictObject({
  BOOKING_PAGE_TITLE: contentTextSchema("BOOKING_PAGE_TITLE"),
  BOOKING_PAGE_INTRO: contentTextSchema("BOOKING_PAGE_INTRO"),
  UNAVAILABLE_MESSAGE: contentTextSchema("UNAVAILABLE_MESSAGE"),
  CONTACT_PROMPT: contentTextSchema("CONTACT_PROMPT"),
  CONFIRMATION_MESSAGE: contentTextSchema("CONFIRMATION_MESSAGE"),
  MANAGEMENT_PAGE_TITLE: contentTextSchema("MANAGEMENT_PAGE_TITLE"),
  MANAGEMENT_PAGE_INTRO: contentTextSchema("MANAGEMENT_PAGE_INTRO"),
});

export const publicContentSetSchema = z.strictObject({
  IT: localeContentSchema,
  EN: localeContentSchema,
});

export const publicContactsMutationSchema = z.strictObject({
  fingerprint: fingerprintSchema,
  contacts: publicContactsSchema,
});

export const publicContentMutationSchema = z.strictObject({
  fingerprint: fingerprintSchema,
  contents: publicContentSetSchema,
});

export const managementLinkDurationMutationSchema = z.strictObject({
  fingerprint: fingerprintSchema,
  managementLinkDurationHours: z
    .number()
    .int("La durata deve essere un numero intero.")
    .min(1, "La durata minima è un'ora.")
    .max(24, "La durata massima è 24 ore."),
});

export function resolvePublicLocale(value: string | null | undefined): "it" | "en" {
  return value?.toLowerCase() === "en" ? "en" : "it";
}

export type PublicContacts = z.output<typeof publicContactsSchema>;
export type PublicContentSet = z.output<typeof publicContentSetSchema>;
export type PublicContactsMutation = z.output<typeof publicContactsMutationSchema>;
export type PublicContentMutation = z.output<typeof publicContentMutationSchema>;
export type ManagementLinkDurationMutation = z.output<
  typeof managementLinkDurationMutationSchema
>;
