import { describe, expect, it } from "vitest";
import { z } from "zod";
import { partyCompositionFields, validatePartyComposition, compositionChangeIsDeclared, partyCompositionLabel } from "./party-composition";
import { publicCreateReservationSchema, legacyPublicCreateReservationSchema, serializePublicPreferences } from "./public-validation";
import { phoneReservationSchema, legacyPhoneReservationSchema } from "./staff-validation";
import { hashPublicReservationRequest } from "./public-idempotency";
import { hashPhoneReservationRequest, hashLegacyPhoneReservationRequest } from "./idempotency";
import type { CreateReservationCommand } from "./types";

const schema = z.object({ partySize: z.number().int().positive(), ...partyCompositionFields }).strict().superRefine(validatePartyComposition);
const payload = { localDate: "2099-10-19", serviceType: "DINNER", arrivalTime: "19:00", partySize: 6, childrenCount: 2, gameRoomPreference: true, customerFirstName: "Test", customerLastName: "Foundation", customerPhone: "+390000001234", customerEmail: null, highChair: false, stroller: false, accessibility: false, celiac: false, allergies: null, intolerances: null, celebration: null, animals: false, notes: null };
const publicPayload = { ...payload, language: "it", privacyAccepted: true, termsAccepted: true };
const phonePayload = { ...payload, verbalConsentConfirmed: true, sendWhatsAppConfirmation: true, capacityOverride: false, capacityOverrideReason: null };

describe("Foundation A composition contract", () => {
  it.each([[null, null], [0, null], [1, false], [6, true]])("accepts coherent count %s / preference %s", (childrenCount, gameRoomPreference) => {
    expect(schema.safeParse({ partySize: 6, childrenCount, gameRoomPreference }).success).toBe(true);
  });
  it.each([[null, true], [null, false], [0, true], [0, false], [1, null], [7, true], [-1, false], [1.5, true]])("rejects incoherent count %s / preference %s", (childrenCount, gameRoomPreference) => {
    expect(schema.safeParse({ partySize: 6, childrenCount, gameRoomPreference }).success).toBe(false);
  });
  it("requires declaration for new Public but allows explicit PHONE unknown", () => {
    expect(publicCreateReservationSchema.safeParse({ ...publicPayload, childrenCount: null, gameRoomPreference: null }).success).toBe(false);
    expect(phoneReservationSchema.parse({ ...phonePayload, childrenCount: null, gameRoomPreference: null })).toMatchObject({ childrenCount: null, gameRoomPreference: null });
  });
  it("rejects a second client children/physical-room truth", () => {
    expect(publicCreateReservationSchema.safeParse({ ...publicPayload, children: false }).success).toBe(false);
    expect(phoneReservationSchema.safeParse({ ...phonePayload, roomCode: "sala-3" }).success).toBe(false);
    expect(serializePublicPreferences(publicCreateReservationSchema.parse(publicPayload))).toContain('"children":true');
  });
  it("preserves unknown only for unrelated edits, not a change to total covers", () => {
    const unknown = { partySize: 6, childrenCount: null, gameRoomPreference: null };
    expect(compositionChangeIsDeclared(unknown, unknown)).toBe(true);
    expect(compositionChangeIsDeclared(unknown, { ...unknown, partySize: 7 })).toBe(false);
    expect(compositionChangeIsDeclared(unknown, { partySize: 7, childrenCount: 0, gameRoomPreference: null })).toBe(true);
    expect(compositionChangeIsDeclared({ ...unknown, childrenCount: 0 }, unknown)).toBe(false);
  });
  it("includes both fields in Public and PHONE hashes and retains a separate legacy representation", () => {
    const current = publicCreateReservationSchema.parse(publicPayload);
    expect(hashPublicReservationRequest(current)).not.toBe(hashPublicReservationRequest({ ...current, childrenCount: 3 }));
    expect(hashPublicReservationRequest(current)).not.toBe(hashPublicReservationRequest({ ...current, gameRoomPreference: false }));
    const command: CreateReservationCommand = { ...payload, serviceType: "DINNER", origin: "PHONE", preferences: serializePublicPreferences(current), allergies: null, privacyConsentMethod: "VERBAL", capacityOverride: false, capacityOverrideReason: null };
    expect(hashPhoneReservationRequest(command, true)).not.toBe(hashPhoneReservationRequest({ ...command, childrenCount: 3 }, true));
    expect(hashPhoneReservationRequest(command, true)).not.toBe(hashPhoneReservationRequest({ ...command, gameRoomPreference: false }, true));
    expect(hashLegacyPhoneReservationRequest(command, true)).toBe(hashLegacyPhoneReservationRequest({ ...command, childrenCount: null, gameRoomPreference: null }, true));
    const { childrenCount, gameRoomPreference, ...old } = publicPayload;
    expect(childrenCount).toBe(2); expect(gameRoomPreference).toBe(true);
    const legacy = legacyPublicCreateReservationSchema.parse({ ...old, roomCode: "sala-3", children: true });
    expect(hashPublicReservationRequest(legacy)).not.toBe(hashPublicReservationRequest(current));
    const { language, privacyAccepted, termsAccepted, ...oldPhone } = legacy;
    expect(language).toBe("it"); expect(privacyAccepted && termsAccepted).toBe(true);
    expect(legacyPhoneReservationSchema.safeParse({ ...oldPhone, verbalConsentConfirmed: true, sendWhatsAppConfirmation: true }).success).toBe(true);
  });
  it("labels total covers without interpreting legacy as adults or games as assignment", () => {
    expect(partyCompositionLabel({ partySize: 6, childrenCount: null, gameRoomPreference: null })).toBe("6 coperti · composizione non specificata");
    expect(partyCompositionLabel({ partySize: 6, childrenCount: 0, gameRoomPreference: null })).toBe("6 coperti · tutti adulti");
    expect(partyCompositionLabel({ partySize: 6, childrenCount: 2, gameRoomPreference: true })).toBe("6 coperti · 2 bambini");
  });
});
