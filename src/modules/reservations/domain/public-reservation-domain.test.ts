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
  serializePublicAllergies,
  serializePublicPreferences,
} from "@/modules/reservations/domain/public-validation";
import { hashPublicReservationRequest } from "@/modules/reservations/domain/public-idempotency";

const payload = {
  localDate: "2099-10-19",
  serviceType: "DINNER" as const,
  arrivalTime: "19:15",
  partySize: 2,
  roomCode: "sala-1",
  customerFirstName: " Cliente ",
  customerLastName: " Fittizio ",
  customerPhone: " +39 000 000 0000 ",
  customerEmail: " TEST@EXAMPLE.INVALID ",
  highChair: true,
  stroller: false,
  accessibility: false,
  children: true,
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
      roomCode: "sala-1",
      highChair: true,
      children: true,
    });
    expect(parsePublicAllergies(serializePublicAllergies(parsed))).toEqual({
      celiac: false,
      allergies: "Nessuna",
      intolerances: null,
    });
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
