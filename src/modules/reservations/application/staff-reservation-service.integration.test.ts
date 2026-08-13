import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDashboardDay } from "@/modules/dashboard/application/dashboard-query";
import {
  DAY_OF_WEEK_VALUES,
  DEFAULT_BOOKING_CUTOFFS,
  DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
  DEFAULT_SERVICE_TIMES,
  DEFAULT_SLOT_INTERVAL_MINUTES,
  FIXED_ROLLING_WINDOW_MINUTES,
  SERVICE_TYPE_VALUES,
} from "@/modules/configuration/domain/defaults";
import {
  localDateToDatabase,
  operationalTimeToDatabase,
} from "@/modules/configuration/domain/operational-time";
import { ReservationApplicationError } from "@/modules/reservations/application/reservation-errors";
import {
  cancelManagedPublicReservation,
  createPublicReservation,
  readPublicReservation,
} from "@/modules/reservations/application/public-reservation-service";
import {
  cancelStaffReservation,
  createPhoneReservation,
  updateStaffReservation,
} from "@/modules/reservations/application/staff-reservation-service";
import { managementViewExpiry } from "@/modules/reservations/domain/management-time";
import {
  parsePublicAllergies,
  parsePublicPreferences,
} from "@/modules/reservations/domain/public-validation";
import { prisma } from "@/server/db/prisma";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const staffId = randomUUID();
const adminId = randomUUID();
const otherStaffId = randomUUID();
const roomId = randomUUID();
const otherRoomId = randomUUID();
const standardDate = "2099-08-10";
const movedDate = "2099-08-11";
const concurrencyDate = "2099-08-12";
const cancellationDate = "2099-08-13";
const overrideDate = "2099-08-14";
const publicDate = "2099-08-15";
const publicMovedDate = "2099-08-16";
const now = new Date("2099-01-10T10:00:00.000Z");
const managementSecret = "m8-public-management-secret-with-at-least-32-characters";
const config = {
  privacyPolicyVersion: "m8-test-privacy-v1",
  termsVersion: "m8-test-terms-v1",
  idempotencyTtlMs: 86_400_000,
};

const staffActor = { id: staffId, restaurantId, role: "STAFF" } as const;
const adminActor = { id: adminId, restaurantId, role: "ADMIN" } as const;
const otherStaffActor = {
  id: otherStaffId,
  restaurantId: otherRestaurantId,
  role: "STAFF",
} as const;

function bookingSettingsData(capacity = 4) {
  return {
    rollingCapacityCovers: capacity,
    rollingWindowMinutes: FIXED_ROLLING_WINDOW_MINUTES,
    lunchModificationCutoff: operationalTimeToDatabase(
      DEFAULT_BOOKING_CUTOFFS.lunchModificationCutoff,
    ),
    dinnerModificationCutoff: operationalTimeToDatabase(
      DEFAULT_BOOKING_CUTOFFS.dinnerModificationCutoff,
    ),
    managementLinkDurationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
  };
}

function weeklySchedules(targetRestaurantId: string) {
  return DAY_OF_WEEK_VALUES.flatMap((dayOfWeek) =>
    SERVICE_TYPE_VALUES.map((serviceType) => ({
      restaurantId: targetRestaurantId,
      dayOfWeek,
      serviceType,
      isEnabled: true,
      startTime: operationalTimeToDatabase(
        DEFAULT_SERVICE_TIMES[serviceType].startTime,
      ),
      endTime: operationalTimeToDatabase(
        DEFAULT_SERVICE_TIMES[serviceType].endTime,
      ),
      slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
    })),
  );
}

function phonePayload(overrides: Record<string, unknown> = {}) {
  return {
    localDate: standardDate,
    serviceType: "DINNER",
    arrivalTime: "19:00",
    partySize: 2,
    roomCode: "sala-m8",
    customerFirstName: "Cliente",
    customerLastName: "Telefonico Fittizio",
    customerPhone: "+39 000 000 0800",
    customerEmail: "m8@example.invalid",
    highChair: true,
    stroller: false,
    accessibility: false,
    children: true,
    celiac: false,
    allergies: "Dato fittizio",
    intolerances: null,
    celebration: null,
    animals: false,
    notes: "Nota esclusivamente fittizia M8",
    verbalConsentConfirmed: true,
    capacityOverride: false,
    capacityOverrideReason: null,
    ...overrides,
  };
}

function createPhone(
  actor: typeof staffActor | typeof adminActor | typeof otherStaffActor,
  overrides: Record<string, unknown> = {},
  key = randomUUID(),
) {
  return createPhoneReservation({
    actor,
    rawPayload: phonePayload(
      actor.restaurantId === otherRestaurantId
        ? { roomCode: "sala-m8-other", ...overrides }
        : overrides,
    ),
    rawIdempotencyKey: key,
    now,
    config,
  });
}

function updatePayload(
  reservation: Awaited<ReturnType<typeof createPhone>>["reservation"],
  overrides: Record<string, unknown> = {},
) {
  return {
    version: reservation.version,
    localDate: reservation.localDate,
    serviceType: reservation.serviceType,
    arrivalTime: reservation.arrivalTime,
    partySize: reservation.partySize,
    roomCode: reservation.roomCode,
    customerFirstName: reservation.customer.firstName,
    customerLastName: reservation.customer.lastName,
    customerPhone: reservation.customer.phone,
    customerEmail: reservation.customer.email,
    highChair: reservation.highChair,
    stroller: reservation.stroller,
    accessibility: reservation.accessibility,
    children: reservation.children,
    celiac: reservation.celiac,
    allergies: reservation.allergies,
    intolerances: reservation.intolerances,
    celebration: reservation.celebration,
    animals: reservation.animals,
    notes: reservation.notes,
    capacityOverride: false,
    capacityOverrideReason: null,
    ...overrides,
  };
}

function publicPayload(overrides: Record<string, unknown> = {}) {
  return {
    localDate: publicDate,
    serviceType: "DINNER",
    arrivalTime: "19:15",
    partySize: 2,
    roomCode: "sala-m8",
    customerFirstName: "Cliente",
    customerLastName: "Pubblico Fittizio",
    customerPhone: "+39 000 000 0801",
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
    language: "it",
    privacyAccepted: true,
    termsAccepted: true,
    ...overrides,
  };
}

describe.sequential("M8 Staff reservation workflow with real PostgreSQL", () => {
  beforeAll(async () => {
    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "M8 Demo", timezone: "Europe/Rome" },
        {
          id: otherRestaurantId,
          name: "M8 Other Demo",
          timezone: "Europe/Rome",
        },
      ],
    });
    await prisma.restaurantBookingSettings.createMany({
      data: [
        { restaurantId, ...bookingSettingsData() },
        { restaurantId: otherRestaurantId, ...bookingSettingsData() },
      ],
    });
    await prisma.weeklyServiceSchedule.createMany({
      data: [
        ...weeklySchedules(restaurantId),
        ...weeklySchedules(otherRestaurantId),
      ],
    });
    await prisma.room.createMany({
      data: [
        {
          id: roomId,
          restaurantId,
          code: "sala-m8",
          name: "Sala M8",
          displayOrder: 1,
          isActive: true,
        },
        {
          id: otherRoomId,
          restaurantId: otherRestaurantId,
          code: "sala-m8-other",
          name: "Sala M8 Other",
          displayOrder: 1,
          isActive: true,
        },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: staffId,
          restaurantId,
          username: `m8.staff.${restaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m8-tests",
          role: "STAFF",
        },
        {
          id: adminId,
          restaurantId,
          username: `m8.admin.${restaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m8-tests",
          role: "ADMIN",
        },
        {
          id: otherStaffId,
          restaurantId: otherRestaurantId,
          username: `m8.other.${otherRestaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m8-tests",
          role: "STAFF",
        },
      ],
    });
  });

  beforeEach(async () => {
    await prisma.reservationAuditEvent.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservation.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.serviceRoomAvailability.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.serviceInstance.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurantBookingSettings.update({
      where: { restaurantId },
      data: {
        managementLinkDurationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
      },
    });
  });

  afterAll(async () => {
    await prisma.reservationAuditEvent.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservation.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.serviceRoomAvailability.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.serviceInstance.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.session.deleteMany({
      where: { userId: { in: [staffId, adminId, otherStaffId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [staffId, adminId, otherStaffId] } },
    });
    await prisma.restaurant.deleteMany({
      where: { id: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.$disconnect();
  });

  it("has the authenticated audit constraints, foreign key and index applied", async () => {
    const metadata = await prisma.$queryRaw<
      Array<{ constraints: bigint; indexes: bigint }>
    >`
      SELECT
        (
          SELECT COUNT(*)
          FROM pg_constraint
          WHERE conname IN (
            'reservation_audit_events_actor_check',
            'reservation_audit_events_override_check',
            'reservation_audit_events_actor_user_id_fkey'
          )
        ) AS constraints,
        (
          SELECT COUNT(*)
          FROM pg_indexes
          WHERE indexname = 'reservation_audit_events_actor_created_idx'
        ) AS indexes
    `;

    expect(metadata[0]).toEqual({ constraints: BigInt(3), indexes: BigInt(1) });
  });

  it("creates an idempotent PHONE reservation with canonical requests and authenticated audit", async () => {
    const key = randomUUID();
    const first = await createPhone(staffActor, {}, key);
    const replay = await createPhone(staffActor, {}, key);
    const stored = await prisma.reservation.findUniqueOrThrow({
      where: { id: first.reservation.id },
    });
    const audit = await prisma.reservationAuditEvent.findFirstOrThrow({
      where: { reservationId: stored.id, action: "CREATED" },
    });

    expect(replay.replayed).toBe(true);
    expect(replay.reservation.id).toBe(first.reservation.id);
    await expect(
      createPhone(staffActor, { partySize: 3 }, key),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(stored.origin).toBe("PHONE");
    expect(stored.privacyConsentMethod).toBe("VERBAL");
    expect(stored.privacyPolicyVersion).toBe(config.privacyPolicyVersion);
    expect(stored.privacyConsentAt).toEqual(now);
    expect(stored.createdByUserId).toBe(staffId);
    expect(parsePublicPreferences(stored.preferences).highChair).toBe(true);
    expect(parsePublicAllergies(stored.allergies).allergies).toBe(
      "Dato fittizio",
    );
    expect(audit).toMatchObject({
      actorOrigin: "PHONE",
      actorUserId: staffId,
      actorRole: "STAFF",
      capacityOverride: false,
      createdAt: now,
    });
    const auditState = JSON.stringify(audit.newState);
    expect(auditState).not.toContain("+39 000 000 0800");
    expect(auditState).not.toContain("m8@example.invalid");
    expect(auditState).not.toContain("Dato fittizio");
    expect(auditState).not.toContain("Nota esclusivamente fittizia M8");
    expect(await prisma.reservation.count({ where: { restaurantId } })).toBe(1);
  });

  it("rolls back PHONE materialization, reservation, idempotency and audit when the final audit fails", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION m9d_test_reject_phone_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.restaurant_id = '${restaurantId}'::uuid AND NEW.action = 'CREATED' THEN
          RAISE EXCEPTION 'synthetic M9-D phone audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER m9d_test_reject_phone_audit_trigger
      BEFORE INSERT ON reservation_audit_events
      FOR EACH ROW EXECUTE FUNCTION m9d_test_reject_phone_audit();
    `);

    try {
      await expect(createPhone(staffActor)).rejects.toThrow(
        "synthetic M9-D phone audit failure",
      );
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS m9d_test_reject_phone_audit_trigger ON reservation_audit_events",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS m9d_test_reject_phone_audit()",
      );
    }

    await expect(
      prisma.serviceInstance.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.serviceRoomAvailability.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.reservation.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.reservationIdempotencyKey.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.reservationAuditEvent.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
  });

  it("requires verbal consent and rolls the idempotency record back on failure", async () => {
    const beforeKeys = await prisma.reservationIdempotencyKey.count({
      where: { restaurantId },
    });

    await expect(
      createPhone(staffActor, { verbalConsentConfirmed: false }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    expect(await prisma.reservation.count({ where: { restaurantId } })).toBe(0);
    expect(
      await prisma.reservationIdempotencyKey.count({ where: { restaurantId } }),
    ).toBe(beforeKeys);
    expect(
      await prisma.reservationAuditEvent.count({ where: { restaurantId } }),
    ).toBe(0);
  });

  it("isolates the daily dashboard by restaurant and applies filters", async () => {
    await createPhone(staffActor);
    await createPhone(otherStaffActor);
    const dashboard = await getDashboardDay({
      restaurantId,
      rawDate: standardDate,
      rawService: "DINNER",
      rawStatus: "CONFIRMED",
      rawOrigin: "PHONE",
      now,
    });

    expect(dashboard.reservations).toHaveLength(1);
    expect(dashboard.summary.confirmedReservations).toBe(1);
    expect(dashboard.reservations[0]?.customerLastName).toBe(
      "Telefonico Fittizio",
    );
  });

  it("rejects cross-restaurant Staff updates and cancellations", async () => {
    const created = await createPhone(staffActor);

    await expect(
      updateStaffReservation({
        actor: otherStaffActor,
        reservationId: created.reservation.id,
        rawPayload: updatePayload(created.reservation),
        now,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      cancelStaffReservation({
        actor: otherStaffActor,
        reservationId: created.reservation.id,
        rawPayload: { version: created.reservation.version },
        now,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: created.reservation.id },
        select: { status: true, version: true },
      }),
    ).toEqual({ status: "CONFIRMED", version: 1 });
  });

  it("allows capacity override to Staff and Admin only when capacity is exceeded", async () => {
    const staffOverride = await createPhone(staffActor, {
      localDate: overrideDate,
      partySize: 5,
      capacityOverride: true,
      capacityOverrideReason: "Autorizzazione fittizia Staff",
    });
    const adminOverride = await createPhone(adminActor, {
      localDate: movedDate,
      partySize: 5,
      capacityOverride: true,
      capacityOverrideReason: "Autorizzazione fittizia Admin",
    });

    expect(staffOverride.reservation.override.applied).toBe(true);
    expect(adminOverride.reservation.override.applied).toBe(true);
    const overrideAudits = await prisma.reservationAuditEvent.findMany({
      where: { restaurantId, capacityOverride: true },
      orderBy: { createdAt: "asc" },
    });
    expect(overrideAudits).toHaveLength(2);
    expect(overrideAudits[0]?.newState).toMatchObject({
      capacityOverrideResult: {
        capacityLimit: 4,
        totalBefore: 0,
        totalAfter: 5,
      },
    });
    expect(
      await prisma.reservationAuditEvent.count({
        where: { restaurantId, capacityOverride: true },
      }),
    ).toBe(2);
    await expect(
      createPhone(staffActor, {
        localDate: concurrencyDate,
        partySize: 2,
        capacityOverride: true,
        capacityOverrideReason: "Override non necessario",
      }),
    ).rejects.toMatchObject({ code: "OVERRIDE_NOT_REQUIRED" });
  });

  it("updates contacts without a capacity change, moves service atomically and rejects stale versions", async () => {
    const created = await createPhone(staffActor);
    const consentBefore = await prisma.reservation.findUniqueOrThrow({
      where: { id: created.reservation.id },
      select: {
        origin: true,
        createdByUserId: true,
        privacyConsentAt: true,
        privacyConsentMethod: true,
      },
    });
    const contactsUpdated = await updateStaffReservation({
      actor: staffActor,
      reservationId: created.reservation.id,
      rawPayload: updatePayload(created.reservation, {
        customerPhone: "+39 000 000 0888",
      }),
      now,
    });
    const auditCountBeforeNoOp = await prisma.reservationAuditEvent.count({
      where: { reservationId: created.reservation.id },
    });
    const noOp = await updateStaffReservation({
      actor: staffActor,
      reservationId: created.reservation.id,
      rawPayload: updatePayload(contactsUpdated.reservation),
      now,
    });
    const moved = await updateStaffReservation({
      actor: adminActor,
      reservationId: created.reservation.id,
      rawPayload: updatePayload(contactsUpdated.reservation, {
        localDate: movedDate,
        serviceType: "LUNCH",
        arrivalTime: "12:30",
        partySize: 3,
      }),
      now,
    });

    expect(contactsUpdated.reservation.version).toBe(2);
    expect(noOp).toMatchObject({ changed: false, reservation: { version: 2 } });
    expect(
      await prisma.reservationAuditEvent.count({
        where: { reservationId: created.reservation.id },
      }),
    ).toBe(auditCountBeforeNoOp + 1);
    expect(moved.reservation).toMatchObject({
      localDate: movedDate,
      serviceType: "LUNCH",
      arrivalTime: "12:30",
      partySize: 3,
      version: 3,
    });
    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: created.reservation.id },
        select: {
          origin: true,
          createdByUserId: true,
          privacyConsentAt: true,
          privacyConsentMethod: true,
        },
      }),
    ).toEqual(consentBefore);
    await expect(
      updateStaffReservation({
        actor: staffActor,
        reservationId: created.reservation.id,
        rawPayload: updatePayload(created.reservation),
        now,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("preserves an existing override during a contact-only update", async () => {
    const created = await createPhone(staffActor, {
      localDate: overrideDate,
      partySize: 5,
      capacityOverride: true,
      capacityOverrideReason: "Override persistente fittizio",
    });
    const updated = await updateStaffReservation({
      actor: adminActor,
      reservationId: created.reservation.id,
      rawPayload: updatePayload(created.reservation, {
        customerPhone: "+39 000 000 0899",
      }),
      now,
    });
    const updateAudit = await prisma.reservationAuditEvent.findFirstOrThrow({
      where: { reservationId: created.reservation.id, action: "UPDATED" },
    });

    expect(updated.reservation.override).toEqual({
      applied: true,
      reason: "Override persistente fittizio",
    });
    expect(updateAudit).toMatchObject({
      capacityOverride: false,
      capacityOverrideReason: null,
    });
    expect(updateAudit.newState).toMatchObject({
      capacityOverride: true,
      capacityOverrideReason: "Override persistente fittizio",
    });
  });

  it("grandfathers an unavailable room for unrelated edits and cancellation", async () => {
    const created = await createPhone(staffActor);
    await prisma.room.update({ where: { id: roomId }, data: { isActive: false } });

    try {
      const updated = await updateStaffReservation({
        actor: staffActor,
        reservationId: created.reservation.id,
        rawPayload: updatePayload(created.reservation, {
          customerPhone: "+39 000 000 0877",
        }),
        now,
      });

      expect(updated.reservation).toMatchObject({
        roomCode: "sala-m8",
        status: "CONFIRMED",
        version: 2,
      });
      await expect(
        updateStaffReservation({
          actor: staffActor,
          reservationId: created.reservation.id,
          rawPayload: updatePayload(updated.reservation, {
            localDate: movedDate,
          }),
          now,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        cancelStaffReservation({
          actor: staffActor,
          reservationId: created.reservation.id,
          rawPayload: { version: updated.reservation.version },
          now,
        }),
      ).resolves.toMatchObject({
        changed: true,
        reservation: { roomCode: "sala-m8", status: "CANCELLED" },
      });
    } finally {
      await prisma.room.update({ where: { id: roomId }, data: { isActive: true } });
    }
  });

  it("serializes concurrent PHONE creation without exceeding capacity", async () => {
    const attempts = await Promise.allSettled([
      createPhone(staffActor, {
        localDate: concurrencyDate,
        partySize: 3,
      }),
      createPhone(adminActor, {
        localDate: concurrencyDate,
        partySize: 3,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(ReservationApplicationError);
    expect(rejected?.reason).toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(
      await prisma.reservation.aggregate({
        where: { restaurantId, localDate: localDateToDatabase(concurrencyDate) },
        _sum: { partySize: true },
      }),
    ).toMatchObject({ _sum: { partySize: 3 } });
  });

  it("cancels logically and idempotently, audits once and frees covers", async () => {
    const created = await createPhone(staffActor, {
      localDate: cancellationDate,
      partySize: 4,
    });
    const first = await cancelStaffReservation({
      actor: staffActor,
      reservationId: created.reservation.id,
      rawPayload: { version: created.reservation.version },
      now,
    });
    const replay = await cancelStaffReservation({
      actor: adminActor,
      reservationId: created.reservation.id,
      rawPayload: { version: created.reservation.version },
      now,
    });
    const replacement = await createPhone(adminActor, {
      localDate: cancellationDate,
      partySize: 4,
    });

    expect(first).toMatchObject({ changed: true, reservation: { version: 2 } });
    expect(replay).toMatchObject({ changed: false, reservation: { version: 2 } });
    expect(replacement.reservation.status).toBe("CONFIRMED");
    expect(
      await prisma.reservationAuditEvent.count({
        where: { reservationId: created.reservation.id, action: "CANCELLED" },
      }),
    ).toBe(1);
  });

  it("rolls back a failed capacity attempt without an orphan audit", async () => {
    await createPhone(staffActor, { localDate: overrideDate, partySize: 4 });
    const auditsBefore = await prisma.reservationAuditEvent.count({
      where: { restaurantId },
    });
    const keysBefore = await prisma.reservationIdempotencyKey.count({
      where: { restaurantId },
    });

    await expect(
      createPhone(adminActor, { localDate: overrideDate, partySize: 1 }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });

    expect(
      await prisma.reservationAuditEvent.count({ where: { restaurantId } }),
    ).toBe(auditsBefore);
    expect(
      await prisma.reservationIdempotencyKey.count({ where: { restaurantId } }),
    ).toBe(keysBefore);
  });

  it("preserves the original public token duration when Staff moves a PUBLIC reservation", async () => {
    const publicReservation = await createPublicReservation({
      restaurantId,
      managementSecret,
      rawPayload: publicPayload(),
      rawIdempotencyKey: randomUUID(),
      now,
      config,
    });
    const storedBefore = await prisma.reservation.findFirstOrThrow({
      where: {
        restaurantId,
        origin: "PUBLIC",
        localDate: localDateToDatabase(publicDate),
      },
    });
    const tokenBefore = await prisma.reservationManagementToken.findUniqueOrThrow({
      where: { reservationId: storedBefore.id },
    });
    await prisma.restaurantBookingSettings.update({
      where: { restaurantId },
      data: { managementLinkDurationHours: 6 },
    });
    const updated = await updateStaffReservation({
      actor: staffActor,
      reservationId: storedBefore.id,
      rawPayload: {
        version: storedBefore.version,
        localDate: publicMovedDate,
        serviceType: "DINNER",
        arrivalTime: "20:00",
        partySize: publicReservation.reservation.partySize,
        roomCode: "sala-m8",
        customerFirstName: "Cliente",
        customerLastName: "Pubblico Fittizio",
        customerPhone: "+39 000 000 0801",
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
        capacityOverride: false,
        capacityOverrideReason: null,
      },
      now,
    });
    const tokenAfter = await prisma.reservationManagementToken.findUniqueOrThrow({
      where: { reservationId: storedBefore.id },
    });
    const storedAfter = await prisma.reservation.findUniqueOrThrow({
      where: { id: storedBefore.id },
    });

    expect(tokenAfter.viewExpiresAt).not.toEqual(tokenBefore.viewExpiresAt);
    expect(tokenAfter.viewExpiresAt).toEqual(
      managementViewExpiry({
        localDate: publicMovedDate,
        arrivalTime: "20:00",
        timezone: "Europe/Rome",
        durationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
      }),
    );
    expect(storedAfter).toMatchObject({
      origin: "PUBLIC",
      createdByUserId: null,
      privacyConsentMethod: "WEB_CHECKBOX",
      termsConsentMethod: "WEB_CHECKBOX",
    });
    expect(updated.reservation.version).toBe(2);
    expect(
      await prisma.reservationAuditEvent.findFirstOrThrow({
        where: { reservationId: storedBefore.id, action: "UPDATED" },
        orderBy: { createdAt: "desc" },
      }),
    ).toMatchObject({ actorUserId: staffId, actorRole: "STAFF" });
  });

  it("keeps a Staff-cancelled PUBLIC reservation readable through its valid link", async () => {
    const created = await createPublicReservation({
      restaurantId,
      managementSecret,
      rawPayload: publicPayload(),
      rawIdempotencyKey: randomUUID(),
      now,
      config,
    });
    const stored = await prisma.reservation.findFirstOrThrow({
      where: { restaurantId, origin: "PUBLIC" },
    });
    const tokenBefore = await prisma.reservationManagementToken.findUniqueOrThrow({
      where: { reservationId: stored.id },
    });

    await cancelStaffReservation({
      actor: staffActor,
      reservationId: stored.id,
      rawPayload: { version: stored.version },
      now,
    });
    const visible = await readPublicReservation({
      restaurantId,
      rawToken: created.managementPath.slice("/p/".length),
      now,
    });
    const tokenAfter = await prisma.reservationManagementToken.findUniqueOrThrow({
      where: { reservationId: stored.id },
    });

    expect(visible.status).toBe("CANCELLED");
    expect(tokenAfter).toMatchObject({
      tokenHash: tokenBefore.tokenHash,
      revokedAt: null,
      viewExpiresAt: tokenBefore.viewExpiresAt,
    });
  });

  it("serializes concurrent public and Staff cancellation into one state change", async () => {
    const created = await createPublicReservation({
      restaurantId,
      managementSecret,
      rawPayload: publicPayload(),
      rawIdempotencyKey: randomUUID(),
      now,
      config,
    });
    const stored = await prisma.reservation.findFirstOrThrow({
      where: { restaurantId, origin: "PUBLIC" },
    });
    const rawToken = created.managementPath.slice("/p/".length);
    const attempts = await Promise.allSettled([
      cancelStaffReservation({
        actor: staffActor,
        reservationId: stored.id,
        rawPayload: { version: stored.version },
        now,
      }),
      cancelManagedPublicReservation({ restaurantId, rawToken, now }),
    ]);
    const finalReservation = await prisma.reservation.findUniqueOrThrow({
      where: { id: stored.id },
    });

    expect(attempts.every((attempt) => attempt.status === "fulfilled")).toBe(true);
    expect(finalReservation).toMatchObject({ status: "CANCELLED", version: 2 });
    expect(
      await prisma.reservationAuditEvent.count({
        where: { reservationId: stored.id, action: "CANCELLED" },
      }),
    ).toBe(1);
  });
});
