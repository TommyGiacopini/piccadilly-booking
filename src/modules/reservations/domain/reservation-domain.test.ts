import { describe, expect, it } from "vitest";

import {
  ReservationApplicationError,
  reservationErrorStatus,
} from "@/modules/reservations/application/reservation-errors";
import { countsTowardCapacity } from "@/modules/reservations/domain/counting";
import { toReservationDto } from "@/modules/reservations/domain/dto";
import {
  classifyIdempotencyRequest,
  hashIdempotencyKey,
  hashReservationRequest,
} from "@/modules/reservations/domain/idempotency";
import { canUseCapacityOverride } from "@/modules/reservations/domain/override";
import type {
  CreateReservationCommand,
  StoredReservation,
} from "@/modules/reservations/domain/types";
import { createReservationSchema } from "@/modules/reservations/domain/validation";
import { deriveAdvisoryLockKey } from "@/modules/reservations/infrastructure/reservation-locks";

function validPhonePayload(): Record<string, unknown> {
  return {
    localDate: "2099-12-20",
    serviceType: "DINNER",
    arrivalTime: "19:15",
    partySize: 4,
    origin: "PHONE",
    customerFirstName: "  Mario   Demo ",
    customerLastName: " Rossi  Test ",
    customerPhone: " +39 000 000 0000 ",
    customerEmail: " DEMO@EXAMPLE.INVALID ",
    notes: " Tavolo tranquillo ",
    preferences: " Sala 1 ",
    allergies: " Nessuna ",
    privacyConsentMethod: "VERBAL",
    capacityOverride: false,
    capacityOverrideReason: null,
  };
}

function validCommand(): CreateReservationCommand {
  return createReservationSchema.parse(validPhonePayload());
}

function storedReservation(): StoredReservation {
  return {
    id: "00000000-0000-4000-8000-000000000601",
    restaurantId: "00000000-0000-4000-8000-000000000001",
    localDate: "2099-12-20",
    serviceType: "DINNER",
    arrivalTime: "19:15",
    partySize: 4,
    status: "CONFIRMED",
    origin: "PHONE",
    customerFirstName: "Mario Demo",
    customerLastName: "Rossi Test",
    customerPhone: "+39 000 000 0000",
    customerEmail: "demo@example.invalid",
    notes: "Tavolo tranquillo",
    preferences: "Sala 1",
    allergies: "Nessuna",
    privacyPolicyVersion: "local-demo-v1",
    privacyConsentAt: new Date("2099-01-01T10:00:00.000Z"),
    privacyConsentMethod: "VERBAL",
    createdByUserId: "00000000-0000-4000-8000-000000000102",
    capacityOverride: false,
    capacityOverrideReason: null,
    createdAt: new Date("2099-01-01T10:00:00.000Z"),
    updatedAt: new Date("2099-01-01T10:00:00.000Z"),
    cancelledAt: null,
  };
}

describe("M6 reservation domain", () => {
  it("validates and prudently normalizes the required customer fields", () => {
    const result = createReservationSchema.parse(validPhonePayload());

    expect(result).toMatchObject({
      customerFirstName: "Mario Demo",
      customerLastName: "Rossi Test",
      customerPhone: "+39 000 000 0000",
      customerEmail: "demo@example.invalid",
    });
  });

  it("requires first and last name", () => {
    expect(
      createReservationSchema.safeParse({
        ...validPhonePayload(),
        customerFirstName: " ",
      }).success,
    ).toBe(false);
    expect(
      createReservationSchema.safeParse({
        ...validPhonePayload(),
        customerLastName: " ",
      }).success,
    ).toBe(false);
  });

  it("requires a phone without inventing a normalized value", () => {
    const missing = createReservationSchema.safeParse({
      ...validPhonePayload(),
      customerPhone: " ",
    });

    expect(missing.success).toBe(false);
    expect(validCommand().customerPhone).toBe("+39 000 000 0000");
  });

  it("accepts a missing email and validates a supplied email", () => {
    const missing = createReservationSchema.parse({
      ...validPhonePayload(),
      customerEmail: "",
    });
    const invalid = createReservationSchema.safeParse({
      ...validPhonePayload(),
      customerEmail: "not-an-email",
    });

    expect(missing.customerEmail).toBeNull();
    expect(invalid.success).toBe(false);
  });

  it.each([0, -1, 1.5])("rejects invalid party size %s", (partySize) => {
    expect(
      createReservationSchema.safeParse({
        ...validPhonePayload(),
        partySize,
      }).success,
    ).toBe(false);
  });

  it("rejects notes above the configured maximum", () => {
    expect(
      createReservationSchema.safeParse({
        ...validPhonePayload(),
        notes: "x".repeat(1001),
      }).success,
    ).toBe(false);
  });

  it("requires privacy and the method coherent with PHONE", () => {
    const missing = { ...validPhonePayload() };
    delete missing.privacyConsentMethod;

    expect(createReservationSchema.safeParse(missing).success).toBe(false);
    expect(
      createReservationSchema.safeParse({
        ...validPhonePayload(),
        privacyConsentMethod: "STAFF_RECORDED",
      }).success,
    ).toBe(false);
  });

  it("accepts STAFF only with STAFF_RECORDED consent", () => {
    const result = createReservationSchema.parse({
      ...validPhonePayload(),
      origin: "STAFF",
      privacyConsentMethod: "STAFF_RECORDED",
    });

    expect(result.origin).toBe("STAFF");
  });

  it("allows no override for STAFF and an explicit override only for ADMIN", () => {
    expect(canUseCapacityOverride("STAFF", false)).toBe(true);
    expect(canUseCapacityOverride("STAFF", true)).toBe(false);
    expect(canUseCapacityOverride("ADMIN", true)).toBe(true);
  });

  it("requires a bounded override reason", () => {
    expect(
      createReservationSchema.safeParse({
        ...validPhonePayload(),
        capacityOverride: true,
        capacityOverrideReason: "",
      }).success,
    ).toBe(false);
    expect(
      createReservationSchema.safeParse({
        ...validPhonePayload(),
        capacityOverride: true,
        capacityOverrideReason: "x".repeat(501),
      }).success,
    ).toBe(false);
  });

  it("counts CONFIRMED and excludes CANCELLED regardless of override", () => {
    expect(countsTowardCapacity("CONFIRMED")).toBe(true);
    expect(countsTowardCapacity("CANCELLED")).toBe(false);
  });

  it("derives deterministic hashes without retaining the raw key", () => {
    const command = validCommand();
    const keyHash = hashIdempotencyKey("restaurant-a", "raw-secret-key-123");

    expect(keyHash).toHaveLength(64);
    expect(keyHash).not.toContain("raw-secret-key-123");
    expect(hashIdempotencyKey("restaurant-a", "raw-secret-key-123")).toBe(
      keyHash,
    );
    expect(hashIdempotencyKey("restaurant-b", "raw-secret-key-123")).not.toBe(
      keyHash,
    );
    expect(hashReservationRequest(command)).toBe(
      hashReservationRequest({ ...command }),
    );
  });

  it("classifies same-key payload replay and conflict", () => {
    expect(classifyIdempotencyRequest("a", "a")).toBe("REPLAY");
    expect(classifyIdempotencyRequest("a", "b")).toBe("CONFLICT");
  });

  it("maps controlled errors to stable HTTP statuses", () => {
    const error = new ReservationApplicationError(
      "CAPACITY_EXCEEDED",
      "controlled",
    );

    expect(error.publicMessage).toBe("controlled");
    expect(reservationErrorStatus(error.code)).toBe(409);
    expect(reservationErrorStatus("SLOT_IN_PAST")).toBe(422);
  });

  it("builds a minimal DTO without auth, privacy, hash or restaurant fields", () => {
    const dto = toReservationDto(storedReservation());
    const serialized = JSON.stringify(dto);

    expect(dto.customer.firstName).toBe("Mario Demo");
    expect(serialized).not.toContain("restaurantId");
    expect(serialized).not.toContain("createdByUserId");
    expect(serialized).not.toContain("privacyPolicyVersion");
    expect(serialized).not.toContain("requestHash");
    expect(serialized).not.toContain("keyHash");
  });

  it("derives stable and isolated advisory lock keys", () => {
    const first = deriveAdvisoryLockKey("capacity", [
      "restaurant-a",
      "2099-12-20",
      "DINNER",
    ]);

    expect(
      deriveAdvisoryLockKey("capacity", [
        "restaurant-a",
        "2099-12-20",
        "DINNER",
      ]),
    ).toEqual(first);
    expect(
      deriveAdvisoryLockKey("capacity", [
        "restaurant-a",
        "2099-12-20",
        "LUNCH",
      ]),
    ).not.toEqual(first);
    expect(
      deriveAdvisoryLockKey("capacity", [
        "restaurant-b",
        "2099-12-20",
        "DINNER",
      ]),
    ).not.toEqual(first);
  });
});
