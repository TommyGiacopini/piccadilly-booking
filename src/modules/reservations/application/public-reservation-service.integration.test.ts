import "dotenv/config";

import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { GET as publicAvailabilityGet } from "@/app/api/public/availability/route";
import { POST as publicReservationPost } from "@/app/api/public/reservations/route";
import {
  DELETE as publicReservationDelete,
  GET as publicReservationGet,
  PATCH as publicReservationPatch,
} from "@/app/api/public/reservations/[token]/route";
import {
  DayOfWeek,
  ServiceType,
} from "@/generated/prisma/client";
import { getAvailabilityPreview } from "@/modules/availability/application/availability-service";
import {
  DEFAULT_BOOKING_CUTOFFS,
  DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
  DEFAULT_SERVICE_TIMES,
  DEFAULT_SLOT_INTERVAL_MINUTES,
  FIXED_ROLLING_WINDOW_MINUTES,
  SERVICE_TYPE_VALUES,
  DAY_OF_WEEK_VALUES,
} from "@/modules/configuration/domain/defaults";
import { operationalTimeToDatabase } from "@/modules/configuration/domain/operational-time";
import {
  cancelManagedPublicReservation,
  createPublicReservation,
  readPublicReservation,
  updateManagedPublicReservation,
} from "@/modules/reservations/application/public-reservation-service";
import {
  deriveManagementToken,
  hashManagementToken,
} from "@/modules/reservations/domain/management-token";
import { localReservationInstant } from "@/modules/reservations/domain/management-time";
import {
  cleanupExpiredPublicRateLimits,
  consumePublicRateLimit,
  createPublicRateLimitKeyHash,
  PUBLIC_RATE_LIMIT_CLEANUP_BATCH_SIZE,
} from "@/server/security/public-rate-limit";
import { prisma } from "@/server/db/prisma";

const restaurantId = randomUUID();
const standardDate = "2099-10-19";
const loadDate = "2099-10-20";
const concurrencyDate = "2099-10-21";
const overbookDate = "2099-10-22";
const updateDate = "2099-10-23";
const cancellationDate = "2099-10-24";
const secret = "m7-test-management-secret-with-at-least-32-characters";
const rateSecret = "m7-test-rate-limit-secret-with-at-least-32-characters";
const earlyNow = new Date("2099-01-01T10:00:00.000Z");
const temporaryEnvironmentNames = [
  "APP_ENV",
  "AUTH_RESTAURANT_ID",
  "AUTH_TRUST_PROXY",
  "PUBLIC_BOOKING_MANAGEMENT_SECRET",
  "PUBLIC_BOOKING_RATE_LIMIT_SECRET",
  "PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS",
  "PUBLIC_BOOKING_READ_LIMIT",
  "PUBLIC_BOOKING_MUTATION_LIMIT",
  "RESERVATION_PRIVACY_POLICY_VERSION",
  "RESERVATION_TERMS_VERSION",
] as const;
const previousEnvironment = new Map(
  temporaryEnvironmentNames.map((name) => [name, process.env[name]]),
);

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
    fridayDinnerBookingCutoff: operationalTimeToDatabase(
      DEFAULT_BOOKING_CUTOFFS.fridayDinnerBookingCutoff,
    ),
    saturdayDinnerBookingCutoff: operationalTimeToDatabase(
      DEFAULT_BOOKING_CUTOFFS.saturdayDinnerBookingCutoff,
    ),
    managementLinkDurationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
  };
}

function weeklySchedules() {
  return DAY_OF_WEEK_VALUES.flatMap((dayOfWeek) =>
    SERVICE_TYPE_VALUES.map((serviceType) => ({
      restaurantId,
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

function payload(overrides: Record<string, unknown> = {}) {
  return {
    localDate: standardDate,
    serviceType: "DINNER",
    arrivalTime: "19:00",
    partySize: 2,
    roomCode: "sala-test",
    customerFirstName: "Cliente",
    customerLastName: "M7 Fittizio",
    customerPhone: "+39 000 000 0700",
    customerEmail: "m7@example.invalid",
    highChair: false,
    stroller: false,
    accessibility: false,
    children: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: "Dato esclusivamente fittizio M7",
    language: "it",
    privacyAccepted: true,
    termsAccepted: true,
    ...overrides,
  };
}

function serviceCreate(
  overrides: Record<string, unknown> = {},
  key = randomUUID(),
  now = earlyNow,
) {
  return createPublicReservation({
    restaurantId,
    managementSecret: secret,
    rawPayload: payload(overrides),
    rawIdempotencyKey: key,
    now,
    config: {
      privacyPolicyVersion: "m7-test-privacy-v1",
      termsVersion: "m7-test-terms-v1",
      idempotencyTtlMs: 86_400_000,
    },
  });
}

function updatePayload(overrides: Record<string, unknown> = {}) {
  return {
    localDate: updateDate,
    serviceType: "DINNER",
    arrivalTime: "19:30",
    partySize: 2,
    roomCode: "sala-test",
    highChair: false,
    stroller: false,
    accessibility: true,
    children: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: "Aggiornamento fittizio M7",
    ...overrides,
  };
}

function routeRequest(input: {
  url: string;
  method?: string;
  body?: unknown;
  idempotencyKey?: string | null;
  origin?: string;
}) {
  const headers = new Headers({
    origin: input.origin ?? "http://localhost:4000",
    "content-type": "application/json",
  });
  if (input.idempotencyKey !== null) {
    headers.set("idempotency-key", input.idempotencyKey ?? randomUUID());
  }
  return new Request(input.url, {
    method: input.method ?? "GET",
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
}

function tokenFromPath(path: string): string {
  const token = path.split("/").at(-1);
  if (!token) throw new Error("Missing test token.");
  return token;
}

describe.sequential("M7 public booking with real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.APP_ENV = "development";
    process.env.AUTH_RESTAURANT_ID = restaurantId;
    process.env.AUTH_TRUST_PROXY = "false";
    process.env.PUBLIC_BOOKING_MANAGEMENT_SECRET = secret;
    process.env.PUBLIC_BOOKING_RATE_LIMIT_SECRET = rateSecret;
    process.env.PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS = "900";
    process.env.PUBLIC_BOOKING_READ_LIMIT = "10000";
    process.env.PUBLIC_BOOKING_MUTATION_LIMIT = "10000";
    process.env.RESERVATION_PRIVACY_POLICY_VERSION = "m7-test-privacy-v1";
    process.env.RESERVATION_TERMS_VERSION = "m7-test-terms-v1";

    await prisma.restaurant.create({
      data: { id: restaurantId, name: "M7 Public Demo", timezone: "Europe/Rome" },
    });
    await prisma.restaurantBookingSettings.create({
      data: { restaurantId, ...bookingSettingsData() },
    });
    await prisma.weeklyServiceSchedule.createMany({ data: weeklySchedules() });
    await prisma.room.create({
      data: {
        restaurantId,
        name: "Sala test M7",
        code: "sala-test",
        displayOrder: 1,
        isActive: true,
      },
    });
  });

  beforeEach(async () => {
    await prisma.reservationAuditEvent.deleteMany({ where: { restaurantId } });
    await prisma.reservation.deleteMany({ where: { restaurantId } });
    await prisma.publicReservationRateLimit.deleteMany({ where: { restaurantId } });
  });

  afterAll(async () => {
    await prisma.reservationAuditEvent.deleteMany({ where: { restaurantId } });
    await prisma.reservation.deleteMany({ where: { restaurantId } });
    await prisma.publicReservationRateLimit.deleteMany({ where: { restaurantId } });
    await prisma.restaurant.delete({ where: { id: restaurantId } });
    await prisma.$disconnect();

    for (const name of temporaryEnvironmentNames) {
      const previous = previousEnvironment.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("has the single M7 tables and constraints applied", async () => {
    const tables = await prisma.$queryRaw<Array<{ tokens: string | null; limits: string | null; audit: string | null }>>`
      SELECT
        to_regclass('public.reservation_management_tokens')::text AS tokens,
        to_regclass('public.public_reservation_rate_limits')::text AS limits,
        to_regclass('public.reservation_audit_events')::text AS audit
    `;
    expect(tables[0]).toEqual({
      tokens: "reservation_management_tokens",
      limits: "public_reservation_rate_limits",
      audit: "reservation_audit_events",
    });
  });

  it("reports empty availability and subtracts persisted confirmed load only", async () => {
    const empty = await getAvailabilityPreview({
      restaurantId,
      date: loadDate,
      serviceType: "DINNER",
      partySize: 1,
      channel: "PUBLIC",
      now: earlyNow,
      includePersistentLoad: true,
    });
    expect(empty.slots.find((slot) => slot.time === "19:00")?.remainingCapacity).toBe(4);

    const created = await serviceCreate({ localDate: loadDate, partySize: 3 });
    const loaded = await getAvailabilityPreview({
      restaurantId,
      date: loadDate,
      serviceType: "DINNER",
      partySize: 1,
      channel: "PUBLIC",
      now: earlyNow,
      includePersistentLoad: true,
    });
    expect(loaded.slots.find((slot) => slot.time === "19:00")?.remainingCapacity).toBe(1);

    await cancelManagedPublicReservation({
      restaurantId,
      rawToken: tokenFromPath(created.managementPath),
      now: earlyNow,
    });
    const released = await getAvailabilityPreview({
      restaurantId,
      date: loadDate,
      serviceType: "DINNER",
      partySize: 1,
      channel: "PUBLIC",
      now: earlyNow,
      includePersistentLoad: true,
    });
    expect(released.slots.find((slot) => slot.time === "19:00")?.remainingCapacity).toBe(4);
  });

  it("creates PUBLIC with WEB_CHECKBOX consent, terms, token and audit atomically", async () => {
    const result = await serviceCreate();
    const reservation = await prisma.reservation.findFirstOrThrow({
      where: { restaurantId },
      include: { managementToken: true, auditEvents: true },
    });
    const rawToken = tokenFromPath(result.managementPath);

    expect(reservation).toMatchObject({
      origin: "PUBLIC",
      privacyConsentMethod: "WEB_CHECKBOX",
      termsConsentMethod: "WEB_CHECKBOX",
      consentLanguage: "it",
      createdByUserId: null,
      capacityOverride: false,
    });
    expect(reservation.managementToken?.tokenHash).toBe(hashManagementToken(rawToken));
    expect(JSON.stringify(reservation)).not.toContain(rawToken);
    expect(reservation.auditEvents.map((event) => event.action)).toEqual(["CREATED"]);
  });

  it("requires Idempotency-Key at the public API", async () => {
    const response = await publicReservationPost(
      routeRequest({
        url: "http://localhost:4000/api/public/reservations",
        method: "POST",
        body: payload(),
        idempotencyKey: null,
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("replays the same key with the same link and conflicts on changed data", async () => {
    const key = randomUUID();
    const first = await serviceCreate({}, key);
    const replay = await serviceCreate({}, key);
    expect(replay.replayed).toBe(true);
    expect(replay.managementPath).toBe(first.managementPath);
    await expect(serviceCreate({ partySize: 3 }, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(prisma.reservation.count({ where: { restaurantId } })).resolves.toBe(1);
  });

  it("serializes concurrent retries with the same key", async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => serviceCreate({}, key)));
    expect(new Set(results.map((result) => result.managementPath)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
  });

  it("rejects capacity overflow and concurrent claims on the final cover", async () => {
    await serviceCreate({ localDate: concurrencyDate, partySize: 3 });
    const attempts = await Promise.allSettled([
      serviceCreate({ localDate: concurrencyDate, partySize: 1 }),
      serviceCreate({ localDate: concurrencyDate, partySize: 1 }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    await expect(serviceCreate({ localDate: overbookDate, partySize: 5 })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });

  it("reads valid links and uniformly rejects invalid, revoked and expired links", async () => {
    const created = await serviceCreate();
    const rawToken = tokenFromPath(created.managementPath);
    await expect(readPublicReservation({ restaurantId, rawToken, now: earlyNow })).resolves.toMatchObject({ status: "CONFIRMED" });
    await expect(readPublicReservation({ restaurantId, rawToken: deriveManagementToken(randomUUID(), secret), now: earlyNow })).rejects.toMatchObject({ code: "INVALID_LINK" });

    await prisma.reservationManagementToken.update({ where: { tokenHash: hashManagementToken(rawToken) }, data: { revokedAt: earlyNow } });
    await expect(readPublicReservation({ restaurantId, rawToken, now: earlyNow })).rejects.toMatchObject({ code: "INVALID_LINK" });
    await prisma.reservationManagementToken.update({ where: { tokenHash: hashManagementToken(rawToken) }, data: { revokedAt: null } });
    await expect(readPublicReservation({ restaurantId, rawToken, now: new Date("2100-01-01T00:00:00.000Z") })).rejects.toMatchObject({ code: "INVALID_LINK" });
  });

  it("keeps viewing after cutoff while rejecting update", async () => {
    const created = await serviceCreate();
    const rawToken = tokenFromPath(created.managementPath);
    const afterCutoff = localReservationInstant(standardDate, "17:31", "Europe/Rome");
    const view = await readPublicReservation({ restaurantId, rawToken, now: afterCutoff });
    expect(view.canModify).toBe(false);
    await expect(updateManagedPublicReservation({ restaurantId, rawToken, rawPayload: updatePayload(), now: afterCutoff })).rejects.toMatchObject({ code: "CUTOFF_REACHED" });
  });

  it("rejects moving an editable future reservation to a destination past cutoff", async () => {
    const created = await serviceCreate({
      localDate: updateDate,
      arrivalTime: "19:30",
      partySize: 1,
    });
    const rawToken = tokenFromPath(created.managementPath);
    const destinationAfterCutoff = localReservationInstant(
      standardDate,
      "17:31",
      "Europe/Rome",
    );

    await expect(
      updateManagedPublicReservation({
        restaurantId,
        rawToken,
        rawPayload: updatePayload({
          localDate: standardDate,
          arrivalTime: "19:00",
          partySize: 1,
        }),
        now: destinationAfterCutoff,
      }),
    ).rejects.toMatchObject({ code: "CUTOFF_REACHED" });
    await expect(
      readPublicReservation({
        restaurantId,
        rawToken,
        now: destinationAfterCutoff,
      }),
    ).resolves.toMatchObject({
      localDate: updateDate,
      arrivalTime: "19:30",
      canModify: true,
    });
  });

  it("updates transactionally, recalculates expiry and records before/after audit", async () => {
    const created = await serviceCreate();
    const rawToken = tokenFromPath(created.managementPath);
    const beforeExpiry = created.reservation.viewExpiresAt;
    const updated = await updateManagedPublicReservation({ restaurantId, rawToken, rawPayload: updatePayload(), now: earlyNow });
    expect(updated).toMatchObject({ localDate: updateDate, arrivalTime: "19:30", partySize: 2, accessibility: true });
    expect(updated.viewExpiresAt).not.toBe(beforeExpiry);
    const audit = await prisma.reservationAuditEvent.findMany({ where: { restaurantId }, orderBy: { createdAt: "asc" } });
    expect(audit.map((event) => event.action)).toEqual(["CREATED", "UPDATED"]);
    expect(audit[1]?.previousState).not.toEqual(audit[1]?.newState);
  });

  it("rejects an update that would overbook the destination", async () => {
    const movable = await serviceCreate({ localDate: standardDate, partySize: 1 });
    await serviceCreate({ localDate: updateDate, partySize: 4, arrivalTime: "19:30" });
    await expect(updateManagedPublicReservation({ restaurantId, rawToken: tokenFromPath(movable.managementPath), rawPayload: updatePayload({ partySize: 1 }), now: earlyNow })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
  });

  it("cancels logically, releases capacity and makes a second cancellation idempotent", async () => {
    const created = await serviceCreate({ localDate: cancellationDate, partySize: 4 });
    const rawToken = tokenFromPath(created.managementPath);
    const first = await cancelManagedPublicReservation({ restaurantId, rawToken, now: earlyNow });
    const second = await cancelManagedPublicReservation({ restaurantId, rawToken, now: earlyNow });
    expect(first.status).toBe("CANCELLED");
    expect(second).toEqual(first);
    const stored = await prisma.reservation.findFirstOrThrow({ where: { restaurantId } });
    expect(stored.cancelledAt).not.toBeNull();
    expect(await prisma.reservationAuditEvent.count({ where: { reservationId: stored.id, action: "CANCELLED" } })).toBe(1);
  });

  it("rejects first cancellation after cutoff", async () => {
    const created = await serviceCreate();
    await expect(cancelManagedPublicReservation({
      restaurantId,
      rawToken: tokenFromPath(created.managementPath),
      now: localReservationInstant(standardDate, "17:31", "Europe/Rome"),
    })).rejects.toMatchObject({ code: "CUTOFF_REACHED" });
  });

  it("uses an atomic PostgreSQL rate-limit bucket", async () => {
    const keyHash = createPublicRateLimitKeyHash({ restaurantId, action: "CREATE", clientAddress: "m7-test-client", secret: rateSecret });
    const results = await Promise.all(Array.from({ length: 4 }, () => consumePublicRateLimit({ restaurantId, action: "CREATE", keyHash, limit: 2, windowMs: 60_000, now: earlyNow })));
    expect(results.filter((result) => result.allowed)).toHaveLength(2);
    await expect(prisma.publicReservationRateLimit.findUnique({ where: { restaurantId_action_keyHash: { restaurantId, action: "CREATE", keyHash } } })).resolves.toMatchObject({ attempts: 4 });
  });

  it("resets an expired rate-limit window without changing the atomic upsert", async () => {
    const keyHash = createPublicRateLimitKeyHash({
      restaurantId,
      action: "VIEW",
      clientAddress: "m7-window-reset-client",
      secret: rateSecret,
    });
    const windowStart = new Date(earlyNow.getTime() + 10_000);
    const renewedAt = new Date(windowStart.getTime() + 2_000);

    await consumePublicRateLimit({
      restaurantId,
      action: "VIEW",
      keyHash,
      limit: 1,
      windowMs: 1_000,
      now: windowStart,
    });
    const renewed = await consumePublicRateLimit({
      restaurantId,
      action: "VIEW",
      keyHash,
      limit: 1,
      windowMs: 1_000,
      now: renewedAt,
    });
    const stored = await prisma.publicReservationRateLimit.findUniqueOrThrow({
      where: {
        restaurantId_action_keyHash: {
          restaurantId,
          action: "VIEW",
          keyHash,
        },
      },
    });

    expect(renewed.allowed).toBe(true);
    expect(stored).toMatchObject({
      attempts: 1,
      windowStartedAt: renewedAt,
      expiresAt: new Date(renewedAt.getTime() + 1_000),
    });
  });

  it("cleans only expired rate-limit buckets up to the fixed batch size", async () => {
    const cleanupNow = new Date(earlyNow.getTime() + 30_000);
    const expiredAt = new Date(cleanupNow.getTime() - 1_000);
    const windowStartedAt = new Date(cleanupNow.getTime() - 2_000);
    const activeExpiresAt = new Date(cleanupNow.getTime() + 60_000);
    const expiredCount = PUBLIC_RATE_LIMIT_CLEANUP_BATCH_SIZE + 2;

    await prisma.publicReservationRateLimit.createMany({
      data: [
        ...Array.from({ length: expiredCount }, (_, index) => ({
          restaurantId,
          action: "AVAILABILITY" as const,
          keyHash: createPublicRateLimitKeyHash({
            restaurantId,
            action: "AVAILABILITY",
            clientAddress: `m7-expired-${index}`,
            secret: rateSecret,
          }),
          attempts: 1,
          windowStartedAt,
          expiresAt: expiredAt,
          createdAt: windowStartedAt,
          updatedAt: windowStartedAt,
        })),
        {
          restaurantId,
          action: "AVAILABILITY" as const,
          keyHash: createPublicRateLimitKeyHash({
            restaurantId,
            action: "AVAILABILITY",
            clientAddress: "m7-active-cleanup-client",
            secret: rateSecret,
          }),
          attempts: 1,
          windowStartedAt: cleanupNow,
          expiresAt: activeExpiresAt,
          createdAt: cleanupNow,
          updatedAt: cleanupNow,
        },
      ],
    });

    await expect(
      cleanupExpiredPublicRateLimits(cleanupNow),
    ).resolves.toBe(PUBLIC_RATE_LIMIT_CLEANUP_BATCH_SIZE);
    await expect(
      prisma.publicReservationRateLimit.count({
        where: { restaurantId, expiresAt: { lte: cleanupNow } },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.publicReservationRateLimit.count({
        where: { restaurantId, expiresAt: { gt: cleanupNow } },
      }),
    ).resolves.toBe(1);
  });

  it("keeps rate limiting fail-closed while opportunistic cleanup runs", async () => {
    const cleanupNow = new Date(earlyNow.getTime() + 120_000);
    const targetKeyHash = createPublicRateLimitKeyHash({
      restaurantId,
      action: "UPDATE",
      clientAddress: "m7-cleanup-target-client",
      secret: rateSecret,
    });
    const expiredKeyHash = createPublicRateLimitKeyHash({
      restaurantId,
      action: "UPDATE",
      clientAddress: "m7-cleanup-expired-client",
      secret: rateSecret,
    });

    await prisma.publicReservationRateLimit.createMany({
      data: [
        {
          restaurantId,
          action: "UPDATE",
          keyHash: targetKeyHash,
          attempts: 1,
          windowStartedAt: new Date(cleanupNow.getTime() - 1_000),
          expiresAt: new Date(cleanupNow.getTime() + 60_000),
          createdAt: new Date(cleanupNow.getTime() - 1_000),
          updatedAt: new Date(cleanupNow.getTime() - 1_000),
        },
        {
          restaurantId,
          action: "UPDATE",
          keyHash: expiredKeyHash,
          attempts: 1,
          windowStartedAt: new Date(cleanupNow.getTime() - 2_000),
          expiresAt: new Date(cleanupNow.getTime() - 1_000),
          createdAt: new Date(cleanupNow.getTime() - 2_000),
          updatedAt: new Date(cleanupNow.getTime() - 2_000),
        },
      ],
    });

    const result = await consumePublicRateLimit({
      restaurantId,
      action: "UPDATE",
      keyHash: targetKeyHash,
      limit: 1,
      windowMs: 60_000,
      now: cleanupNow,
    });

    expect(result.allowed).toBe(false);
    await expect(
      prisma.publicReservationRateLimit.findUnique({
        where: {
          restaurantId_action_keyHash: {
            restaurantId,
            action: "UPDATE",
            keyHash: expiredKeyHash,
          },
        },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.publicReservationRateLimit.findUnique({
        where: {
          restaurantId_action_keyHash: {
            restaurantId,
            action: "UPDATE",
            keyHash: targetKeyHash,
          },
        },
      }),
    ).resolves.toMatchObject({ attempts: 2 });
  });

  it("runs concurrent cleanup batches without deleting active buckets", async () => {
    const cleanupNow = new Date(earlyNow.getTime() + 180_000);
    const expiredAt = new Date(cleanupNow.getTime() - 1_000);
    const windowStartedAt = new Date(cleanupNow.getTime() - 2_000);
    const expiredCount = PUBLIC_RATE_LIMIT_CLEANUP_BATCH_SIZE * 2 + 2;

    await prisma.publicReservationRateLimit.createMany({
      data: [
        ...Array.from({ length: expiredCount }, (_, index) => ({
          restaurantId,
          action: "CANCEL" as const,
          keyHash: createPublicRateLimitKeyHash({
            restaurantId,
            action: "CANCEL",
            clientAddress: `m7-concurrent-cleanup-${index}`,
            secret: rateSecret,
          }),
          attempts: 1,
          windowStartedAt,
          expiresAt: expiredAt,
          createdAt: windowStartedAt,
          updatedAt: windowStartedAt,
        })),
        {
          restaurantId,
          action: "CANCEL" as const,
          keyHash: createPublicRateLimitKeyHash({
            restaurantId,
            action: "CANCEL",
            clientAddress: "m7-concurrent-cleanup-active",
            secret: rateSecret,
          }),
          attempts: 1,
          windowStartedAt: cleanupNow,
          expiresAt: new Date(cleanupNow.getTime() + 60_000),
          createdAt: cleanupNow,
          updatedAt: cleanupNow,
        },
      ],
    });

    const deleted = await Promise.all([
      cleanupExpiredPublicRateLimits(cleanupNow),
      cleanupExpiredPublicRateLimits(cleanupNow),
    ]);

    expect(deleted.every((count) => count <= PUBLIC_RATE_LIMIT_CLEANUP_BATCH_SIZE)).toBe(true);
    expect(deleted.reduce((total, count) => total + count, 0)).toBe(
      PUBLIC_RATE_LIMIT_CLEANUP_BATCH_SIZE * 2,
    );
    await expect(
      prisma.publicReservationRateLimit.count({
        where: { restaurantId, expiresAt: { lte: cleanupNow } },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.publicReservationRateLimit.count({
        where: { restaurantId, expiresAt: { gt: cleanupNow } },
      }),
    ).resolves.toBe(1);
  });

  it("does not consume a rate-limit allowance when maintenance fails", async () => {
    const executeRaw = vi.fn().mockRejectedValue(new Error("database detail"));
    const queryRaw = vi.fn();
    const client = {
      $executeRaw: executeRaw,
      $queryRaw: queryRaw,
    } as unknown as NonNullable<
      Parameters<typeof consumePublicRateLimit>[0]["client"]
    >;

    await expect(
      consumePublicRateLimit({
        restaurantId,
        action: "CREATE",
        keyHash: createPublicRateLimitKeyHash({
          restaurantId,
          action: "CREATE",
          clientAddress: "m7-maintenance-failure-client",
          secret: rateSecret,
        }),
        limit: 1,
        windowMs: 60_000,
        now: new Date(earlyNow.getTime() + 240_000),
        client,
      }),
    ).rejects.toThrow("Public rate-limit maintenance failed.");
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("serves public availability from persisted load with no-store", async () => {
    await serviceCreate({ localDate: loadDate, partySize: 3 });
    const response = await publicAvailabilityGet(routeRequest({ url: `http://localhost:4000/api/public/availability?date=${loadDate}&service=DINNER&partySize=1` }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.slots.find((slot: { time: string }) => slot.time === "19:00").remainingCapacity).toBe(1);
    expect(body.rooms).toEqual([{ code: "sala-test", name: "Sala test M7" }]);
  });

  it("keeps management API responses no-store and free of internal fields", async () => {
    const created = await serviceCreate();
    const rawToken = tokenFromPath(created.managementPath);
    const response = await publicReservationGet(routeRequest({ url: `http://localhost:4000/api/public/reservations/${rawToken}` }), { params: Promise.resolve({ token: rawToken }) });
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    for (const forbidden of [restaurantId, "tokenHash", "requestHash", "privacyPolicyVersion", "termsPolicyVersion", secret, "Prisma"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("protects management mutations with same-origin and supports PATCH/DELETE", async () => {
    const created = await serviceCreate();
    const rawToken = tokenFromPath(created.managementPath);
    const crossOrigin = await publicReservationPatch(routeRequest({ url: `http://localhost:4000/api/public/reservations/${rawToken}`, method: "PATCH", body: updatePayload(), origin: "https://example.invalid" }), { params: Promise.resolve({ token: rawToken }) });
    expect(crossOrigin.status).toBe(403);
    const updated = await publicReservationPatch(routeRequest({ url: `http://localhost:4000/api/public/reservations/${rawToken}`, method: "PATCH", body: updatePayload() }), { params: Promise.resolve({ token: rawToken }) });
    expect(updated.status).toBe(200);
    const cancelled = await publicReservationDelete(routeRequest({ url: `http://localhost:4000/api/public/reservations/${rawToken}`, method: "DELETE", body: {} }), { params: Promise.resolve({ token: rawToken }) });
    expect(cancelled.status).toBe(200);
  });

  it("returns the same generic body for invalid and expired management tokens", async () => {
    const invalidToken = deriveManagementToken(randomUUID(), secret);
    const invalid = await publicReservationGet(routeRequest({ url: `http://localhost:4000/api/public/reservations/${invalidToken}` }), { params: Promise.resolve({ token: invalidToken }) });
    const created = await serviceCreate();
    const rawToken = tokenFromPath(created.managementPath);
    await prisma.reservationManagementToken.update({ where: { tokenHash: hashManagementToken(rawToken) }, data: { revokedAt: earlyNow } });
    const unavailable = await publicReservationGet(routeRequest({ url: `http://localhost:4000/api/public/reservations/${rawToken}` }), { params: Promise.resolve({ token: rawToken }) });
    expect(unavailable.status).toBe(invalid.status);
    expect(await unavailable.json()).toEqual(await invalid.json());
  });
});
