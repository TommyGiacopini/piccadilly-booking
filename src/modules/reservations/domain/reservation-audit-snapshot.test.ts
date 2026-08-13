import { describe, expect, it } from "vitest";

import { reservationAuditSnapshot } from "@/modules/reservations/domain/reservation-audit-snapshot";
import type { StoredReservation } from "@/modules/reservations/domain/types";

function reservationFixture(
  overrides: Partial<StoredReservation> = {},
): StoredReservation {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    restaurantId: "10000000-0000-4000-8000-000000000002",
    localDate: "2099-12-20",
    serviceType: "DINNER",
    arrivalTime: "20:00",
    partySize: 4,
    status: "CONFIRMED",
    origin: "PUBLIC",
    customerFirstName: "Nome Sensibile",
    customerLastName: "Cognome Sensibile",
    customerPhone: "+39 000 000 1234",
    customerEmail: "sensitive@example.invalid",
    notes: "Nota fittizia da non copiare",
    preferences: JSON.stringify({
      roomCode: "sala-3",
      highChair: true,
      stroller: false,
      accessibility: true,
      children: true,
      celebration: "Ricorrenza fittizia da non copiare",
      animals: false,
    }),
    allergies: JSON.stringify({
      celiac: false,
      allergies: "Allergia fittizia da non copiare",
      intolerances: "Intolleranza fittizia da non copiare",
    }),
    privacyPolicyVersion: "demo-v1",
    privacyConsentAt: new Date("2099-01-01T10:00:00.000Z"),
    privacyConsentMethod: "WEB_CHECKBOX",
    termsPolicyVersion: "demo-terms-v1",
    termsConsentAt: new Date("2099-01-01T10:00:00.000Z"),
    termsConsentMethod: "WEB_CHECKBOX",
    consentLanguage: "it",
    createdByUserId: null,
    capacityOverride: false,
    capacityOverrideReason: null,
    createdAt: new Date("2099-01-01T10:00:00.000Z"),
    updatedAt: new Date("2099-01-01T10:00:00.000Z"),
    cancelledAt: null,
    version: 3,
    ...overrides,
  };
}

describe("canonical reservation audit snapshot", () => {
  it("keeps operational flags without PII or free-text request contents", () => {
    const reservation = reservationFixture();
    const snapshot = reservationAuditSnapshot(reservation);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot).toMatchObject({
      localDate: "2099-12-20",
      serviceType: "DINNER",
      partySize: 4,
      origin: "PUBLIC",
      version: 3,
      requests: {
        roomCode: "sala-3",
        highChair: true,
        accessibility: true,
        children: true,
        foodRequestsPresent: true,
        allergiesPresent: true,
        intolerancesPresent: true,
        celebrationPresent: true,
        notesPresent: true,
      },
    });
    for (const forbidden of [
      reservation.customerFirstName,
      reservation.customerLastName,
      reservation.customerPhone,
      reservation.customerEmail!,
      "Allergia fittizia da non copiare",
      "Intolleranza fittizia da non copiare",
      "Ricorrenza fittizia da non copiare",
      reservation.notes!,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("uses the same shape for public and authenticated origins", () => {
    const publicSnapshot = reservationAuditSnapshot(reservationFixture());
    const staffSnapshot = reservationAuditSnapshot(
      reservationFixture({
        origin: "PHONE",
        createdByUserId: "10000000-0000-4000-8000-000000000003",
        privacyConsentMethod: "VERBAL",
        termsPolicyVersion: null,
        termsConsentAt: null,
        termsConsentMethod: null,
        consentLanguage: null,
      }),
    );

    expect(Object.keys(staffSnapshot)).toEqual(Object.keys(publicSnapshot));
    expect(Object.keys(staffSnapshot.requests)).toEqual(
      Object.keys(publicSnapshot.requests),
    );
    expect(staffSnapshot.origin).toBe("PHONE");
  });

  it("does not alter the reservation while building before and after states", () => {
    const reservation = reservationFixture();
    const before = structuredClone(reservation);
    const previousState = reservationAuditSnapshot(reservation);
    const newState = reservationAuditSnapshot({
      ...reservation,
      partySize: 3,
      version: 4,
    });

    expect(reservation).toEqual(before);
    expect(previousState.partySize).toBe(4);
    expect(newState.partySize).toBe(3);
    expect(newState.version).toBe(4);
  });
});
