import { describe, expect, it } from "vitest";

import {
  phoneReservationSchema,
  staffUpdateReservationSchema,
} from "@/modules/reservations/domain/staff-validation";
import { canUseCapacityOverride } from "@/modules/reservations/domain/override";

function phonePayload(overrides: Record<string, unknown> = {}) {
  return {
    localDate: "2099-08-10",
    serviceType: "DINNER",
    arrivalTime: "19:00",
    partySize: 2,
    roomCode: "sala-1",
    customerFirstName: "Cliente",
    customerLastName: "Fittizio",
    customerPhone: "+39 000 000 0000",
    customerEmail: null,
    highChair: false,
    stroller: false,
    accessibility: false,
    children: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: null,
    verbalConsentConfirmed: true,
    capacityOverride: false,
    capacityOverrideReason: null,
    ...overrides,
  };
}

describe("M8 staff reservation validation", () => {
  it("requires an explicit verbal consent confirmation", () => {
    expect(
      phoneReservationSchema.safeParse(
        phonePayload({ verbalConsentConfirmed: false }),
      ).success,
    ).toBe(false);
  });

  it("does not accept client-controlled origin or consent metadata", () => {
    expect(
      phoneReservationSchema.safeParse(
        phonePayload({
          origin: "STAFF",
          createdByUserId: "00000000-0000-0000-0000-000000000000",
          actorRole: "ADMIN",
          privacyConsentMethod: "WEB_CHECKBOX",
          privacyPolicyVersion: "client-controlled",
          privacyConsentAt: "2099-08-10T10:00:00.000Z",
        }),
      ).success,
    ).toBe(false);
  });

  it("requires an override reason and a positive optimistic version", () => {
    expect(
      phoneReservationSchema.safeParse(
        phonePayload({ capacityOverride: true, capacityOverrideReason: "" }),
      ).success,
    ).toBe(false);
    const { verbalConsentConfirmed, ...updatePayload } = phonePayload();
    expect(verbalConsentConfirmed).toBe(true);
    expect(
      staffUpdateReservationSchema.safeParse({ ...updatePayload, version: 0 })
        .success,
    ).toBe(false);
  });

  it("allows explicit capacity override to both Staff and Admin", () => {
    expect(canUseCapacityOverride("STAFF", true)).toBe(true);
    expect(canUseCapacityOverride("ADMIN", true)).toBe(true);
  });
});
