import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PUT as putArrivalRoute } from "@/app/api/staff/reservations/[id]/arrival/route";
import {
  putReservationArrival,
  ReservationArrivalError,
} from "@/modules/reservations/application/reservation-arrival-service";
import { cancelStaffReservation } from "@/modules/reservations/application/staff-reservation-service";
import {
  DEFAULT_BOOKING_CUTOFFS,
  DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
  FIXED_ROLLING_WINDOW_MINUTES,
} from "@/modules/configuration/domain/defaults";
import { operationalTimeToDatabase } from "@/modules/configuration/domain/operational-time";
import { createSessionForUser } from "@/server/auth/session";
import { getSessionCookieName } from "@/server/auth/session-token";
import { prisma } from "@/server/db/prisma";
import { getAppEnvironment } from "@/shared/config/app-environment";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const staffId = randomUUID();
const adminId = randomUUID();
const disabledId = randomUUID();
const mustChangeId = randomUUID();
const otherStaffId = randomUUID();
const fixedNow = new Date("2026-09-30T19:42:15.123Z");
let staffCookie = "";
let adminCookie = "";
let mustChangeCookie = "";
const originalAppEnvironment = process.env.APP_ENV;
const originalAuthRateLimitSecret = process.env.AUTH_RATE_LIMIT_SECRET;

const staffActor = { id: staffId, restaurantId };
const adminActor = { id: adminId, restaurantId };

function settings() {
  return {
    rollingCapacityCovers: 120,
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

async function createReservation(input: {
  targetRestaurantId?: string;
  status?: "CONFIRMED" | "CANCELLED";
  arrivedAt?: Date | null;
  version?: number;
} = {}) {
  const targetRestaurantId = input.targetRestaurantId ?? restaurantId;
  return prisma.reservation.create({
    data: {
      restaurantId: targetRestaurantId,
      localDate: new Date("2099-09-30T00:00:00.000Z"),
      serviceType: "DINNER",
      arrivalTime: operationalTimeToDatabase("19:30"),
      partySize: 4,
      status: input.status ?? "CONFIRMED",
      origin: "STAFF",
      customerFirstName: "Cliente",
      customerLastName: "Arrivo Fittizio",
      customerPhone: "+39 000 000 3030",
      customerEmail: "arrival@example.invalid",
      notes: "Nota sintetica T03",
      preferences: null,
      allergies: null,
      privacyPolicyVersion: "t03-test-v1",
      privacyConsentAt: fixedNow,
      privacyConsentMethod: "STAFF_RECORDED",
      createdByUserId:
        targetRestaurantId === restaurantId ? staffId : otherStaffId,
      arrivedAt: input.arrivedAt ?? null,
      cancelledAt:
        input.status === "CANCELLED" ? new Date("2026-09-30T18:00:00Z") : null,
      version: input.version ?? 1,
    },
  });
}

function arrivalRequest(input: {
  reservationId: string;
  cookie?: string;
  origin?: string;
  contentType?: string;
  body?: unknown;
}): Request {
  const headers = new Headers({
    origin: input.origin ?? "http://localhost:4000",
    "content-type": input.contentType ?? "application/json",
  });
  if (input.cookie) headers.set("cookie", input.cookie);
  return new Request(
    `http://localhost:4000/api/staff/reservations/${input.reservationId}/arrival`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify(input.body ?? { version: 1, arrived: true }),
    },
  );
}

async function callRoute(input: Parameters<typeof arrivalRequest>[0]) {
  return putArrivalRoute(arrivalRequest(input), {
    params: Promise.resolve({ id: input.reservationId }),
  });
}

describe.sequential("T03 arrival lifecycle with real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.APP_ENV = "development";
    process.env.AUTH_RATE_LIMIT_SECRET =
      "t03-local-fixture-rate-limit-secret-only";
    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "T03 Fixture", timezone: "Europe/Rome" },
        {
          id: otherRestaurantId,
          name: "T03 Other Fixture",
          timezone: "Europe/Rome",
        },
      ],
    });
    await prisma.restaurantBookingSettings.createMany({
      data: [
        { restaurantId, ...settings() },
        { restaurantId: otherRestaurantId, ...settings() },
      ],
    });
    await prisma.restaurantNotificationSettings.createMany({
      data: [
        { restaurantId, strategy: "WHATSAPP_ONLY" },
        { restaurantId: otherRestaurantId, strategy: "WHATSAPP_ONLY" },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: staffId,
          restaurantId,
          username: `t03.staff.${staffId.slice(0, 8)}`,
          passwordHash: "not-used-t03",
          role: "STAFF",
        },
        {
          id: adminId,
          restaurantId,
          username: `t03.admin.${adminId.slice(0, 8)}`,
          passwordHash: "not-used-t03",
          role: "ADMIN",
        },
        {
          id: disabledId,
          restaurantId,
          username: `t03.disabled.${disabledId.slice(0, 8)}`,
          passwordHash: "not-used-t03",
          role: "STAFF",
          isActive: false,
          disabledAt: fixedNow,
        },
        {
          id: mustChangeId,
          restaurantId,
          username: `t03.change.${mustChangeId.slice(0, 8)}`,
          passwordHash: "not-used-t03",
          role: "STAFF",
          mustChangePassword: true,
        },
        {
          id: otherStaffId,
          restaurantId: otherRestaurantId,
          username: `t03.other.${otherStaffId.slice(0, 8)}`,
          passwordHash: "not-used-t03",
          role: "STAFF",
        },
      ],
    });
    const [staffSession, adminSession, mustChangeSession] = await Promise.all([
      createSessionForUser(staffId),
      createSessionForUser(adminId),
      createSessionForUser(mustChangeId),
    ]);
    const cookieName = getSessionCookieName(getAppEnvironment());
    staffCookie = `${cookieName}=${staffSession.token}`;
    adminCookie = `${cookieName}=${adminSession.token}`;
    mustChangeCookie = `${cookieName}=${mustChangeSession.token}`;
  });

  beforeEach(async () => {
    const tenant = { in: [restaurantId, otherRestaurantId] };
    await prisma.notificationSimulationReceipt.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.notificationAttempt.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.notificationOutbox.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.reservationAuditEvent.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.reservation.deleteMany({ where: { restaurantId: tenant } });
  });

  afterAll(async () => {
    const tenant = { in: [restaurantId, otherRestaurantId] };
    await prisma.notificationSimulationReceipt.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.notificationAttempt.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.notificationOutbox.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.reservationAuditEvent.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.reservation.deleteMany({ where: { restaurantId: tenant } });
    await prisma.session.deleteMany({
      where: { userId: { in: [staffId, adminId, disabledId, mustChangeId, otherStaffId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [staffId, adminId, disabledId, mustChangeId, otherStaffId] } },
    });
    await prisma.restaurantNotificationSettings.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.restaurantBookingSettings.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.restaurant.deleteMany({
      where: { id: { in: [restaurantId, otherRestaurantId] } },
    });
    process.env.APP_ENV = originalAppEnvironment;
    process.env.AUTH_RATE_LIMIT_SECRET = originalAuthRateLimitSecret;
    await prisma.$disconnect();
  });

  it("records and reverts the exact server timestamp, version and PII-free audit atomically", async () => {
    const reservation = await createReservation();
    const recorded = await putReservationArrival({
      actor: staffActor,
      reservationId: reservation.id,
      rawPayload: { version: 1, arrived: true },
      now: fixedNow,
    });
    expect(recorded).toEqual({
      changed: true,
      reservationVersion: 2,
      arrivedAt: fixedNow.toISOString(),
    });
    const stored = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(stored).toMatchObject({
      arrivedAt: fixedNow,
      updatedAt: fixedNow,
      version: 2,
    });
    const firstAudit = await prisma.reservationAuditEvent.findFirstOrThrow({
      where: { reservationId: reservation.id },
    });
    expect(firstAudit).toMatchObject({
      action: "ARRIVAL_RECORDED",
      actorOrigin: "STAFF",
      actorUserId: staffId,
      actorRole: "STAFF",
      previousState: { arrival: { recorded: false, arrivedAt: null } },
      newState: {
        arrival: { recorded: true, arrivedAt: fixedNow.toISOString() },
      },
      capacityOverride: false,
      capacityOverrideReason: null,
      createdAt: fixedNow,
    });
    expect(JSON.stringify(firstAudit)).not.toMatch(
      /Arrivo Fittizio|000 000 3030|arrival@example|Nota sintetica/iu,
    );

    const revertedAt = new Date("2026-09-30T19:50:00.000Z");
    const reverted = await putReservationArrival({
      actor: adminActor,
      reservationId: reservation.id,
      rawPayload: { version: 2, arrived: false },
      now: revertedAt,
    });
    expect(reverted).toEqual({
      changed: true,
      reservationVersion: 3,
      arrivedAt: null,
    });
    expect(
      await prisma.reservationAuditEvent.findMany({
        where: { reservationId: reservation.id },
        orderBy: { createdAt: "asc" },
        select: { action: true, actorRole: true },
      }),
    ).toEqual([
      { action: "ARRIVAL_RECORDED", actorRole: "STAFF" },
      { action: "ARRIVAL_REVERTED", actorRole: "ADMIN" },
    ]);
  });

  it("accepts stale no-op without touching version, updatedAt, audit or notifications", async () => {
    const originalUpdatedAt = new Date("2026-09-01T10:00:00.000Z");
    const target = await createReservation({ arrivedAt: fixedNow, version: 7 });
    await prisma.reservation.update({
      where: { id: target.id },
      data: { updatedAt: originalUpdatedAt },
    });

    const result = await putReservationArrival({
      actor: staffActor,
      reservationId: target.id,
      rawPayload: { version: 1, arrived: true },
      now: new Date("2026-09-30T20:00:00.000Z"),
    });
    expect(result).toEqual({
      changed: false,
      reservationVersion: 7,
      arrivedAt: fixedNow.toISOString(),
    });
    const stored = await prisma.reservation.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(stored.version).toBe(7);
    expect(stored.updatedAt).toEqual(originalUpdatedAt);
    await expect(
      prisma.reservationAuditEvent.count({ where: { reservationId: target.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationOutbox.count({ where: { reservationId: target.id } }),
    ).resolves.toBe(0);
  });

  it("rejects stale state changes, cross-tenant access and invalid actors", async () => {
    const own = await createReservation();
    const other = await createReservation({ targetRestaurantId: otherRestaurantId });
    await expect(
      putReservationArrival({
        actor: staffActor,
        reservationId: own.id,
        rawPayload: { version: 99, arrived: true },
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    await expect(
      putReservationArrival({
        actor: staffActor,
        reservationId: other.id,
        rawPayload: { version: 1, arrived: true },
        now: fixedNow,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const actorId of [disabledId, mustChangeId]) {
      await expect(
        putReservationArrival({
          actor: { id: actorId, restaurantId },
          reservationId: own.id,
          rawPayload: { version: 1, arrived: true },
          now: fixedNow,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("allows cancelled and unassigned reservations and cancellation preserves arrival", async () => {
    const cancelled = await createReservation({ status: "CANCELLED" });
    await expect(
      putReservationArrival({
        actor: staffActor,
        reservationId: cancelled.id,
        rawPayload: { version: 1, arrived: true },
        now: fixedNow,
      }),
    ).resolves.toMatchObject({ changed: true, arrivedAt: fixedNow.toISOString() });

    const confirmed = await createReservation();
    const arrived = await putReservationArrival({
      actor: staffActor,
      reservationId: confirmed.id,
      rawPayload: { version: 1, arrived: true },
      now: fixedNow,
    });
    await cancelStaffReservation({
      actor: { ...staffActor, role: "STAFF" },
      reservationId: confirmed.id,
      rawPayload: { version: arrived.reservationVersion },
      now: new Date("2026-09-30T20:00:00.000Z"),
    });
    await expect(
      prisma.reservation.findUniqueOrThrow({ where: { id: confirmed.id } }),
    ).resolves.toMatchObject({ status: "CANCELLED", arrivedAt: fixedNow });
  });

  it("rolls back timestamp, version and updatedAt when arrival audit insert fails", async () => {
    const reservation = await createReservation();
    const before = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION t03_arrival_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.reservation_id = '${reservation.id}'::uuid AND NEW.action::text = 'ARRIVAL_RECORDED' THEN
          RAISE EXCEPTION 'synthetic T03 audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER t03_arrival_audit_failure
      BEFORE INSERT ON reservation_audit_events
      FOR EACH ROW EXECUTE FUNCTION t03_arrival_audit_failure();
    `);
    try {
      await expect(
        putReservationArrival({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: { version: 1, arrived: true },
          now: fixedNow,
        }),
      ).rejects.toThrow();
      const after = await prisma.reservation.findUniqueOrThrow({
        where: { id: reservation.id },
      });
      expect(after).toMatchObject({
        arrivedAt: null,
        version: before.version,
        updatedAt: before.updatedAt,
      });
      await expect(
        prisma.reservationAuditEvent.count({ where: { reservationId: reservation.id } }),
      ).resolves.toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS t03_arrival_audit_failure ON reservation_audit_events`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS t03_arrival_audit_failure()`,
      );
    }
  });

  it("serializes duplicate and opposite desired-state writes", async () => {
    const duplicate = await createReservation();
    const duplicateResults = await Promise.all([
      putReservationArrival({
        actor: staffActor,
        reservationId: duplicate.id,
        rawPayload: { version: 1, arrived: true },
        now: fixedNow,
      }),
      putReservationArrival({
        actor: adminActor,
        reservationId: duplicate.id,
        rawPayload: { version: 1, arrived: true },
        now: fixedNow,
      }),
    ]);
    expect(duplicateResults.map((result) => result.changed).sort()).toEqual([
      false,
      true,
    ]);
    await expect(
      prisma.reservationAuditEvent.count({ where: { reservationId: duplicate.id } }),
    ).resolves.toBe(1);

    const opposite = await createReservation();
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION t03_opposite_arrival_delay() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${opposite.id}'::uuid AND NEW.arrived_at IS NOT NULL THEN
          PERFORM pg_sleep(0.2);
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER t03_opposite_arrival_delay
      BEFORE UPDATE ON reservations
      FOR EACH ROW EXECUTE FUNCTION t03_opposite_arrival_delay();
    `);
    try {
      const recordPromise = putReservationArrival({
        actor: staffActor,
        reservationId: opposite.id,
        rawPayload: { version: 1, arrived: true },
        now: fixedNow,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const revertPromise = putReservationArrival({
        actor: adminActor,
        reservationId: opposite.id,
        rawPayload: { version: 1, arrived: false },
        now: new Date("2026-09-30T19:43:00.000Z"),
      });
      const [recorded, reverted] = await Promise.allSettled([
        recordPromise,
        revertPromise,
      ]);
      expect(recorded.status).toBe("fulfilled");
      expect(reverted.status).toBe("rejected");
      if (reverted.status === "rejected") {
        expect(reverted.reason).toBeInstanceOf(ReservationArrivalError);
        expect(reverted.reason).toMatchObject({ code: "VERSION_CONFLICT" });
      }
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS t03_opposite_arrival_delay ON reservations`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS t03_opposite_arrival_delay()`,
      );
    }
  });

  it("enforces the complete Staff API error and no-store contract", async () => {
    const reservation = await createReservation();
    const unauthenticated = await callRoute({ reservationId: reservation.id });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe(
      "no-store, max-age=0",
    );
    expect(
      (await callRoute({
        reservationId: reservation.id,
        cookie: staffCookie,
        origin: "https://evil.example.invalid",
      })).status,
    ).toBe(403);
    expect(
      (await callRoute({
        reservationId: reservation.id,
        cookie: mustChangeCookie,
      })).status,
    ).toBe(403);
    expect(
      (await callRoute({ reservationId: "not-a-uuid", cookie: staffCookie })).status,
    ).toBe(400);
    expect(
      (await callRoute({
        reservationId: reservation.id,
        cookie: staffCookie,
        contentType: "text/plain",
      })).status,
    ).toBe(400);
    for (const body of [
      { version: 0, arrived: true },
      { version: 1, arrived: "true" },
      { version: 1, arrived: true, extra: true },
    ]) {
      expect(
        (await callRoute({
          reservationId: reservation.id,
          cookie: staffCookie,
          body,
        })).status,
      ).toBe(400);
    }

    const recordedResponse = await callRoute({
      reservationId: reservation.id,
      cookie: staffCookie,
    });
    expect(recordedResponse.status).toBe(200);
    expect(recordedResponse.headers.get("cache-control")).toBe(
      "no-store, max-age=0",
    );
    const recorded = (await recordedResponse.json()) as {
      reservationVersion: number;
      arrivedAt: string;
    };
    expect(new Date(recorded.arrivedAt).toISOString()).toBe(recorded.arrivedAt);
    const noOpResponse = await callRoute({
      reservationId: reservation.id,
      cookie: adminCookie,
      body: { version: 1, arrived: true },
    });
    await expect(noOpResponse.json()).resolves.toMatchObject({ changed: false });
    expect(
      (await callRoute({
        reservationId: reservation.id,
        cookie: staffCookie,
        body: { version: 1, arrived: false },
      })).status,
    ).toBe(409);

    const other = await createReservation({ targetRestaurantId: otherRestaurantId });
    expect(
      (await callRoute({
        reservationId: other.id,
        cookie: staffCookie,
      })).status,
    ).toBe(404);

    const failing = await createReservation();
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION t03_route_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.reservation_id = '${failing.id}'::uuid THEN
          RAISE EXCEPTION 'synthetic safe route failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER t03_route_audit_failure
      BEFORE INSERT ON reservation_audit_events
      FOR EACH ROW EXECUTE FUNCTION t03_route_audit_failure();
    `);
    try {
      const failure = await callRoute({
        reservationId: failing.id,
        cookie: staffCookie,
      });
      expect(failure.status).toBe(500);
      const body = JSON.stringify(await failure.json());
      expect(body).toContain("Non è stato possibile aggiornare");
      expect(body).not.toMatch(/synthetic|database|prisma|stack/iu);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS t03_route_audit_failure ON reservation_audit_events`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS t03_route_audit_failure()`,
      );
    }
  });
});
