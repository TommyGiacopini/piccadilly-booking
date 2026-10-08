import { describe, expect, it } from "vitest";

import {
  deriveManagementToken,
  hashManagementToken,
  isManagementToken,
} from "@/modules/reservations/domain/management-token";
import {
  isBeforeModificationCutoff,
  localReservationInstant,
  managementViewExpiry,
} from "@/modules/reservations/domain/management-time";
import {
  parsePublicAllergies,
  parsePublicPreferences,
  publicCreateReservationSchema,
  publicUpdateReservationSchema,
  serializePublicAllergies,
  serializePublicPreferences,
} from "@/modules/reservations/domain/public-validation";
import { hashPublicReservationRequest } from "@/modules/reservations/domain/public-idempotency";
import { phoneReservationSchema, staffUpdateReservationSchema } from "@/modules/reservations/domain/staff-validation";
import { createReservationSchema, serializedReservationEnvelopeSchema } from "@/modules/reservations/domain/validation";

const payload = {
  localDate: "2099-10-19",
  serviceType: "DINNER" as const,
  arrivalTime: "19:15",
  partySize: 2,
  childrenCount: 1,
  gameRoomPreference: true,
  customerFirstName: " Cliente ",
  customerLastName: " Fittizio ",
  customerPhone: " +39 000 000 0000 ",
  customerEmail: " TEST@EXAMPLE.INVALID ",
  highChair: true,
  stroller: false,
  accessibility: false,
  celiac: false,
  allergies: " Nessuna ",
  intolerances: "",
  celebration: " Demo ",
  animals: false,
  notes: " Nota fittizia ",
  language: "it" as const,
  privacyAccepted: true as const,
  termsAccepted: true as const,
};

describe("M7 public reservation domain", () => {
  it("separates bounded raw input from lossless internal JSON envelopes", () => {
    const exact = { ...payload, allergies: '"'.repeat(300), intolerances: "\\".repeat(300), notes: "N".repeat(1000) };
    const parsed = publicCreateReservationSchema.parse(exact);
    const envelope = serializePublicAllergies(parsed);
    expect(envelope).toHaveLength(1249);
    expect(serializedReservationEnvelopeSchema.parse(envelope)).toBe(envelope);
    expect(parsePublicAllergies(envelope)).toMatchObject({ allergies: exact.allergies, intolerances: exact.intolerances });
    const selection = Object.fromEntries(Object.entries(exact).filter(([key]) => !["customerFirstName", "customerLastName", "customerPhone", "customerEmail", "language", "privacyAccepted", "termsAccepted"].includes(key)));
    const phone = { ...exact, verbalConsentConfirmed: true, sendWhatsAppConfirmation: false };
    delete (phone as Partial<typeof exact>).language;
    delete (phone as Partial<typeof exact>).privacyAccepted;
    delete (phone as Partial<typeof exact>).termsAccepted;
    const staff = { ...phone, version: 1 };
    delete (staff as Partial<typeof phone>).verbalConsentConfirmed;
    delete (staff as Partial<typeof phone>).sendWhatsAppConfirmation;
    for (const [schema, input] of [[publicCreateReservationSchema, exact], [publicUpdateReservationSchema, selection], [phoneReservationSchema, phone], [staffUpdateReservationSchema, staff]] as const) {
      expect(schema.safeParse(input).success).toBe(true);
      for (const [field, value] of [["allergies", "A".repeat(301)], ["intolerances", "I".repeat(301)], ["notes", "N".repeat(1001)]] as const) {
        expect(schema.safeParse({ ...input, [field]: value }).success).toBe(false);
      }
      expect(schema.safeParse({ ...input, legacyText: "Client-owned history" }).success).toBe(false);
    }
    const raw = { localDate: parsed.localDate, serviceType: parsed.serviceType, arrivalTime: parsed.arrivalTime, partySize: parsed.partySize, origin: "PHONE", customerFirstName: parsed.customerFirstName, customerLastName: parsed.customerLastName, customerPhone: parsed.customerPhone, customerEmail: parsed.customerEmail, notes: parsed.notes, privacyConsentMethod: "VERBAL", preferences: "P".repeat(1000), allergies: "A".repeat(1000) };
    // The pre-structured raw schema is not widened into an unbounded request API.
    expect(createReservationSchema.safeParse(raw).success).toBe(true);
    expect(createReservationSchema.safeParse({ ...raw, preferences: "P".repeat(1001) }).success).toBe(false);
    expect(createReservationSchema.safeParse({ ...raw, allergies: "A".repeat(1001) }).success).toBe(false);
  });

  it("preserves persisted allergy history, raw no-op and creation hash representation", () => {
    const text = ('"\\\nX'.repeat(250));
    expect(text).toHaveLength(1000);
    const empty = { celiac: false, allergies: null, intolerances: null };
    expect(serializePublicAllergies(empty, text)).toBe(text);
    const desired = { ...empty, allergies: '"'.repeat(300), intolerances: "\\".repeat(300) };
    const injected = { ...desired, legacyText: "Injected" };
    const changed = serializePublicAllergies(injected, text);
    expect(parsePublicAllergies(changed).legacyText).toBe(text);
    expect(serializePublicAllergies(desired, changed)).toBe(changed);
    expect(serializePublicAllergies(empty)).toBe(JSON.stringify(empty));
    expect(JSON.parse(serializePublicAllergies(empty))).not.toHaveProperty("legacyText");
    const whitespace = "  Historical declaration\r\nSecond line  ";
    expect(serializePublicAllergies(empty, whitespace)).toBe(whitespace);
    expect(parsePublicAllergies(serializePublicAllergies({ ...empty, celiac: true }, whitespace)).legacyText).toBe(parsePublicAllergies(whitespace).legacyText);
  });

  it("normalizes a complete public payload and requires both consents", () => {
    const parsed = publicCreateReservationSchema.parse(payload);

    expect(parsed).toMatchObject({
      customerFirstName: "Cliente",
      customerLastName: "Fittizio",
      customerEmail: "test@example.invalid",
      intolerances: null,
    });
    expect(
      publicCreateReservationSchema.safeParse({
        ...payload,
        termsAccepted: false,
      }).success,
    ).toBe(false);
  });

  it("serializes and restores structured preferences without raw booleans in columns", () => {
    const parsed = publicCreateReservationSchema.parse(payload);
    expect(parsePublicPreferences(serializePublicPreferences(parsed))).toMatchObject({
      roomCode: "",
      highChair: true,
      children: true,
    });
    expect(parsePublicAllergies(serializePublicAllergies(parsed))).toEqual({
      celiac: false,
      allergies: "Nessuna",
      intolerances: null,
    });
  });

  it("preserves persisted structured legacy text across repeated structured updates without truncation", () => {
    const input = publicCreateReservationSchema.parse(payload);
    const text = "Preferenza storica sintetica — città\n".repeat(100);
    const original = JSON.stringify({ ...parsePublicPreferences(serializePublicPreferences(input)), legacyText: text }, null, 2);
    expect(serializePublicPreferences(input, original)).toBe(original);
    const updated = serializePublicPreferences({ ...input, childrenCount: 0, highChair: false }, original);
    expect(parsePublicPreferences(updated)).toMatchObject({ children: false, highChair: false });
    expect(parsePublicPreferences(updated).legacyText).toBe(text);
    const again = serializePublicPreferences({ ...input, celebration: "Demo aggiornata" }, updated);
    expect(parsePublicPreferences(again).legacyText).toBe(text);
    expect(JSON.parse(again).legacyText).toBe(text);
  });

  it("retains plain-text preferences byte-for-byte on equivalent state and preserves parsed text when state changes", () => {
    const plain = "  Richiesta storica sintetica\r\nSeconda riga  ";
    const previous = parsePublicPreferences(plain);
    const input = { ...previous, childrenCount: null };
    expect(serializePublicPreferences(input, plain)).toBe(plain);
    const changed = serializePublicPreferences({ ...input, highChair: true }, plain);
    expect(parsePublicPreferences(changed).legacyText).toBe(previous.legacyText);
    expect(parsePublicPreferences(changed).highChair).toBe(true);
    expect(serializePublicPreferences({ ...input, highChair: true }, changed)).toBe(changed);
  });

  it("does not create legacy text for new reservations or accept client-owned legacy text", () => {
    const input = publicCreateReservationSchema.parse(payload);
    expect(JSON.parse(serializePublicPreferences(input))).not.toHaveProperty("legacyText");
    expect(publicCreateReservationSchema.safeParse({ ...payload, legacyText: "Injected" }).success).toBe(false);
    const edit = Object.fromEntries(Object.entries(input).filter(([key]) => ![
      "customerFirstName", "customerLastName", "customerPhone", "customerEmail",
      "language", "privacyAccepted", "termsAccepted",
    ].includes(key)));
    // Public update is strict independently of creation and rejects historical fields.
    expect(publicUpdateReservationSchema.safeParse({ ...edit, legacyText: "Injected" }).success).toBe(false);
    const persisted = "Original historical synthetic request";
    const injected = { ...input, legacyText: "Injected" };
    expect(parsePublicPreferences(serializePublicPreferences(injected, persisted)).legacyText).toBe(persisted);
  });

  it("derives a stable 32-byte URL-safe token and stores only its hash", () => {
    const secret = "test-management-secret-with-at-least-32-characters";
    const token = deriveManagementToken(
      "00000000-0000-4000-8000-000000000701",
      secret,
    );

    expect(token).toHaveLength(43);
    expect(isManagementToken(token)).toBe(true);
    expect(hashManagementToken(token)).toHaveLength(64);
    expect(hashManagementToken(token)).not.toContain(token);
    expect(
      deriveManagementToken(
        "00000000-0000-4000-8000-000000000701",
        secret,
      ),
    ).toBe(token);
  });

  it("normalizes idempotency fingerprints", () => {
    const parsed = publicCreateReservationSchema.parse(payload);
    expect(hashPublicReservationRequest(parsed)).toBe(
      hashPublicReservationRequest({ ...parsed }),
    );
    expect(hashPublicReservationRequest({ ...parsed, partySize: 3 })).not.toBe(
      hashPublicReservationRequest(parsed),
    );
  });

  it("calculates Europe/Rome instant, link expiry and separate cutoff", () => {
    const arrival = localReservationInstant(
      "2099-10-19",
      "19:15",
      "Europe/Rome",
    );
    const expiry = managementViewExpiry({
      localDate: "2099-10-19",
      arrivalTime: "19:15",
      timezone: "Europe/Rome",
      durationHours: 24,
    });

    expect(expiry.getTime() - arrival.getTime()).toBe(86_400_000);
    expect(() =>
      managementViewExpiry({
        localDate: "2099-10-19",
        arrivalTime: "19:15",
        timezone: "Europe/Rome",
        durationHours: 25,
      }),
    ).toThrow("Invalid management-link duration.");
    expect(
      isBeforeModificationCutoff({
        now: localReservationInstant(
          "2099-10-19",
          "17:29",
          "Europe/Rome",
        ),
        localDate: "2099-10-19",
        serviceType: "DINNER",
        timezone: "Europe/Rome",
        lunchCutoff: "10:30",
        dinnerCutoff: "17:30",
      }),
    ).toBe(true);
    expect(
      isBeforeModificationCutoff({
        now: localReservationInstant(
          "2099-10-19",
          "17:30",
          "Europe/Rome",
        ),
        localDate: "2099-10-19",
        serviceType: "DINNER",
        timezone: "Europe/Rome",
        lunchCutoff: "10:30",
        dinnerCutoff: "17:30",
      }),
    ).toBe(false);
  });
});
