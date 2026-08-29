import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DELETE as reservationDelete,
  GET as reservationGet,
  PATCH as reservationPatch,
} from "@/app/api/staff/reservations/[id]/route";
import { POST as reservationPost } from "@/app/api/staff/reservations/route";
import { GET as staffAvailabilityGet } from "@/app/api/staff/availability/route";
import {
  DayOfWeek,
  PrivacyConsentMethod,
  ReservationOrigin,
  ReservationStatus,
  ServiceType,
  SpecialDateScope,
  UserRole,
} from "@/generated/prisma/client";
import { ReservationApplicationError } from "@/modules/reservations/application/reservation-errors";
import {
  createReservation,
  getReservationById,
} from "@/modules/reservations/application/reservation-service";
import {
  DAY_OF_WEEK_VALUES,
  DEFAULT_BOOKING_CUTOFFS,
  DEFAULT_SERVICE_TIMES,
  DEFAULT_SLOT_INTERVAL_MINUTES,
  FIXED_ROLLING_WINDOW_MINUTES,
  SERVICE_TYPE_VALUES,
} from "@/modules/configuration/domain/defaults";
import {
  localDateToDatabase,
  operationalTimeToDatabase,
} from "@/modules/configuration/domain/operational-time";
import { cleanupExpiredReservationIdempotencyKeys } from "@/modules/reservations/infrastructure/reservation-repository";
import { createSessionForUser } from "@/server/auth/session";
import { getSessionCookieName } from "@/server/auth/session-token";
import { prisma } from "@/server/db/prisma";
import { getAppEnvironment } from "@/shared/config/app-environment";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const adminId = randomUUID();
const staffId = randomUUID();
const otherStaffId = randomUUID();
const standardDate = "2099-10-19";
const closedDate = "2099-10-20";
const concurrencyDate = "2099-10-21";
const exactCapacityDate = "2099-10-22";
const cancelledCapacityDate = "2099-10-23";
const overrideDate = "2099-10-24";
const apiDate = "2099-10-25";
const now = new Date("2099-01-01T10:00:00.000Z");
let adminCookie = "";
let staffCookie = "";
let otherStaffCookie = "";

const staffActor = {
  id: staffId,
  restaurantId,
  role: "STAFF",
} as const;
const adminActor = {
  id: adminId,
  restaurantId,
  role: "ADMIN",
} as const;

function bookingSettingsData(capacity: number) {
  return {
    rollingCapacityCovers: capacity,
    rollingWindowMinutes: FIXED_ROLLING_WINDOW_MINUTES,
    lunchModificationCutoff: operationalTimeToDatabase(
      DEFAULT_BOOKING_CUTOFFS.lunchModificationCutoff,
    ),
    dinnerModificationCutoff: operationalTimeToDatabase(
      DEFAULT_BOOKING_CUTOFFS.dinnerModificationCutoff,
    ),
  };
}

function weeklySchedules(restaurant: string) {
  return DAY_OF_WEEK_VALUES.flatMap((dayOfWeek) =>
    SERVICE_TYPE_VALUES.map((serviceType) => ({
      restaurantId: restaurant,
      dayOfWeek: DayOfWeek[dayOfWeek],
      serviceType: ServiceType[serviceType],
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

function payload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    localDate: standardDate,
    serviceType: "DINNER",
    arrivalTime: "19:15",
    partySize: 2,
    origin: "PHONE",
    customerFirstName: "Cliente",
    customerLastName: "Fittizio",
    customerPhone: "+39 000 000 0000",
    customerEmail: "cliente@example.invalid",
    notes: "Nota fittizia",
    preferences: "Sala demo",
    allergies: "Nessuna dichiarata",
    privacyConsentMethod: "VERBAL",
    capacityOverride: false,
    capacityOverrideReason: null,
    ...overrides,
  };
}

function phoneApiPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    localDate: apiDate,
    serviceType: "DINNER",
    arrivalTime: "19:15",
    partySize: 2,
    roomCode: "sala-test",
    customerFirstName: "Cliente",
    customerLastName: "Telefonico Fittizio",
    customerPhone: "+39 000 000 0000",
    customerEmail: "cliente@example.invalid",
    highChair: false,
    stroller: false,
    accessibility: false,
    children: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: "Nota fittizia",
    verbalConsentConfirmed: true,
    sendWhatsAppConfirmation: true,
    capacityOverride: false,
    capacityOverrideReason: null,
    ...overrides,
  };
}

function create(
  actor: typeof staffActor | typeof adminActor,
  overrides: Record<string, unknown> = {},
  key = randomUUID(),
) {
  return createReservation({
    actor,
    rawPayload: payload(overrides),
    rawIdempotencyKey: key,
    now,
    config: {
      privacyPolicyVersion: "local-test-v1",
      termsVersion: "local-test-terms-v1",
      idempotencyTtlMs: 24 * 60 * 60 * 1000,
    },
  });
}

function postRequest(input: {
  cookie?: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string | null;
  contentType?: string;
}): Request {
  const headers = new Headers({
    origin: "http://localhost:4000",
    "content-type": input.contentType ?? "application/json",
  });

  if (input.cookie) {
    headers.set("cookie", input.cookie);
  }

  if (input.idempotencyKey !== null) {
    headers.set("idempotency-key", input.idempotencyKey ?? randomUUID());
  }

  return new Request("http://localhost:4000/api/staff/reservations", {
    method: "POST",
    headers,
    body: JSON.stringify(input.body ?? phoneApiPayload()),
  });
}

function getRequest(cookie: string | undefined, id: string): Request {
  const headers = new Headers();

  if (cookie) {
    headers.set("cookie", cookie);
  }

  return new Request(`http://localhost:4000/api/staff/reservations/${id}`, {
    headers,
  });
}

function mutationRequest(input: {
  cookie?: string;
  id: string;
  method: "PATCH" | "DELETE";
  body: Record<string, unknown>;
  origin?: string;
}): Request {
  const headers = new Headers({
    "content-type": "application/json",
    origin: input.origin ?? "http://localhost:4000",
  });

  if (input.cookie) headers.set("cookie", input.cookie);

  return new Request(
    `http://localhost:4000/api/staff/reservations/${input.id}`,
    {
      method: input.method,
      headers,
      body: JSON.stringify(input.body),
    },
  );
}

function availabilityRequest(
  cookie?: string,
  query = `date=${apiDate}&service=DINNER&partySize=2`,
): Request {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);

  return new Request(
    `http://localhost:4000/api/staff/availability?${query}`,
    { headers },
  );
}

describe.sequential("M6 reservation persistence with real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.APP_ENV = "development";
    process.env.AUTH_RATE_LIMIT_SECRET =
      "local-only-rate-limit-secret-change-outside-development";

    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "M6 Reservation Demo", timezone: "Europe/Rome" },
        {
          id: otherRestaurantId,
          name: "M6 Isolated Reservation Demo",
          timezone: "Europe/Rome",
        },
      ],
    });
    await prisma.restaurantBookingSettings.createMany({
      data: [
        { restaurantId, ...bookingSettingsData(6) },
        { restaurantId: otherRestaurantId, ...bookingSettingsData(6) },
      ],
    });
    await prisma.restaurantNotificationSettings.createMany({
      data: [
        { restaurantId, strategy: "WHATSAPP_ONLY" },
        { restaurantId: otherRestaurantId, strategy: "WHATSAPP_ONLY" },
      ],
    });
    await prisma.weeklyServiceSchedule.createMany({
      data: [
        ...weeklySchedules(restaurantId),
        ...weeklySchedules(otherRestaurantId),
      ],
    });
    await prisma.specialDateOverride.create({
      data: {
        restaurantId,
        date: localDateToDatabase(closedDate),
        scope: SpecialDateScope.DINNER,
        isClosed: true,
      },
    });
    await prisma.room.createMany({
      data: [
        {
          restaurantId,
          code: "sala-test",
          name: "Sala test M6",
          displayOrder: 1,
          isActive: true,
        },
        {
          restaurantId: otherRestaurantId,
          code: "sala-test-other",
          name: "Sala test M6 other",
          displayOrder: 1,
          isActive: true,
        },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          restaurantId,
          username: `m6.admin.${restaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m6-tests",
          role: UserRole.ADMIN,
        },
        {
          id: staffId,
          restaurantId,
          username: `m6.staff.${restaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m6-tests",
          role: UserRole.STAFF,
        },
        {
          id: otherStaffId,
          restaurantId: otherRestaurantId,
          username: `m6.other.${otherRestaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m6-tests",
          role: UserRole.STAFF,
        },
      ],
    });

    const [adminSession, staffSession, otherStaffSession] = await Promise.all([
      createSessionForUser(adminId),
      createSessionForUser(staffId),
      createSessionForUser(otherStaffId),
    ]);
    const cookieName = getSessionCookieName(getAppEnvironment());
    adminCookie = `${cookieName}=${adminSession.token}`;
    staffCookie = `${cookieName}=${staffSession.token}`;
    otherStaffCookie = `${cookieName}=${otherStaffSession.token}`;
  });

  beforeEach(async () => {
    await prisma.notificationSimulationReceipt.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.notificationAttempt.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.notificationOutbox.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
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
  });

  afterAll(async () => {
    await prisma.notificationSimulationReceipt.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.notificationAttempt.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.notificationOutbox.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservationAuditEvent.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservationIdempotencyKey.deleteMany({
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
    await prisma.user.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurantNotificationSettings.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurant.deleteMany({
      where: { id: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.$disconnect();
  });

  it("has the M6 migration, tables and check constraints applied", async () => {
    const tables = await prisma.$queryRaw<
      Array<{ reservationTable: string | null; idempotencyTable: string | null }>
    >`
      SELECT
        to_regclass('public.reservations')::text AS "reservationTable",
        to_regclass('public.reservation_idempotency_keys')::text AS "idempotencyTable"
    `;
    const constraints = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM pg_constraint
      WHERE conname IN (
        'reservations_party_size_positive_check',
        'reservations_capacity_override_reason_check',
        'reservations_privacy_consent_check',
        'reservations_cancellation_state_check',
        'reservation_idempotency_keys_expiry_check'
      )
    `;

    expect(tables[0]).toEqual({
      reservationTable: "reservations",
      idempotencyTable: "reservation_idempotency_keys",
    });
    expect(constraints[0]?.count).toBe(BigInt(5));
  });

  it("creates STAFF and PHONE reservations and persists customer/privacy data", async () => {
    const staffReservation = await create(staffActor, {
      origin: "STAFF",
      privacyConsentMethod: "STAFF_RECORDED",
      arrivalTime: "19:00",
    });
    const phoneReservation = await create(staffActor, {
      origin: "PHONE",
      privacyConsentMethod: "VERBAL",
      arrivalTime: "19:30",
    });
    const rows = await prisma.reservation.findMany({
      where: { id: { in: [staffReservation.reservation.id, phoneReservation.reservation.id] } },
      orderBy: { arrivalTime: "asc" },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      origin: ReservationOrigin.STAFF,
      privacyConsentMethod: PrivacyConsentMethod.STAFF_RECORDED,
      createdByUserId: staffId,
      privacyPolicyVersion: "local-test-v1",
    });
    expect(rows[1]).toMatchObject({
      origin: ReservationOrigin.PHONE,
      privacyConsentMethod: PrivacyConsentMethod.VERBAL,
    });
  });

  it("isolates reads by restaurant", async () => {
    const created = await create(staffActor);

    await expect(
      getReservationById({
        actor: {
          id: otherStaffId,
          restaurantId: otherRestaurantId,
          role: "STAFF",
        },
        reservationId: created.reservation.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("allows STAFF and ADMIN override with a reason", async () => {
    await create(staffActor, {
      localDate: overrideDate,
      arrivalTime: "19:00",
      partySize: 6,
    });

    const staffOverridden = await create(staffActor, {
      localDate: overrideDate,
      arrivalTime: "19:15",
      partySize: 1,
      capacityOverride: true,
      capacityOverrideReason: "Autorizzazione demo Staff",
    });

    await create(staffActor, {
      localDate: exactCapacityDate,
      arrivalTime: "19:00",
      partySize: 6,
    });

    const overridden = await create(adminActor, {
      localDate: exactCapacityDate,
      arrivalTime: "19:15",
      partySize: 1,
      capacityOverride: true,
      capacityOverrideReason: "Autorizzazione demo Admin",
    });

    expect(staffOverridden.reservation.override.applied).toBe(true);
    expect(overridden.reservation.override).toEqual({
      applied: true,
      reason: "Autorizzazione demo Admin",
    });
    await expect(
      create(staffActor, {
        localDate: overrideDate,
        arrivalTime: "19:15",
        partySize: 1,
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });

  it("rejects a closed service, unknown slot and past slot", async () => {
    await expect(
      create(staffActor, { localDate: closedDate }),
    ).rejects.toMatchObject({ code: "SERVICE_CLOSED" });
    await expect(
      create(staffActor, { arrivalTime: "18:55" }),
    ).rejects.toMatchObject({ code: "SLOT_NOT_AVAILABLE" });
    await expect(
      createReservation({
        actor: staffActor,
        rawPayload: payload({
          localDate: "2099-01-01",
          serviceType: "LUNCH",
          arrivalTime: "12:00",
        }),
        rawIdempotencyKey: randomUUID(),
        now: new Date("2099-01-01T12:00:30.000Z"),
        config: {
          privacyPolicyVersion: "local-test-v1",
          termsVersion: "local-test-terms-v1",
          idempotencyTtlMs: 86_400_000,
        },
      }),
    ).rejects.toMatchObject({ code: "SLOT_IN_PAST" });
  });

  it("accepts the exact capacity limit and rejects one additional cover", async () => {
    await expect(
      create(staffActor, {
        localDate: exactCapacityDate,
        arrivalTime: "19:00",
        partySize: 6,
      }),
    ).resolves.toMatchObject({ replayed: false });
    await expect(
      create(staffActor, {
        localDate: exactCapacityDate,
        arrivalTime: "19:15",
        partySize: 1,
      }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });

  it("excludes CANCELLED reservations and still counts CONFIRMED overrides", async () => {
    await prisma.reservation.create({
      data: {
        restaurantId,
        localDate: localDateToDatabase(cancelledCapacityDate),
        serviceType: ServiceType.DINNER,
        arrivalTime: operationalTimeToDatabase("19:00"),
        partySize: 6,
        status: ReservationStatus.CANCELLED,
        origin: ReservationOrigin.PHONE,
        customerFirstName: "Annullato",
        customerLastName: "Fittizio",
        customerPhone: "+39 000 000 0001",
        privacyPolicyVersion: "local-test-v1",
        privacyConsentAt: now,
        privacyConsentMethod: PrivacyConsentMethod.VERBAL,
        createdByUserId: staffId,
        capacityOverride: false,
        cancelledAt: now,
      },
    });

    await expect(
      create(staffActor, {
        localDate: cancelledCapacityDate,
        arrivalTime: "19:15",
        partySize: 6,
      }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("replays the same key/payload and conflicts on a changed payload", async () => {
    const key = randomUUID();
    const first = await create(staffActor, {}, key);
    const replay = await create(staffActor, {}, key);

    expect(replay.replayed).toBe(true);
    expect(replay.reservation.id).toBe(first.reservation.id);
    await expect(create(staffActor, { partySize: 3 }, key)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
    await expect(
      prisma.reservation.count({ where: { restaurantId } }),
    ).resolves.toBe(1);
  });

  it("serializes concurrent requests with the same key into one reservation", async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => create(staffActor, {}, key)),
    );

    expect(new Set(results.map((result) => result.reservation.id)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    await expect(
      prisma.reservation.count({ where: { restaurantId } }),
    ).resolves.toBe(1);
  });

  it("never exceeds capacity under ten concurrent requests with different keys", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        create(staffActor, {
          localDate: concurrencyDate,
          arrivalTime: index % 2 === 0 ? "19:00" : "19:15",
          partySize: 2,
        }),
      ),
    );
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof create>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    const persistedCovers = await prisma.reservation.aggregate({
      where: {
        restaurantId,
        localDate: localDateToDatabase(concurrencyDate),
        status: ReservationStatus.CONFIRMED,
      },
      _sum: { partySize: true },
    });

    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(7);
    expect(
      rejected.every(
        (result) =>
          result.reason instanceof ReservationApplicationError &&
          result.reason.code === "CAPACITY_EXCEEDED",
      ),
    ).toBe(true);
    expect(persistedCovers._sum.partySize).toBe(6);
  });

  it("uses separate locks for services and restaurants", async () => {
    const otherActor = {
      id: otherStaffId,
      restaurantId: otherRestaurantId,
      role: "STAFF",
    } as const;
    const [lunch, dinner, otherRestaurant] = await Promise.all([
      create(staffActor, {
        localDate: standardDate,
        serviceType: "LUNCH",
        arrivalTime: "12:00",
      }),
      create(staffActor, {
        localDate: standardDate,
        serviceType: "DINNER",
        arrivalTime: "19:00",
      }),
      createReservation({
        actor: otherActor,
        rawPayload: payload({ localDate: standardDate, arrivalTime: "19:00" }),
        rawIdempotencyKey: randomUUID(),
        now,
        config: {
          privacyPolicyVersion: "local-test-v1",
          termsVersion: "local-test-terms-v1",
          idempotencyTtlMs: 86_400_000,
        },
      }),
    ]);

    expect([lunch, dinner, otherRestaurant].every((result) => !result.replayed)).toBe(
      true,
    );
  });

  it("rolls back reservation and idempotency key on a business error", async () => {
    await expect(create(staffActor, { localDate: closedDate })).rejects.toMatchObject({
      code: "SERVICE_CLOSED",
    });

    await expect(
      prisma.reservation.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.reservationIdempotencyKey.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
  });

  it("cleans up expired idempotency keys without memory state", async () => {
    const createdAt = new Date("2098-12-30T10:00:00.000Z");
    const keyHash = "a".repeat(64);
    await prisma.reservationIdempotencyKey.create({
      data: {
        restaurantId,
        keyHash,
        requestHash: "b".repeat(64),
        createdAt,
        expiresAt: new Date("2098-12-31T10:00:00.000Z"),
      },
    });

    await expect(cleanupExpiredReservationIdempotencyKeys(now)).resolves.toBeGreaterThanOrEqual(
      1,
    );
    await expect(
      prisma.reservationIdempotencyKey.findUnique({
        where: { restaurantId_keyHash: { restaurantId, keyHash } },
      }),
    ).resolves.toBeNull();
  });

  it("protects POST, requires idempotency and authorizes STAFF", async () => {
    const anonymous = await reservationPost(postRequest({}));
    const missingKey = await reservationPost(
      postRequest({ cookie: staffCookie, idempotencyKey: null }),
    );
    const created = await reservationPost(postRequest({ cookie: staffCookie }));

    expect(anonymous.status).toBe(401);
    expect(missingKey.status).toBe(400);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toContain("no-store");
  });

  it("allows STAFF API override and preserves ADMIN replay", async () => {
    await create(staffActor, {
      localDate: apiDate,
      arrivalTime: "19:00",
      partySize: 6,
    });
    await create(staffActor, {
      localDate: overrideDate,
      arrivalTime: "19:00",
      partySize: 6,
    });
    const staffOverrideBody = phoneApiPayload({
      localDate: apiDate,
      arrivalTime: "19:15",
      partySize: 1,
      capacityOverride: true,
      capacityOverrideReason: "Override API Staff fittizio",
    });
    const adminOverrideBody = phoneApiPayload({
      localDate: overrideDate,
      arrivalTime: "19:15",
      partySize: 1,
      capacityOverride: true,
      capacityOverrideReason: "Override API Admin fittizio",
    });
    const staffResponse = await reservationPost(
      postRequest({ cookie: staffCookie, body: staffOverrideBody }),
    );
    const key = randomUUID();
    const adminResponse = await reservationPost(
      postRequest({ cookie: adminCookie, body: adminOverrideBody, idempotencyKey: key }),
    );
    const replayResponse = await reservationPost(
      postRequest({ cookie: adminCookie, body: adminOverrideBody, idempotencyKey: key }),
    );
    const replayBody = await replayResponse.json();

    expect(staffResponse.status).toBe(201);
    expect(adminResponse.status).toBe(201);
    expect(replayResponse.status).toBe(200);
    expect(replayBody.replayed).toBe(true);
  });

  it("returns GET by id, hides internals and rejects cross-restaurant access", async () => {
    const created = await create(staffActor, { localDate: apiDate });
    const response = await reservationGet(
      getRequest(staffCookie, created.reservation.id),
      { params: Promise.resolve({ id: created.reservation.id }) },
    );
    const crossRestaurant = await reservationGet(
      getRequest(otherStaffCookie, created.reservation.id),
      { params: Promise.resolve({ id: created.reservation.id }) },
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(crossRestaurant.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.reservation.id).toBe(created.reservation.id);
    expect(serialized).not.toContain(restaurantId);
    expect(serialized).not.toContain("privacyPolicyVersion");
    expect(serialized).not.toContain("keyHash");
    expect(serialized).not.toContain("requestHash");
    expect(serialized).not.toContain("password");
  });

  it("protects Staff availability and derives its restaurant from the session", async () => {
    const anonymous = await staffAvailabilityGet(availabilityRequest());
    const currentRestaurant = await staffAvailabilityGet(
      availabilityRequest(staffCookie),
    );
    const otherRestaurant = await staffAvailabilityGet(
      availabilityRequest(otherStaffCookie),
    );
    const invalid = await staffAvailabilityGet(
      availabilityRequest(
        staffCookie,
        `date=${apiDate}&service=DINNER&partySize=2&unexpected=1`,
      ),
    );
    const currentBody = await currentRestaurant.json();
    const otherBody = await otherRestaurant.json();

    expect(anonymous.status).toBe(401);
    expect(currentRestaurant.status).toBe(200);
    expect(otherRestaurant.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(currentRestaurant.headers.get("cache-control")).toContain("no-store");
    expect(currentBody.rooms).toEqual([
      { code: "sala-test", name: "Sala test M6" },
    ]);
    expect(otherBody.rooms).toEqual([
      { code: "sala-test-other", name: "Sala test M6 other" },
    ]);
  });

  it("protects PATCH/DELETE with same-origin and tenant isolation", async () => {
    const created = await create(staffActor, { localDate: apiDate });
    const createdRow = await prisma.reservation.findUniqueOrThrow({
      where: { id: created.reservation.id },
      select: { version: true },
    });
    const {
      verbalConsentConfirmed: ignoredConsent,
      sendWhatsAppConfirmation: ignoredNotification,
      ...updateFields
    } = phoneApiPayload();
    expect(ignoredConsent).toBe(true);
    expect(ignoredNotification).toBe(true);
    const updateBody = { ...updateFields, version: createdRow.version };
    const context = { params: Promise.resolve({ id: created.reservation.id }) };
    const anonymous = await reservationPatch(
      mutationRequest({
        id: created.reservation.id,
        method: "PATCH",
        body: updateBody,
      }),
      context,
    );
    const forgedOrigin = await reservationPatch(
      mutationRequest({
        cookie: staffCookie,
        id: created.reservation.id,
        method: "PATCH",
        body: updateBody,
        origin: "https://evil.example.invalid",
      }),
      context,
    );
    const crossPatch = await reservationPatch(
      mutationRequest({
        cookie: otherStaffCookie,
        id: created.reservation.id,
        method: "PATCH",
        body: updateBody,
      }),
      context,
    );
    const crossDelete = await reservationDelete(
      mutationRequest({
        cookie: otherStaffCookie,
        id: created.reservation.id,
        method: "DELETE",
        body: { version: createdRow.version },
      }),
      context,
    );
    const updated = await reservationPatch(
      mutationRequest({
        cookie: staffCookie,
        id: created.reservation.id,
        method: "PATCH",
        body: updateBody,
      }),
      context,
    );
    const updatedBody = await updated.json();
    const cancelled = await reservationDelete(
      mutationRequest({
        cookie: adminCookie,
        id: created.reservation.id,
        method: "DELETE",
        body: { version: updatedBody.reservation.version },
      }),
      context,
    );
    const replayedCancellation = await reservationDelete(
      mutationRequest({
        cookie: staffCookie,
        id: created.reservation.id,
        method: "DELETE",
        body: { version: updatedBody.reservation.version },
      }),
      context,
    );
    const replayBody = await replayedCancellation.json();

    expect(anonymous.status).toBe(401);
    expect(forgedOrigin.status).toBe(403);
    expect(crossPatch.status).toBe(404);
    expect(crossDelete.status).toBe(404);
    expect(updated.status).toBe(200);
    expect(cancelled.status).toBe(200);
    expect(replayedCancellation.status).toBe(200);
    expect(replayBody).toMatchObject({
      changed: false,
      reservation: { status: "CANCELLED", version: 3 },
    });
    expect(cancelled.headers.get("cache-control")).toContain("no-store");
  });
});
