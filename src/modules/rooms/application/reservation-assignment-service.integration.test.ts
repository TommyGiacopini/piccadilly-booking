import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DELETE as deleteAssignmentRoute,
  GET as getAssignmentRoute,
  PUT as putAssignmentRoute,
} from "@/app/api/staff/reservations/[id]/assignment/route";
import {
  getAuditEventDetail,
  listAuditEvents,
} from "@/modules/audit/application/audit-query-service";
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
import {
  changeManagedUserRole,
  changeManagedUserStatus,
} from "@/modules/identity/application/identity-service";
import {
  cancelStaffReservation,
  getStaffReservation,
  updateStaffReservation,
} from "@/modules/reservations/application/staff-reservation-service";
import {
  cancelManagedPublicReservation,
  updateManagedPublicReservation,
} from "@/modules/reservations/application/public-reservation-service";
import {
  deriveManagementToken,
  hashManagementToken,
} from "@/modules/reservations/domain/management-token";
import { managementViewExpiry } from "@/modules/reservations/domain/management-time";
import { ReservationAssignmentError } from "@/modules/rooms/application/reservation-assignment-errors";
import { putReservationArrival } from "@/modules/reservations/application/reservation-arrival-service";
import {
  deleteReservationAssignment,
  getReservationAssignmentContext,
  putReservationAssignment,
} from "@/modules/rooms/application/reservation-assignment-service";
import {
  applyRoomConfigurationChange,
  previewRoomConfigurationChange,
} from "@/modules/rooms/application/room-configuration-service";
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
const concurrentActorId = randomUUID();
const roomOneId = randomUUID();
const roomTwoId = randomUUID();
const unavailableRoomId = randomUUID();
const otherRoomId = randomUUID();
const tableOneId = randomUUID();
const tableTwoId = randomUUID();
const tableThreeId = randomUUID();
const inactiveTableId = randomUUID();
const otherTableId = randomUUID();
const futureDate = "2099-06-16";
const historicalDate = "2098-06-16";
const now = new Date("2099-06-15T10:00:00.000Z");
let staffCookie = "";
let adminCookie = "";
let otherStaffCookie = "";
const originalAppEnvironment = process.env.APP_ENV;
const originalAuthRateLimitSecret = process.env.AUTH_RATE_LIMIT_SECRET;

const staffActor = { id: staffId, restaurantId };
const adminActor = { id: adminId, restaurantId };
const disabledActor = { id: disabledId, restaurantId };
const mustChangeActor = { id: mustChangeId, restaurantId };
const otherStaffActor = { id: otherStaffId, restaurantId: otherRestaurantId };
const concurrentActor = { id: concurrentActorId, restaurantId };

function bookingSettingsData() {
  return {
    rollingCapacityCovers: 30,
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

async function createReservation(
  overrides: {
    restaurantId?: string;
    createdByUserId?: string;
    localDate?: string;
    serviceType?: "LUNCH" | "DINNER";
    arrivalTime?: string;
    status?: "CONFIRMED" | "CANCELLED";
    origin?: "STAFF" | "PUBLIC";
    partySize?: number;
    roomCode?: string;
  } = {},
) {
  const targetRestaurantId = overrides.restaurantId ?? restaurantId;
  const status = overrides.status ?? "CONFIRMED";
  return prisma.reservation.create({
    data: {
      restaurantId: targetRestaurantId,
      localDate: localDateToDatabase(overrides.localDate ?? futureDate),
      serviceType: overrides.serviceType ?? "DINNER",
      arrivalTime: operationalTimeToDatabase(overrides.arrivalTime ?? "19:00"),
      partySize: overrides.partySize ?? 4,
      status,
      origin: overrides.origin ?? "STAFF",
      customerFirstName: "Cliente",
      customerLastName: "Assegnazione Fittizia",
      customerPhone: "+39 000 000 1010",
      customerEmail: "assignment@example.invalid",
      notes: "Nota pubblica fittizia",
      preferences: JSON.stringify({
        roomCode: overrides.roomCode ?? "sala-2",
        highChair: false,
        stroller: false,
        accessibility: false,
        children: false,
        celebration: null,
        animals: false,
      }),
      allergies: JSON.stringify({
        celiac: false,
        allergies: null,
        intolerances: null,
      }),
      privacyPolicyVersion: "m10-a-test-privacy-v1",
      privacyConsentAt: now,
      privacyConsentMethod:
        overrides.origin === "PUBLIC" ? "WEB_CHECKBOX" : "STAFF_RECORDED",
      termsPolicyVersion:
        overrides.origin === "PUBLIC" ? "m10-b-test-terms-v1" : null,
      termsConsentAt: overrides.origin === "PUBLIC" ? now : null,
      termsConsentMethod:
        overrides.origin === "PUBLIC" ? "WEB_CHECKBOX" : null,
      consentLanguage: overrides.origin === "PUBLIC" ? "it" : null,
      createdByUserId:
        overrides.origin === "PUBLIC"
          ? null
          : overrides.createdByUserId ??
            (targetRestaurantId === restaurantId ? staffId : otherStaffId),
      cancelledAt: status === "CANCELLED" ? now : null,
    },
  });
}

function putPayload(
  version: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    version,
    roomId: roomOneId,
    tableIds: [tableOneId],
    internalNotes: "Nota interna fittizia M10-A",
    ...overrides,
  };
}

function staffUpdatePayload(
  version: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    version,
    localDate: futureDate,
    serviceType: "DINNER",
    arrivalTime: "19:00",
    partySize: 4,
    childrenCount: null,
    gameRoomPreference: null,
    customerFirstName: "Cliente",
    customerLastName: "Assegnazione Fittizia",
    customerPhone: "+39 000 000 1010",
    customerEmail: "assignment@example.invalid",
    highChair: false,
    stroller: false,
    accessibility: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: "Nota pubblica fittizia",
    capacityOverride: false,
    capacityOverrideReason: null,
    ...overrides,
  };
}

function publicUpdatePayload(overrides: Record<string, unknown> = {}) {
  return {
    localDate: futureDate,
    serviceType: "DINNER",
    arrivalTime: "19:00",
    partySize: 4,
    childrenCount: null,
    gameRoomPreference: null,
    highChair: false,
    stroller: false,
    accessibility: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: "Nota pubblica fittizia",
    ...overrides,
  };
}

async function createPublicManagementToken(
  reservationId: string,
  schedule: { localDate?: string; arrivalTime?: string } = {},
) {
  const rawToken = deriveManagementToken(
    reservationId,
    "m10-b-public-management-secret-fixture-000000000000000000000000",
  );
  const viewExpiresAt = managementViewExpiry({
    localDate: schedule.localDate ?? futureDate,
    arrivalTime: schedule.arrivalTime ?? "19:00",
    timezone: "Europe/Rome",
    durationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
  });
  await prisma.reservationManagementToken.create({
    data: {
      reservationId,
      tokenHash: hashManagementToken(rawToken),
      createdAt: now,
      viewExpiresAt,
    },
  });
  return { rawToken, viewExpiresAt };
}

function fulfilledCount(results: PromiseSettledResult<unknown>[]): number {
  return results.filter((result) => result.status === "fulfilled").length;
}

function assignmentMutationRequest(input: {
  cookie?: string;
  reservationId: string;
  method: "PUT" | "DELETE";
  body: Record<string, unknown>;
  origin?: string;
  contentType?: string;
}): Request {
  const headers = new Headers({
    origin: input.origin ?? "http://localhost:4000",
    "content-type": input.contentType ?? "application/json",
  });
  if (input.cookie) headers.set("cookie", input.cookie);

  return new Request(
    `http://localhost:4000/api/staff/reservations/${input.reservationId}/assignment`,
    {
      method: input.method,
      headers,
      body: JSON.stringify(input.body),
    },
  );
}

async function databaseFingerprint() {
  const tenant = { in: [restaurantId, otherRestaurantId] };
  const [
    reservations,
    assignments,
    assignmentTables,
    rooms,
    tables,
    instances,
    availabilities,
    audits,
    idempotency,
    settings,
    schedules,
  ] = await Promise.all([
    prisma.reservation.findMany({
      where: { restaurantId: tenant },
      orderBy: { id: "asc" },
    }),
    prisma.reservationAssignment.findMany({
      where: { restaurantId: tenant },
      orderBy: { id: "asc" },
    }),
    prisma.reservationAssignmentTable.findMany({
      where: { restaurantId: tenant },
      orderBy: [
        { assignmentId: "asc" },
        { diningTableId: "asc" },
      ],
    }),
    prisma.room.findMany({
      where: { restaurantId: tenant },
      orderBy: { id: "asc" },
    }),
    prisma.diningTable.findMany({
      where: { room: { restaurantId: tenant } },
      orderBy: { id: "asc" },
    }),
    prisma.serviceInstance.findMany({
      where: { restaurantId: tenant },
      orderBy: { id: "asc" },
    }),
    prisma.serviceRoomAvailability.findMany({
      where: { restaurantId: tenant },
      orderBy: { id: "asc" },
    }),
    prisma.reservationAuditEvent.findMany({
      where: { restaurantId: tenant },
      orderBy: { id: "asc" },
    }),
    prisma.reservationIdempotencyKey.findMany({
      where: { restaurantId: tenant },
      orderBy: { id: "asc" },
    }),
    prisma.restaurantBookingSettings.findMany({
      where: { restaurantId: tenant },
      orderBy: { restaurantId: "asc" },
    }),
    prisma.weeklyServiceSchedule.findMany({
      where: { restaurantId: tenant },
      orderBy: { id: "asc" },
    }),
  ]);

  return JSON.stringify({
    reservations,
    assignments,
    assignmentTables,
    rooms,
    tables,
    instances,
    availabilities,
    audits,
    idempotency,
    settings,
    schedules,
  });
}

describe.sequential(
  "M10-A reservation assignment workflow with real PostgreSQL",
  () => {
    beforeAll(async () => {
      process.env.APP_ENV = "development";
      process.env.AUTH_RATE_LIMIT_SECRET =
        "m10-a-local-fixture-rate-limit-secret-only";
      await prisma.restaurant.createMany({
        data: [
          {
            id: restaurantId,
            name: "M10-A Restaurant Fixture",
            timezone: "Europe/Rome",
          },
          {
            id: otherRestaurantId,
            name: "M10-A Other Restaurant Fixture",
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
      await prisma.room.createMany({
        data: [
          {
            id: roomOneId,
            restaurantId,
            code: "sala-1",
            name: "Sala 1 Fixture",
            displayOrder: 1,
            isActive: true,
            serviceAvailabilityPolicy: "DEFAULT_AVAILABLE",
          },
          {
            id: roomTwoId,
            restaurantId,
            code: "sala-2",
            name: "Sala 2 Fixture",
            displayOrder: 2,
            isActive: true,
            serviceAvailabilityPolicy: "DEFAULT_AVAILABLE",
          },
          {
            id: unavailableRoomId,
            restaurantId,
            code: "terrazzo",
            name: "Terrazzo Fixture",
            displayOrder: 3,
            isActive: true,
            serviceAvailabilityPolicy: "EXPLICIT_ONLY",
          },
          {
            id: otherRoomId,
            restaurantId: otherRestaurantId,
            code: "sala-1",
            name: "Other Sala 1 Fixture",
            displayOrder: 1,
            isActive: true,
            serviceAvailabilityPolicy: "DEFAULT_AVAILABLE",
          },
        ],
      });
      await prisma.diningTable.createMany({
        data: [
          {
            id: tableOneId,
            roomId: roomOneId,
            name: "M10-A-T1",
            minimumSeats: 1,
            maximumSeats: 2,
            displayOrder: 1,
            isActive: true,
          },
          {
            id: tableTwoId,
            roomId: roomOneId,
            name: "M10-A-T2",
            minimumSeats: 2,
            maximumSeats: 4,
            displayOrder: 2,
            isActive: true,
          },
          {
            id: inactiveTableId,
            roomId: roomOneId,
            name: "M10-A-INACTIVE",
            minimumSeats: 1,
            maximumSeats: 1,
            displayOrder: 3,
            isActive: false,
          },
          {
            id: tableThreeId,
            roomId: roomTwoId,
            name: "M10-A-T3",
            minimumSeats: 1,
            maximumSeats: 2,
            displayOrder: 1,
            isActive: true,
          },
          {
            id: otherTableId,
            roomId: otherRoomId,
            name: "M10-A-OTHER",
            minimumSeats: 1,
            maximumSeats: 2,
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
            username: `m10a.staff.${staffId.slice(0, 8)}`,
            passwordHash: "not-used-m10-a-fixture",
            role: "STAFF",
          },
          {
            id: adminId,
            restaurantId,
            username: `m10a.admin.${adminId.slice(0, 8)}`,
            passwordHash: "not-used-m10-a-fixture",
            role: "ADMIN",
          },
          {
            id: disabledId,
            restaurantId,
            username: `m10a.disabled.${disabledId.slice(0, 8)}`,
            passwordHash: "not-used-m10-a-fixture",
            role: "STAFF",
            isActive: false,
            disabledAt: now,
          },
          {
            id: mustChangeId,
            restaurantId,
            username: `m10a.change.${mustChangeId.slice(0, 8)}`,
            passwordHash: "not-used-m10-a-fixture",
            role: "STAFF",
            mustChangePassword: true,
          },
          {
            id: otherStaffId,
            restaurantId: otherRestaurantId,
            username: `m10a.other.${otherStaffId.slice(0, 8)}`,
            passwordHash: "not-used-m10-a-fixture",
            role: "STAFF",
          },
          {
            id: concurrentActorId,
            restaurantId,
            username: `m10a.concurrent.${concurrentActorId.slice(0, 8)}`,
            passwordHash: "not-used-m10-a-fixture",
            role: "STAFF",
          },
        ],
      });
      const [staffSession, adminSession, otherStaffSession] =
        await Promise.all([
          createSessionForUser(staffId),
          createSessionForUser(adminId),
          createSessionForUser(otherStaffId),
        ]);
      const cookieName = getSessionCookieName(getAppEnvironment());
      staffCookie = `${cookieName}=${staffSession.token}`;
      adminCookie = `${cookieName}=${adminSession.token}`;
      otherStaffCookie = `${cookieName}=${otherStaffSession.token}`;
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
      await prisma.reservationAssignmentTable.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.reservationAssignment.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.reservationAuditEvent.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.auditEvent.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.reservationIdempotencyKey.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.reservation.deleteMany({ where: { restaurantId: tenant } });
      await prisma.serviceRoomAvailability.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.serviceInstance.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.room.update({
        where: { id: roomOneId },
        data: { isActive: true },
      });
      await prisma.room.update({
        where: { id: roomTwoId },
        data: { isActive: true },
      });
      await prisma.diningTable.updateMany({
        where: { id: { in: [tableOneId, tableTwoId, tableThreeId] } },
        data: { isActive: true },
      });
      await prisma.diningTable.update({
        where: { id: inactiveTableId },
        data: { isActive: false },
      });
      await prisma.user.update({
        where: { id: staffId },
        data: {
          role: "STAFF",
          isActive: true,
          disabledAt: null,
          mustChangePassword: false,
        },
      });
      await prisma.user.update({
        where: { id: concurrentActorId },
        data: {
          role: "STAFF",
          isActive: true,
          disabledAt: null,
          mustChangePassword: false,
        },
      });
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
      await prisma.reservationAssignmentTable.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.reservationAssignment.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.reservationAuditEvent.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.auditEvent.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.reservationIdempotencyKey.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.reservation.deleteMany({ where: { restaurantId: tenant } });
      await prisma.serviceRoomAvailability.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.serviceInstance.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.session.deleteMany({
        where: {
          userId: {
            in: [
              staffId,
              adminId,
              disabledId,
              mustChangeId,
              otherStaffId,
              concurrentActorId,
            ],
          },
        },
      });
      await prisma.diningTable.deleteMany({
        where: {
          id: {
            in: [
              tableOneId,
              tableTwoId,
              tableThreeId,
              inactiveTableId,
              otherTableId,
            ],
          },
        },
      });
      await prisma.user.deleteMany({
        where: {
          id: {
            in: [
              staffId,
              adminId,
              disabledId,
              mustChangeId,
              otherStaffId,
              concurrentActorId,
            ],
          },
        },
      });
      await prisma.room.deleteMany({
        where: {
          id: { in: [roomOneId, roomTwoId, unavailableRoomId, otherRoomId] },
        },
      });
      await prisma.weeklyServiceSchedule.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.restaurantBookingSettings.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.restaurantNotificationSettings.deleteMany({
        where: { restaurantId: tenant },
      });
      await prisma.restaurant.deleteMany({ where: { id: tenant } });
      await prisma.$disconnect();
      if (originalAppEnvironment === undefined) {
        delete process.env.APP_ENV;
      } else {
        process.env.APP_ENV = originalAppEnvironment;
      }
      if (originalAuthRateLimitSecret === undefined) {
        delete process.env.AUTH_RATE_LIMIT_SECRET;
      } else {
        process.env.AUTH_RATE_LIMIT_SECRET = originalAuthRateLimitSecret;
      }
    });

    it("persists all room-only transitions with exactly one version and minimized audit per change", async () => {
      const reservation = await createReservation();
      const call = (version: number, roomId: string, tableIds: string[]) => putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(version, { roomId, tableIds }), now: new Date(now.getTime() + version * 1_000) });
      const steps = [
        { roomId: roomOneId, tableIds: [], action: "ASSIGNED" },
        { roomId: roomOneId, tableIds: [tableOneId], action: "REASSIGNED" },
        { roomId: roomOneId, tableIds: [], action: "REASSIGNED" },
        { roomId: roomTwoId, tableIds: [], action: "REASSIGNED" },
        { roomId: roomOneId, tableIds: [tableOneId], action: "REASSIGNED" },
        { roomId: roomTwoId, tableIds: [], action: "REASSIGNED" },
        { roomId: roomTwoId, tableIds: [tableThreeId], action: "REASSIGNED" },
      ];
      let assignmentId: string | undefined;
      for (const [index, step] of steps.entries()) {
        const version = index + 1;
        const result = await call(version, step.roomId, step.tableIds);
        expect(result).toMatchObject({ changed: true, reservationVersion: version + 1 });
        expect(result.assignment?.room.id).toBe(step.roomId);
        expect(result.assignment?.tables.map(({ id }) => id)).toEqual(step.tableIds);
        assignmentId ??= result.assignment!.id;
        expect(result.assignment?.id).toBe(assignmentId);
        await expect(prisma.reservationAssignmentTable.count({ where: { assignmentId } })).resolves.toBe(step.tableIds.length);
        const audits = await prisma.reservationAuditEvent.findMany({ where: { reservationId: reservation.id }, orderBy: { createdAt: "asc" } });
        expect(audits).toHaveLength(version);
        expect(audits[index]).toMatchObject({ action: step.action, newState: { assignment: { tableCount: step.tableIds.length, tableIds: step.tableIds } } });
      }
      await call(8, roomTwoId, []);
      const clear = await deleteReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: { version: 9 }, now });
      expect(clear).toEqual({ changed: true, reservationVersion: 10, assignment: null });
      await expect(prisma.reservationAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).resolves.toMatchObject({ clearedAt: now });
      const reactivated = await call(10, roomOneId, []);
      expect(reactivated.assignment).toMatchObject({ id: assignmentId, tables: [] });
      const actions = await prisma.reservationAuditEvent.findMany({ where: { reservationId: reservation.id }, select: { action: true } });
      expect(actions.filter(({ action }) => action === "ASSIGNED")).toHaveLength(2);
      expect(actions.filter(({ action }) => action === "UNASSIGNED")).toHaveLength(1);
    });

    it.each([{ tableIds: [] }, { tableIds: [tableOneId] }])("accepts stale identical PUT $tableIds without any timestamp/version/audit write", async ({ tableIds }) => {
      const reservation = await createReservation();
      const rawPayload = putPayload(1, { tableIds });
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload, now });
      const before = await databaseFingerprint();
      const response = await putAssignmentRoute(assignmentMutationRequest({ cookie: staffCookie, reservationId: reservation.id, method: "PUT", body: rawPayload }), { params: Promise.resolve({ id: reservation.id }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ changed: false, reservationVersion: 2 });
      expect(await databaseFingerprint()).toBe(before);
      await expect(putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: { ...rawPayload, internalNotes: "Nuova nota sintetica" }, now })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      await deleteReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: { version: 2 }, now });
      const afterClear = await databaseFingerprint();
      expect(await deleteReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: { version: 1 }, now })).toMatchObject({ changed: false, reservationVersion: 3 });
      expect(await databaseFingerprint()).toBe(afterClear);
    });

    it("converges identical concurrent room-only PUT to one write and one stale no-op", async () => {
      const reservation = await createReservation();
      const results = await Promise.all([staffActor, adminActor].map((actor) => putReservationAssignment({ actor, reservationId: reservation.id, rawPayload: putPayload(1, { tableIds: [] }), now })));
      expect(results.map(({ changed }) => changed).sort()).toEqual([false, true]);
      expect(results.map(({ reservationVersion }) => reservationVersion)).toEqual([2, 2]);
      await expect(prisma.reservationAuditEvent.count({ where: { reservationId: reservation.id, action: "ASSIGNED" } })).resolves.toBe(1);
      await expect(prisma.reservationAssignmentTable.count({ where: { assignment: { reservationId: reservation.id } } })).resolves.toBe(0);
    });

    it("rejects opposite concurrent room-only states with one VERSION_CONFLICT", async () => {
      const reservation = await createReservation();
      const results = await Promise.allSettled([roomOneId, roomTwoId].map((roomId) => putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1, { roomId, tableIds: [] }), now })));
      expect(fulfilledCount(results)).toBe(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
      await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({ version: 2 });
      await expect(prisma.reservationAuditEvent.count({ where: { reservationId: reservation.id } })).resolves.toBe(1);
    });

    it.each([{ arrivalTime: "19:15" }, { serviceType: "LUNCH", arrivalTime: "12:30" }, { localDate: "2099-06-17" }])("clears room-only atomically on real schedule change %j", async (changed) => {
      const reservation = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1, { tableIds: [] }), now });
      const result = await updateStaffReservation({ actor: { ...staffActor, role: "STAFF" }, reservationId: reservation.id, rawPayload: staffUpdatePayload(2, changed), now });
      expect(result).toMatchObject({ changed: true, reservation: { version: 3 } });
      expect((await getReservationAssignmentContext({ actor: staffActor, reservationId: reservation.id, now })).assignment).toBeNull();
      const audits = await prisma.reservationAuditEvent.findMany({ where: { reservationId: reservation.id, action: { in: ["UPDATED", "UNASSIGNED"] } } });
      expect(audits).toHaveLength(2);
      expect(new Set(audits.map(({ correlationId }) => correlationId)).size).toBe(1);
      expect(audits.find(({ action }) => action === "UNASSIGNED")?.newState).toEqual({ assignment: null, reason: "RESERVATION_SCHEDULE_CHANGED" });
    });

    it("keeps room-only cancelled history and forbids both assignment mutations", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1, { tableIds: [] }), now });
      await cancelStaffReservation({ actor: { ...staffActor, role: "STAFF" }, reservationId: reservation.id, rawPayload: { version: 2 }, now });
      expect((await getReservationAssignmentContext({ actor: staffActor, reservationId: reservation.id, now })).assignment).toMatchObject({ room: { id: roomOneId }, tables: [] });
      const before = await databaseFingerprint();
      for (const method of ["PUT", "DELETE"] as const) {
        const request = assignmentMutationRequest({ cookie: staffCookie, reservationId: reservation.id, method, body: method === "PUT" ? putPayload(3, { tableIds: [] }) : { version: 3 } });
        const response = await (method === "PUT" ? putAssignmentRoute : deleteAssignmentRoute)(request, { params: Promise.resolve({ id: reservation.id }) });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "RESERVATION_CANCELLED" });
      }
      expect(await databaseFingerprint()).toBe(before);
    });

    it("retains grandfathered room-only state as a stale no-op but rejects new invalid rooms", async () => {
      const reservation = await createReservation();
      const rawPayload = putPayload(1, { tableIds: [] });
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload, now });
      await prisma.room.update({ where: { id: roomOneId }, data: { isActive: false } });
      const before = await databaseFingerprint();
      expect(await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload, now })).toMatchObject({ changed: false, assignment: { hasInactiveReferences: true, tables: [] } });
      expect(await databaseFingerprint()).toBe(before);
      const other = await createReservation();
      await expect(putReservationAssignment({ actor: staffActor, reservationId: other.id, rawPayload, now })).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
      await expect(putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(2, { roomId: unavailableRoomId, tableIds: [] }), now })).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
    });

    it("preserves arrival through room-only/table/clear changes and emits no notification intent or delivery", async () => {
      const reservation = await createReservation();
      const recorded = await putReservationArrival({ actor: staffActor, reservationId: reservation.id, rawPayload: { version: 1, arrived: true }, now });
      expect(recorded).toMatchObject({ changed: true });
      const arrival = (await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).arrivedAt;
      for (const [index, tableIds] of [[], [tableOneId], []].entries()) {
        await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(index + 2, { tableIds }), now });
        await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({ arrivedAt: arrival });
      }
      await deleteReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: { version: 5 }, now });
      await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({ arrivedAt: arrival, version: 6 });
      await expect(prisma.notificationOutbox.count({ where: { reservationId: reservation.id } })).resolves.toBe(0);
      await expect(prisma.notificationAttempt.count({ where: { restaurantId } })).resolves.toBe(0);
      await expect(prisma.notificationSimulationReceipt.count({ where: { restaurantId } })).resolves.toBe(0);
    });

    it("rolls back removing tables to room-only including assignment and reservation timestamps on audit failure", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1), now });
      const before = await databaseFingerprint();
      await prisma.$executeRawUnsafe(`CREATE FUNCTION t04_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.restaurant_id = '${restaurantId}'::uuid AND NEW.action::text = 'REASSIGNED' THEN RAISE EXCEPTION 'synthetic T04 audit failure'; END IF; RETURN NEW; END; $$;`);
      await prisma.$executeRawUnsafe("CREATE TRIGGER t04_reject_audit BEFORE INSERT ON reservation_audit_events FOR EACH ROW EXECUTE FUNCTION t04_reject_audit()");
      try {
        await expect(putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(2, { tableIds: [] }), now: new Date(now.getTime() + 1_000) })).rejects.toThrow("synthetic T04 audit failure");
      } finally {
        await prisma.$executeRawUnsafe("DROP TRIGGER t04_reject_audit ON reservation_audit_events");
        await prisma.$executeRawUnsafe("DROP FUNCTION t04_reject_audit()");
      }
      expect(await databaseFingerprint()).toBe(before);
    });

    it.each([
      { childrenCount: null, gameRoomPreference: null },
      { childrenCount: 0, gameRoomPreference: null },
      { childrenCount: 2, gameRoomPreference: true },
      { childrenCount: 2, gameRoomPreference: false },
    ].flatMap((composition) => [false, true].map((arrived) => ({ ...composition, arrived }))))(
      "preserves Foundation composition %j through room-only mutation and stale no-op",
      async ({ childrenCount, gameRoomPreference, arrived }) => {
        const reservation = await createReservation();
        await prisma.reservation.update({ where: { id: reservation.id }, data: { childrenCount, gameRoomPreference } });
        if (arrived) await putReservationArrival({ actor: staffActor, reservationId: reservation.id, rawPayload: { version: 1, arrived: true }, now });
        const before = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
        const result = await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(before.version, { roomId: roomTwoId, tableIds: [] }), now });
        const after = await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } });
        expect(after).toEqual({ ...before, version: before.version + 1, updatedAt: after.updatedAt });
        expect(result.assignment).toMatchObject({ room: { id: roomTwoId }, tables: [] });
        const dto = await getStaffReservation({ actor: { ...staffActor, role: "STAFF" }, reservationId: reservation.id });
        expect(dto).toMatchObject({ childrenCount, gameRoomPreference, arrivedAt: before.arrivedAt?.toISOString() ?? null });
        const fingerprint = await databaseFingerprint();
        expect(await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1, { roomId: roomTwoId, tableIds: [] }), now })).toMatchObject({ changed: false, reservationVersion: before.version + 1 });
        expect(await databaseFingerprint()).toBe(fingerprint);
      },
    );

    it.each([
      { label: "plaintext", preferences: "Preferenza storica sintetica", allergies: "Allergia storica sintetica" },
      { label: "plaintext1000", preferences: "P".repeat(1000), allergies: "H".repeat(1000) },
      { label: "JSON", preferences: JSON.stringify({ roomCode: "sala-3", children: true, highChair: true, stroller: false, accessibility: false, celebration: null, animals: false }), allergies: JSON.stringify({ celiac: true, allergies: "Sintetica", intolerances: null }) },
      { label: "escaped-envelope", preferences: JSON.stringify({ roomCode: "", children: true, highChair: false, stroller: false, accessibility: false, celebration: null, animals: false, legacyText: '"'.repeat(1000) }), allergies: JSON.stringify({ celiac: false, allergies: '"'.repeat(300), intolerances: "\\".repeat(300), legacyText: "H".repeat(1000) }) },
    ])("preserves byte-identical legacy $label preferences/allergies without client echo", async ({ label, preferences, allergies }) => {
      if (label === "escaped-envelope") { expect(preferences.length).toBeGreaterThan(1000); expect(allergies.length).toBeGreaterThan(1000); }
      const reservation = await createReservation();
      await prisma.reservation.update({ where: { id: reservation.id }, data: { preferences, allergies } });
      for (const version of [1, 1]) {
        await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(version, { tableIds: [] }), now });
        await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({ preferences, allergies });
      }
      const dto = await getStaffReservation({ actor: { ...staffActor, role: "STAFF" }, reservationId: reservation.id });
      expect(dto).not.toHaveProperty("preferences");
      expect(dto).not.toHaveProperty("legacyText");
      const context = await getReservationAssignmentContext({ actor: staffActor, reservationId: reservation.id, now });
      expect(context.reservation).not.toHaveProperty("allergies");
      expect(context.assignment).not.toHaveProperty("preferences");
    });

    it.each(["inactive", "password", "tenant"])("rechecks %s actor before an otherwise identical stale no-op", async (guard) => {
      const reservation = await createReservation();
      const payload = putPayload(1, { tableIds: [] });
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: payload, now });
      const data = guard === "inactive" ? { isActive: false } : guard === "password" ? { mustChangePassword: true } : { restaurantId: otherRestaurantId };
      await prisma.user.update({ where: { id: concurrentActorId }, data });
      try {
        const before = await databaseFingerprint();
        await expect(putReservationAssignment({ actor: concurrentActor, reservationId: reservation.id, rawPayload: payload, now })).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await databaseFingerprint()).toBe(before);
      } finally {
        await prisma.user.update({ where: { id: concurrentActorId }, data: { isActive: true, mustChangePassword: false, restaurantId } });
      }
    });

    it("serializes competing room-only and table desired states without last-write-wins", async () => {
      const reservation = await createReservation();
      const results = await Promise.allSettled([[], [tableOneId]].map((tableIds) => putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1, { tableIds }), now })));
      expect(fulfilledCount(results)).toBe(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
      await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({ version: 2 });
      await expect(prisma.reservationAuditEvent.count({ where: { reservationId: reservation.id } })).resolves.toBe(1);
    });

    it.each(["create", "reactivate", "change-room", "delete", "staff-reschedule", "management-reschedule"])("rolls back room-only %s including Foundation, arrival and token on audit failure", async (operation) => {
      const reservation = await createReservation({ origin: "PUBLIC" });
      const token = await createPublicManagementToken(reservation.id);
      await prisma.reservation.update({ where: { id: reservation.id }, data: { childrenCount: 2, gameRoomPreference: true, preferences: "P".repeat(1000), allergies: "H".repeat(1000) } });
      await putReservationArrival({ actor: staffActor, reservationId: reservation.id, rawPayload: { version: 1, arrived: true }, now });
      let version = 2;
      if (operation !== "create") { await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(version++, { tableIds: [] }), now }); }
      if (operation === "reactivate") { await deleteReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: { version: version++ }, now }); }
      const before = await databaseFingerprint();
      const tokenBefore = await prisma.reservationManagementToken.findUniqueOrThrow({ where: { reservationId: reservation.id } });
      await prisma.$executeRawUnsafe(`CREATE FUNCTION t04_all_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.restaurant_id = '${restaurantId}'::uuid AND NEW.action::text IN ('ASSIGNED','REASSIGNED','UNASSIGNED') THEN RAISE EXCEPTION 'synthetic T04 rollback'; END IF; RETURN NEW; END; $$`);
      await prisma.$executeRawUnsafe("CREATE TRIGGER t04_all_audit_failure BEFORE INSERT ON reservation_audit_events FOR EACH ROW EXECUTE FUNCTION t04_all_audit_failure()");
      try {
        const mutation = operation === "delete"
          ? deleteReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: { version }, now })
          : operation === "staff-reschedule"
            ? updateStaffReservation({ actor: { ...staffActor, role: "STAFF" }, reservationId: reservation.id, rawPayload: staffUpdatePayload(version, { localDate: "2099-06-17", childrenCount: 2, gameRoomPreference: true }), now })
            : operation === "management-reschedule"
              ? updateManagedPublicReservation({ restaurantId, rawToken: token.rawToken, rawPayload: publicUpdatePayload({ localDate: "2099-06-17", childrenCount: 2, gameRoomPreference: true }), now })
              : putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(version, { roomId: operation === "change-room" ? roomTwoId : roomOneId, tableIds: [] }), now });
        await expect(mutation).rejects.toThrow("synthetic T04 rollback");
      } finally {
        await prisma.$executeRawUnsafe("DROP TRIGGER t04_all_audit_failure ON reservation_audit_events");
        await prisma.$executeRawUnsafe("DROP FUNCTION t04_all_audit_failure()");
      }
      expect(await databaseFingerprint()).toBe(before);
      expect(await prisma.reservationManagementToken.findUniqueOrThrow({ where: { reservationId: reservation.id } })).toEqual(tokenBefore);
    });

    it.each(["STAFF", "MANAGEMENT"])("preserves arrived room-only on %s non-schedule composition, games and notes update", async (channel) => {
      const reservation = await createReservation({ origin: channel === "MANAGEMENT" ? "PUBLIC" : "STAFF" });
      const token = channel === "MANAGEMENT" ? await createPublicManagementToken(reservation.id) : null;
      await putReservationArrival({ actor: staffActor, reservationId: reservation.id, rawPayload: { version: 1, arrived: true }, now });
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(2, { tableIds: [] }), now });
      const before = await prisma.reservationAssignment.findUniqueOrThrow({ where: { restaurantId_reservationId: { restaurantId, reservationId: reservation.id } } });
      const changed = { childrenCount: 2, gameRoomPreference: true, notes: "Nota Foundation sintetica aggiornata" };
      if (token) await updateManagedPublicReservation({ restaurantId, rawToken: token.rawToken, rawPayload: publicUpdatePayload(changed), now });
      else await updateStaffReservation({ actor: { ...staffActor, role: "STAFF" }, reservationId: reservation.id, rawPayload: staffUpdatePayload(3, changed), now });
      expect(await prisma.reservationAssignment.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
      await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({ version: 4, arrivedAt: now, ...changed });
      await expect(prisma.reservationAuditEvent.count({ where: { reservationId: reservation.id, action: "UNASSIGNED" } })).resolves.toBe(0);
    });

    it.each([{ localDate: "2099-06-17" }, { serviceType: "LUNCH", arrivalTime: "12:00" }, { arrivalTime: "19:15" }])("clears room-only through canonical management reschedule %j with correlated audit/token", async (changed) => {
      const reservation = await createReservation({ origin: "PUBLIC" });
      const token = await createPublicManagementToken(reservation.id);
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1, { tableIds: [] }), now });
      const dto = await updateManagedPublicReservation({ restaurantId, rawToken: token.rawToken, rawPayload: publicUpdatePayload(changed), now });
      expect(dto).toMatchObject(changed);
      await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({ version: 3 });
      expect(dto).not.toHaveProperty("assignment");
      expect((await getReservationAssignmentContext({ actor: staffActor, reservationId: reservation.id, now })).assignment).toBeNull();
      const audits = await prisma.reservationAuditEvent.findMany({ where: { reservationId: reservation.id, action: { in: ["UPDATED", "UNASSIGNED"] } } });
      expect(audits).toHaveLength(2);
      expect(new Set(audits.map(({ correlationId }) => correlationId)).size).toBe(1);
      expect(audits.find(({ action }) => action === "UNASSIGNED")?.newState).toEqual({ assignment: null, reason: "RESERVATION_SCHEDULE_CHANGED" });
      await expect(prisma.reservationManagementToken.findUniqueOrThrow({ where: { reservationId: reservation.id } })).resolves.toMatchObject({ tokenHash: hashManagementToken(token.rawToken), viewExpiresAt: managementViewExpiry({ localDate: dto.localDate, arrivalTime: dto.arrivalTime, timezone: "Europe/Rome", durationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS }) });
    });

    it("verifies real GET PUT DELETE handler contracts, strict bodies, auth, isolation, no-store and safe failures", async () => {
      const reservation = await createReservation();
      const handlers = { GET: getAssignmentRoute, PUT: putAssignmentRoute, DELETE: deleteAssignmentRoute };
      const call = async (method: keyof typeof handlers, options: { id?: string; cookie?: string; origin?: string; body?: unknown; invalidJson?: boolean; contentType?: string } = {}) => {
        const id = options.id ?? reservation.id;
        const headers = new Headers({ cookie: options.cookie ?? staffCookie, origin: options.origin ?? "http://localhost:4000", "content-type": options.contentType ?? "application/json" });
        const response = await handlers[method](new Request(`http://localhost:4000/api/staff/reservations/${id}/assignment`, { method, headers, ...(method === "GET" ? {} : { body: options.invalidJson ? "{" : JSON.stringify(options.body ?? (method === "PUT" ? putPayload(1, { tableIds: [] }) : { version: 1 })) }) }), { params: Promise.resolve({ id }) });
        expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
        return { status: response.status, body: await response.json() };
      };
      const passwordSession = await createSessionForUser(mustChangeId);
      const passwordCookie = `${getSessionCookieName(getAppEnvironment())}=${passwordSession.token}`;
      for (const method of ["GET", "PUT", "DELETE"] as const) {
        expect(await call(method, { cookie: "" })).toEqual({ status: 401, body: { error: "Unauthorized" } });
        expect(await call(method, { cookie: passwordCookie })).toEqual({ status: 403, body: { error: "PASSWORD_CHANGE_REQUIRED" } });
        expect(await call(method, { id: "invalid" })).toMatchObject({ status: 400, body: { error: "Identificativo non valido." } });
        const missing = await call(method, { id: randomUUID() });
        expect(missing).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
        expect(await call(method, { cookie: otherStaffCookie })).toEqual(missing);
      }
      for (const method of ["PUT", "DELETE"] as const) {
        expect(await call(method, { origin: "https://other.invalid" })).toEqual({ status: 403, body: { error: "Forbidden" } });
        for (const options of [{ invalidJson: true }, { contentType: "text/plain" }, { body: method === "PUT" ? { ...putPayload(1, { tableIds: [] }), extra: true } : { version: 1, extra: true } }]) expect(await call(method, options)).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
      }
      expect(await call("PUT")).toMatchObject({ status: 200, body: { changed: true, reservationVersion: 2, assignment: { tables: [] } } });
      const context = await call("GET");
      expect(context).toMatchObject({ status: 200, body: { reservation: { version: 2 }, assignment: { tables: [] } } });
      expect(context.body.reservation).not.toHaveProperty("restaurantId");
      expect(context.body.assignment).not.toHaveProperty("reservationId");
      expect(await call("PUT")).toMatchObject({ status: 200, body: { changed: false, reservationVersion: 2 } });
      expect(await call("PUT", { body: putPayload(1, { tableIds: [], internalNotes: "Changed stale" }) })).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
      expect(await call("DELETE")).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
      expect(await call("PUT", { body: putPayload(2, { roomId: unavailableRoomId, tableIds: [] }) })).toMatchObject({ status: 409, body: { code: "ROOM_UNAVAILABLE" } });
      for (const body of [putPayload(2, { roomId: roomTwoId }), putPayload(2, { roomId: otherRoomId, tableIds: [] }), putPayload(2, { tableIds: [otherTableId] }), putPayload(2, { roomId: randomUUID(), tableIds: [] })]) expect(await call("PUT", { body })).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
      const before = await databaseFingerprint();
      await prisma.$executeRawUnsafe(`CREATE FUNCTION t04_http_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.restaurant_id = '${restaurantId}'::uuid THEN RAISE EXCEPTION 'synthetic T04 private failure'; END IF; RETURN NEW; END; $$`);
      await prisma.$executeRawUnsafe("CREATE TRIGGER t04_http_audit_failure BEFORE INSERT ON reservation_audit_events FOR EACH ROW EXECUTE FUNCTION t04_http_audit_failure()");
      try {
        for (const method of ["PUT", "DELETE"] as const) expect(await call(method, { body: method === "PUT" ? putPayload(2, { tableIds: [], internalNotes: "Real change" }) : { version: 2 } })).toEqual({ status: 500, body: { error: "Non è stato possibile gestire l'assegnazione." } });
      } finally {
        await prisma.$executeRawUnsafe("DROP TRIGGER t04_http_audit_failure ON reservation_audit_events");
        await prisma.$executeRawUnsafe("DROP FUNCTION t04_http_audit_failure()");
      }
      // Real database read failure, restored in finally on the isolated test database.
      await prisma.$executeRawUnsafe("ALTER TABLE rooms RENAME TO t04_http_rooms_fault");
      try { expect(await call("GET")).toEqual({ status: 500, body: { error: "Non è stato possibile gestire l'assegnazione." } }); } finally { await prisma.$executeRawUnsafe("ALTER TABLE t04_http_rooms_fault RENAME TO rooms"); }
      expect(await databaseFingerprint()).toBe(before);
      expect(await call("DELETE", { body: { version: 2 } })).toEqual({ status: 200, body: { changed: true, reservationVersion: 3, assignment: null } });
      expect(await call("DELETE")).toEqual({ status: 200, body: { changed: false, reservationVersion: 3, assignment: null } });
    });

    it("includes room-only solely in room configuration impact without materializing capacity", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1, { tableIds: [] }), now });
      const before = await databaseFingerprint();
      const preview = await previewRoomConfigurationChange(adminActor, { kind: "ROOM_CATALOG", roomId: roomOneId, displayOrder: 1, isActive: false }, { now });
      expect(preview.impact).toMatchObject({ assignmentReservationCount: 1, preferenceReservationCount: 0 });
      expect(preview.impact.items[0]?.classifications).toEqual(["ROOM_DISABLED", "RESERVATION_WITH_AFFECTED_FINAL_ASSIGNMENT"]);
      expect(await databaseFingerprint()).toBe(before);
      await expect(prisma.serviceInstance.count({ where: { restaurantId } })).resolves.toBe(0);
    });

    it("does not emit lifecycle notifications or replace reminders for assignment-only version increments", async () => {
      const reservation = await createReservation();
      const reminder = await prisma.notificationOutbox.create({
        data: {
          restaurantId,
          reservationId: reservation.id,
          eventGroupId: randomUUID(),
          reservationVersion: 1,
          eventType: "RESERVATION_REMINDER",
          source: "STAFF",
          actorUserId: staffId,
          channel: "WHATSAPP",
          strategy: "WHATSAPP_ONLY",
          destination: reservation.customerPhone,
          payloadVersion: 1,
          payload: {
            schemaVersion: 1,
            templateKey: "RESERVATION_REMINDER",
            templateVersion: 1,
            locale: "IT",
            params: {
              customerFirstName: reservation.customerFirstName,
              restaurantName: "M10-A Restaurant Fixture",
              localDate: futureDate,
              serviceType: "DINNER",
              arrivalTime: "19:00",
              partySize: reservation.partySize,
            },
          },
          scheduledAt: new Date("2099-06-16T14:00:00.000Z"),
          availableAt: new Date("2099-06-16T14:00:00.000Z"),
          expiresAt: new Date("2099-06-16T17:00:00.000Z"),
          idempotencyKey: "a".repeat(64),
          originCorrelationId: randomUUID(),
        },
      });

      const assigned = await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });

      expect(assigned.reservationVersion).toBe(2);
      await expect(prisma.notificationOutbox.findMany({ where: { reservationId: reservation.id } })).resolves.toEqual([reminder]);
      await expect(prisma.notificationOutbox.count({ where: { reservationId: reservation.id, eventType: "RESERVATION_UPDATED" } })).resolves.toBe(0);
    });

    it("allows Staff first assignment and exposes preference, seats and minimized audit without materializing", async () => {
      const reservation = await createReservation({ roomCode: "sala-2" });
      const instancesBefore = await prisma.serviceInstance.count({
        where: { restaurantId },
      });
      const result = await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });

      expect(result).toMatchObject({
        changed: true,
        reservationVersion: 2,
        assignment: {
          room: { id: roomOneId, code: "sala-1" },
          tables: [
            {
              id: tableOneId,
              minimumSeats: 1,
              maximumSeats: 2,
            },
          ],
          internalNotes: "Nota interna fittizia M10-A",
        },
      });
      const context = await getReservationAssignmentContext({
        actor: staffActor,
        reservationId: reservation.id,
        now,
      });
      expect(context.reservation.originalRoomPreference).toMatchObject({
        roomCode: "sala-2",
        roomName: "Sala 2 Fixture",
      });
      expect(context.assignment?.room.code).toBe("sala-1");
      expect(context.rooms.flatMap((room) => room.tables)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: tableTwoId,
            minimumSeats: 2,
            maximumSeats: 4,
          }),
        ]),
      );
      await expect(
        prisma.serviceInstance.count({ where: { restaurantId } }),
      ).resolves.toBe(instancesBefore);

      const audit = await prisma.reservationAuditEvent.findFirstOrThrow({
        where: { restaurantId, reservationId: reservation.id },
      });
      expect(audit).toMatchObject({
        action: "ASSIGNED",
        actorUserId: staffId,
        actorRole: "STAFF",
      });
      expect(audit.previousState).toEqual({ assignment: null });
      expect(audit.newState).toEqual({
        assignment: {
          finalRoomCode: "sala-1",
          tableIds: [tableOneId],
          tableCount: 1,
          internalNotesPresent: true,
        },
      });
      expect(JSON.stringify(audit)).not.toContain(
        "Nota interna fittizia M10-A",
      );
      const auditList = await listAuditEvents(
        adminActor,
        new URLSearchParams({
          from: "2099-06-15",
          to: "2099-06-15",
          action: "ASSIGNED",
        }),
        { now },
      );
      expect(auditList.items).toEqual([
        expect.objectContaining({
          source: "RESERVATION",
          eventId: audit.id,
          action: "ASSIGNED",
        }),
      ]);
      const auditDetail = await getAuditEventDetail(
        adminActor,
        "RESERVATION",
        audit.id,
        { now },
      );
      expect(auditDetail.newState.map((field) => field.key)).toEqual([
        "assignment.finalRoomCode",
        "assignment.tableIds",
        "assignment.tableCount",
        "assignment.internalNotesPresent",
      ]);
      expect(JSON.stringify(auditDetail)).not.toContain(
        "Nota interna fittizia M10-A",
      );
      expect(JSON.stringify(context)).not.toContain("createdByUserId");
    });

    it("supports multiple tables, order-independent no-op, reassign, logical removal and reactivation on the same entity", async () => {
      const reservation = await createReservation();
      const first = await putReservationAssignment({
        actor: adminActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1, {
          tableIds: [tableTwoId, tableOneId],
          internalNotes: "Prima nota fittizia",
        }),
        now,
      });
      const initialRow = await prisma.reservationAssignment.findFirstOrThrow({
        where: { restaurantId, reservationId: reservation.id },
      });
      const reservationAfterFirst = await prisma.reservation.findUniqueOrThrow({
        where: { id: reservation.id },
      });

      const noOp = await putReservationAssignment({
        actor: adminActor,
        reservationId: reservation.id,
        rawPayload: putPayload(2, {
          tableIds: [tableOneId, tableTwoId],
          internalNotes: "Prima nota fittizia",
        }),
        now: new Date(now.getTime() + 1_000),
      });
      expect(noOp.changed).toBe(false);
      expect(noOp.reservationVersion).toBe(2);
      await expect(
        prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      ).resolves.toMatchObject({
        version: 2,
        updatedAt: reservationAfterFirst.updatedAt,
      });
      await expect(
        prisma.reservationAuditEvent.count({
          where: { restaurantId, reservationId: reservation.id },
        }),
      ).resolves.toBe(1);

      const notesChanged = await putReservationAssignment({
        actor: adminActor,
        reservationId: reservation.id,
        rawPayload: putPayload(2, {
          tableIds: [tableOneId, tableTwoId],
          internalNotes: "Seconda nota fittizia",
        }),
        now: new Date(now.getTime() + 2_000),
      });
      expect(notesChanged.reservationVersion).toBe(3);

      const tablesChanged = await putReservationAssignment({
        actor: adminActor,
        reservationId: reservation.id,
        rawPayload: putPayload(3, {
          tableIds: [tableOneId],
          internalNotes: "Seconda nota fittizia",
        }),
        now: new Date(now.getTime() + 3_000),
      });
      expect(tablesChanged).toMatchObject({
        changed: true,
        reservationVersion: 4,
        assignment: { tables: [{ id: tableOneId }] },
      });

      const reassigned = await putReservationAssignment({
        actor: adminActor,
        reservationId: reservation.id,
        rawPayload: putPayload(4, {
          roomId: roomTwoId,
          tableIds: [tableThreeId],
          internalNotes: null,
        }),
        now: new Date(now.getTime() + 4_000),
      });
      expect(reassigned).toMatchObject({
        changed: true,
        reservationVersion: 5,
        assignment: { room: { id: roomTwoId }, internalNotes: null },
      });

      const removed = await deleteReservationAssignment({
        actor: adminActor,
        reservationId: reservation.id,
        rawPayload: { version: 5 },
        now: new Date(now.getTime() + 5_000),
      });
      expect(removed).toEqual({
        changed: true,
        reservationVersion: 6,
        assignment: null,
      });
      const cleared = await prisma.reservationAssignment.findUniqueOrThrow({
        where: { id: initialRow.id },
        include: { tables: true },
      });
      expect(cleared.clearedAt).not.toBeNull();
      expect(cleared.tables.map((table) => table.diningTableId)).toEqual([
        tableThreeId,
      ]);

      const alreadyRemoved = await deleteReservationAssignment({
        actor: adminActor,
        reservationId: reservation.id,
        rawPayload: { version: 5 },
        now: new Date(now.getTime() + 6_000),
      });
      expect(alreadyRemoved).toEqual({
        changed: false,
        reservationVersion: 6,
        assignment: null,
      });

      const reactivated = await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(6, { internalNotes: null }),
        now: new Date(now.getTime() + 7_000),
      });
      expect(reactivated.reservationVersion).toBe(7);
      const finalRow = await prisma.reservationAssignment.findFirstOrThrow({
        where: { restaurantId, reservationId: reservation.id },
      });
      expect(finalRow).toMatchObject({
        id: initialRow.id,
        assignedByUserId: adminId,
        updatedByUserId: staffId,
        clearedAt: null,
      });
      expect(first.assignment?.tables).toHaveLength(2);
      const actions = await prisma.reservationAuditEvent.findMany({
        where: { restaurantId, reservationId: reservation.id },
        select: { action: true },
        orderBy: { createdAt: "asc" },
      });
      expect(actions.map((event) => event.action)).toEqual([
        "ASSIGNED",
        "REASSIGNED",
        "REASSIGNED",
        "REASSIGNED",
        "UNASSIGNED",
        "ASSIGNED",
      ]);
    });

    it("rejects cross-room, inactive or unavailable new references but preserves grandfathered references", async () => {
      const reservation = await createReservation();

      await expect(
        putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1, { tableIds: [tableThreeId] }),
          now,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(
        putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1, { tableIds: [inactiveTableId] }),
          now,
        }),
      ).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
      await prisma.room.update({
        where: { id: roomTwoId },
        data: { isActive: false },
      });
      await expect(
        putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1, {
            roomId: roomTwoId,
            tableIds: [tableThreeId],
          }),
          now,
        }),
      ).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
      await expect(
        putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1, {
            roomId: unavailableRoomId,
            tableIds: [tableOneId],
          }),
          now,
        }),
      ).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
      await prisma.room.update({
        where: { id: roomTwoId },
        data: { isActive: true },
      });

      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });
      await prisma.room.update({
        where: { id: roomOneId },
        data: { isActive: false },
      });
      await prisma.diningTable.update({
        where: { id: tableOneId },
        data: { isActive: false },
      });

      const preserved = await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(2, {
          tableIds: [tableTwoId, tableOneId],
          internalNotes: "Grandfathering fittizio",
        }),
        now: new Date(now.getTime() + 1_000),
      });
      expect(preserved).toMatchObject({
        changed: true,
        reservationVersion: 3,
        assignment: {
          hasInactiveReferences: true,
          hasUnavailableRoomReference: true,
        },
      });
    });

    it("allows historical assignments and table reuse without capacity or instance effects", async () => {
      const firstReservation = await createReservation({
        localDate: historicalDate,
        partySize: 500,
      });
      const secondReservation = await createReservation({
        localDate: historicalDate,
        partySize: 600,
      });
      const settingsBefore = await prisma.restaurantBookingSettings.findUnique({
        where: { restaurantId },
      });
      const instancesBefore = await prisma.serviceInstance.count({
        where: { restaurantId },
      });

      const first = await putReservationAssignment({
        actor: staffActor,
        reservationId: firstReservation.id,
        rawPayload: putPayload(1),
        now,
      });
      const second = await putReservationAssignment({
        actor: adminActor,
        reservationId: secondReservation.id,
        rawPayload: putPayload(1),
        now,
      });

      expect(first.assignment?.tables[0]).toMatchObject({
        id: tableOneId,
        maximumSeats: 2,
      });
      expect(second.assignment?.tables[0]?.id).toBe(tableOneId);
      await expect(
        prisma.serviceInstance.count({ where: { restaurantId } }),
      ).resolves.toBe(instancesBefore);
      await expect(
        prisma.restaurantBookingSettings.findUnique({
          where: { restaurantId },
        }),
      ).resolves.toEqual(settingsBefore);
      const persisted = await prisma.reservation.findMany({
        where: { id: { in: [firstReservation.id, secondReservation.id] } },
        select: { partySize: true },
        orderBy: { partySize: "asc" },
      });
      expect(persisted).toEqual([{ partySize: 500 }, { partySize: 600 }]);
    });

    it("rejects cancelled, disabled, password-change and cross-tenant callers and re-reads the database role", async () => {
      const cancelled = await createReservation({ status: "CANCELLED" });
      await expect(
        putReservationAssignment({
          actor: staffActor,
          reservationId: cancelled.id,
          rawPayload: putPayload(1),
          now,
        }),
      ).rejects.toMatchObject({ code: "RESERVATION_CANCELLED" });

      const reservation = await createReservation();
      await expect(
        putReservationAssignment({
          actor: disabledActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1),
          now,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        putReservationAssignment({
          actor: mustChangeActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1),
          now,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        getReservationAssignmentContext({
          actor: otherStaffActor,
          reservationId: reservation.id,
          now,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await prisma.user.update({
        where: { id: staffId },
        data: { role: "ADMIN" },
      });
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });
      const audit = await prisma.reservationAuditEvent.findFirstOrThrow({
        where: { restaurantId, reservationId: reservation.id },
      });
      expect(audit.actorRole).toBe("ADMIN");
    });

    it("returns no-store unauthorized for an anonymous API read", async () => {
      const response = await getAssignmentRoute(
        new Request(
          `http://localhost:4000/api/staff/reservations/${randomUUID()}/assignment`,
        ),
        { params: Promise.resolve({ id: randomUUID() }) },
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe(
        "no-store, max-age=0",
      );
    });

    it("enforces same-origin and JSON at the Staff/Admin API boundary", async () => {
      const reservation = await createReservation();
      const context = { params: Promise.resolve({ id: reservation.id }) };

      const forged = await putAssignmentRoute(
        assignmentMutationRequest({
          cookie: staffCookie,
          reservationId: reservation.id,
          method: "PUT",
          body: putPayload(1),
          origin: "https://evil.example.invalid",
        }),
        context,
      );
      const wrongContentType = await putAssignmentRoute(
        assignmentMutationRequest({
          cookie: staffCookie,
          reservationId: reservation.id,
          method: "PUT",
          body: putPayload(1),
          contentType: "text/plain",
        }),
        context,
      );
      const assigned = await putAssignmentRoute(
        assignmentMutationRequest({
          cookie: staffCookie,
          reservationId: reservation.id,
          method: "PUT",
          body: putPayload(1),
        }),
        context,
      );
      const crossTenant = await deleteAssignmentRoute(
        assignmentMutationRequest({
          cookie: otherStaffCookie,
          reservationId: reservation.id,
          method: "DELETE",
          body: { version: 2 },
        }),
        context,
      );
      const removed = await deleteAssignmentRoute(
        assignmentMutationRequest({
          cookie: adminCookie,
          reservationId: reservation.id,
          method: "DELETE",
          body: { version: 2 },
        }),
        context,
      );

      expect(forged.status).toBe(403);
      expect(wrongContentType.status).toBe(400);
      expect(assigned.status).toBe(200);
      expect(crossTenant.status).toBe(404);
      expect(removed.status).toBe(200);
      expect(removed.headers.get("cache-control")).toContain("no-store");
    });

    it.each([
      {
        label: "data",
        initial: {},
        changed: { localDate: "2099-06-17" },
      },
      {
        label: "servizio",
        initial: { arrivalTime: "12:00" },
        changed: { serviceType: "LUNCH", arrivalTime: "12:00" },
      },
      {
        label: "orario",
        initial: {},
        changed: { arrivalTime: "19:15" },
      },
      {
        label: "data, servizio e orario insieme",
        initial: {},
        changed: {
          localDate: "2099-06-17",
          serviceType: "LUNCH",
          arrivalTime: "12:00",
        },
      },
    ])(
      "rimuove atomicamente l'assegnazione Staff al cambio di $label",
      async ({ initial, changed }) => {
        const reservation = await createReservation(initial);
        await putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1, {
            tableIds: [tableTwoId, tableOneId],
          }),
          now,
        });

        const result = await updateStaffReservation({
          actor: { id: staffId, restaurantId, role: "STAFF" },
          reservationId: reservation.id,
          rawPayload: staffUpdatePayload(2, { ...initial, ...changed }),
          now: new Date(now.getTime() + 10_000),
        });

        expect(result).toMatchObject({ changed: true, reservation: { version: 3 } });
        const assignment = await prisma.reservationAssignment.findUniqueOrThrow({
          where: { restaurantId_reservationId: { restaurantId, reservationId: reservation.id } },
          include: { tables: { orderBy: { diningTableId: "asc" } } },
        });
        expect(assignment.clearedAt).not.toBeNull();
        expect(assignment.tables.map((table) => table.diningTableId)).toEqual(
          [tableOneId, tableTwoId].sort(),
        );
        const lifecycleAudits = await prisma.reservationAuditEvent.findMany({
          where: {
            restaurantId,
            reservationId: reservation.id,
            action: { in: ["UPDATED", "UNASSIGNED"] },
          },
          orderBy: { createdAt: "asc" },
        });
        expect(lifecycleAudits.map((audit) => audit.action)).toEqual([
          "UPDATED",
          "UNASSIGNED",
        ]);
        expect(new Set(lifecycleAudits.map((audit) => audit.correlationId)).size).toBe(1);
        expect(lifecycleAudits[1]?.newState).toEqual({
          assignment: null,
          reason: "RESERVATION_SCHEDULE_CHANGED",
        });
        expect(JSON.stringify(lifecycleAudits)).not.toContain(
          "Nota interna fittizia M10-A",
        );
      },
      15_000,
    );

    it.each([
      { label: "numero persone", changed: { partySize: 12, childrenCount: 0, gameRoomPreference: null } },
      { label: "composizione e preferenza giochi", changed: { childrenCount: 2, gameRoomPreference: true } },
      {
        label: "contatti e note",
        changed: {
          customerFirstName: "Cliente Modificato",
          customerPhone: "+39 000 000 2020",
          notes: "Nota pubblica aggiornata",
        },
      },
    ])("conserva l'assegnazione Staff per modifiche a $label", async ({ changed }) => {
      const reservation = await createReservation();
      await prisma.reservation.update({ where: { id: reservation.id }, data: { arrivedAt: now } });
      const assigned = await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });
      const assignmentId = assigned.assignment!.id;

      await updateStaffReservation({
        actor: { id: staffId, restaurantId, role: "STAFF" },
        reservationId: reservation.id,
        rawPayload: staffUpdatePayload(2, changed),
        now: new Date(now.getTime() + 10_000),
      });

      await expect(
        prisma.reservationAssignment.findUniqueOrThrow({
          where: { id: assignmentId },
        }),
      ).resolves.toMatchObject({ id: assignmentId, clearedAt: null });
      await expect(
        prisma.reservationAuditEvent.count({
          where: { restaurantId, reservationId: reservation.id, action: "UNASSIGNED" },
        }),
      ).resolves.toBe(0);
      await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({ arrivedAt: now });
    });

    it("mantiene versione, timestamp, assegnazione e audit su no-op Staff", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });
      const beforeReservation = await prisma.reservation.findUniqueOrThrow({
        where: { id: reservation.id },
      });
      const beforeAssignment = await prisma.reservationAssignment.findUniqueOrThrow({
        where: { restaurantId_reservationId: { restaurantId, reservationId: reservation.id } },
      });
      const auditCount = await prisma.reservationAuditEvent.count({
        where: { restaurantId, reservationId: reservation.id },
      });

      const result = await updateStaffReservation({
        actor: { id: staffId, restaurantId, role: "STAFF" },
        reservationId: reservation.id,
        rawPayload: staffUpdatePayload(2),
        now: new Date(now.getTime() + 60_000),
      });

      expect(result.changed).toBe(false);
      await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({
        version: beforeReservation.version,
        updatedAt: beforeReservation.updatedAt,
      });
      await expect(prisma.reservationAssignment.findUniqueOrThrow({ where: { id: beforeAssignment.id } })).resolves.toMatchObject({
        updatedAt: beforeAssignment.updatedAt,
        clearedAt: null,
      });
      await expect(prisma.reservationAuditEvent.count({ where: { restaurantId, reservationId: reservation.id } })).resolves.toBe(auditCount);
    });

    it("non crea assegnazione o UNASSIGNED quando il reschedule Staff parte senza assegnazione", async () => {
      const reservation = await createReservation();
      const result = await updateStaffReservation({
        actor: { id: staffId, restaurantId, role: "STAFF" },
        reservationId: reservation.id,
        rawPayload: staffUpdatePayload(1, { arrivalTime: "19:15" }),
        now,
      });
      expect(result.reservation.version).toBe(2);
      await expect(prisma.reservationAssignment.count({ where: { restaurantId, reservationId: reservation.id } })).resolves.toBe(0);
      await expect(prisma.reservationAuditEvent.count({ where: { restaurantId, reservationId: reservation.id, action: "UNASSIGNED" } })).resolves.toBe(0);
    });

    it("annulla reschedule, versione e clear quando l'audit UNASSIGNED fallisce", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1), now });
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS m10_b_unassignment_audit_failure ON reservation_audit_events`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS m10_b_unassignment_audit_failure()`);
      await prisma.$executeRawUnsafe(`CREATE FUNCTION m10_b_unassignment_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action::text = 'UNASSIGNED' THEN RAISE EXCEPTION 'synthetic M10-B unassignment audit failure'; END IF; RETURN NEW; END; $$`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER m10_b_unassignment_audit_failure BEFORE INSERT ON reservation_audit_events FOR EACH ROW EXECUTE FUNCTION m10_b_unassignment_audit_failure()`);
      try {
        await expect(updateStaffReservation({
          actor: { id: staffId, restaurantId, role: "STAFF" },
          reservationId: reservation.id,
          rawPayload: staffUpdatePayload(2, { arrivalTime: "19:15" }),
          now: new Date(now.getTime() + 10_000),
        })).rejects.toBeTruthy();
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS m10_b_unassignment_audit_failure ON reservation_audit_events`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS m10_b_unassignment_audit_failure()`);
      }
      await expect(prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).resolves.toMatchObject({ version: 2, arrivalTime: operationalTimeToDatabase("19:00") });
      await expect(prisma.reservationAssignment.findUniqueOrThrow({ where: { restaurantId_reservationId: { restaurantId, reservationId: reservation.id } } })).resolves.toMatchObject({ clearedAt: null });
      await expect(prisma.reservationAuditEvent.count({ where: { restaurantId, reservationId: reservation.id, action: { in: ["UPDATED", "UNASSIGNED"] } } })).resolves.toBe(0);
    });

    it("conserva assegnazione e note interne nella cancellazione Staff", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1), now });
      await cancelStaffReservation({
        actor: { id: staffId, restaurantId, role: "STAFF" },
        reservationId: reservation.id,
        rawPayload: { version: 2 },
        now: new Date(now.getTime() + 10_000),
      });
      const context = await getReservationAssignmentContext({ actor: adminActor, reservationId: reservation.id, now });
      expect(context).toMatchObject({
        reservation: { status: "CANCELLED", version: 3 },
        assignment: { internalNotes: "Nota interna fittizia M10-A" },
      });
      await expect(prisma.reservationAuditEvent.count({ where: { restaurantId, reservationId: reservation.id, action: "UNASSIGNED" } })).resolves.toBe(0);
    });

    it.each([
      {
        label: "data",
        initial: {},
        changed: { localDate: "2099-06-17" },
      },
      {
        label: "servizio",
        initial: { arrivalTime: "12:00" },
        changed: { serviceType: "LUNCH", arrivalTime: "12:00" },
      },
      {
        label: "orario",
        initial: {},
        changed: { arrivalTime: "19:15" },
      },
    ])(
      "rimuove l'assegnazione dal link personale al cambio di $label senza esporla",
      async ({ initial, changed }) => {
        const reservation = await createReservation({ origin: "PUBLIC", ...initial });
        const token = await createPublicManagementToken(reservation.id, initial);
        await putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1),
          now,
        });

        const dto = await updateManagedPublicReservation({
          restaurantId,
          rawToken: token.rawToken,
          rawPayload: publicUpdatePayload({ ...initial, ...changed }),
          now: new Date(now.getTime() + 10_000),
        });

        expect(dto).not.toHaveProperty("assignment");
        expect(dto).not.toHaveProperty("internalNotes");
        expect(JSON.stringify(dto)).not.toContain("Nota interna fittizia M10-A");
        const assignment = await prisma.reservationAssignment.findUniqueOrThrow({
          where: { restaurantId_reservationId: { restaurantId, reservationId: reservation.id } },
        });
        expect(assignment.clearedAt).not.toBeNull();
        const updatedToken = await prisma.reservationManagementToken.findUniqueOrThrow({
          where: { reservationId: reservation.id },
        });
        expect(updatedToken.tokenHash).toBe(hashManagementToken(token.rawToken));
        expect(
          (updatedToken.viewExpiresAt.getTime() -
            managementViewExpiry({
              localDate: dto.localDate,
              arrivalTime: dto.arrivalTime,
              timezone: "Europe/Rome",
              durationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
            }).getTime()),
        ).toBe(0);
        const audits = await prisma.reservationAuditEvent.findMany({
          where: { restaurantId, reservationId: reservation.id, action: { in: ["UPDATED", "UNASSIGNED"] } },
          orderBy: { createdAt: "asc" },
        });
        expect(audits.map((audit) => audit.actorOrigin)).toEqual(["PUBLIC", "PUBLIC"]);
        expect(new Set(audits.map((audit) => audit.correlationId)).size).toBe(1);
      },
    );

    it.each([
      { label: "persone", changed: { partySize: 8, childrenCount: 0, gameRoomPreference: null } },
      { label: "composizione e preferenza giochi", changed: { childrenCount: 2, gameRoomPreference: true } },
      {
        label: "richieste e note",
        changed: {
          highChair: true,
          allergies: "Allergia fittizia",
          notes: "Nota cliente aggiornata",
        },
      },
    ])("conserva l'assegnazione dal link personale per $label", async ({ changed }) => {
      const reservation = await createReservation({ origin: "PUBLIC" });
      const token = await createPublicManagementToken(reservation.id);
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1), now });
      const dto = await updateManagedPublicReservation({
        restaurantId,
        rawToken: token.rawToken,
        rawPayload: publicUpdatePayload(changed),
        now: new Date(now.getTime() + 10_000),
      });
      expect(dto).not.toHaveProperty("assignment");
      expect(dto).not.toHaveProperty("internalNotes");
      await expect(prisma.reservationAssignment.findUniqueOrThrow({ where: { restaurantId_reservationId: { restaurantId, reservationId: reservation.id } } })).resolves.toMatchObject({ clearedAt: null });
      await expect(prisma.reservationAuditEvent.count({ where: { restaurantId, reservationId: reservation.id, action: "UNASSIGNED" } })).resolves.toBe(0);
    });

    it("mantiene il link personale no-op completamente privo di scritture", async () => {
      const reservation = await createReservation({ origin: "PUBLIC" });
      const token = await createPublicManagementToken(reservation.id);
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1), now });
      const before = await databaseFingerprint();
      const dto = await updateManagedPublicReservation({
        restaurantId,
        rawToken: token.rawToken,
        rawPayload: publicUpdatePayload(),
        now: new Date(now.getTime() + 10_000),
      });
      expect(dto.localDate).toBe(futureDate);
      expect(await databaseFingerprint()).toBe(before);
    });

    it("conserva l'assegnazione nella cancellazione pubblica senza esporla", async () => {
      const reservation = await createReservation({ origin: "PUBLIC" });
      const token = await createPublicManagementToken(reservation.id);
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1), now });
      const dto = await cancelManagedPublicReservation({
        restaurantId,
        rawToken: token.rawToken,
        now: new Date(now.getTime() + 10_000),
      });
      expect(dto.status).toBe("CANCELLED");
      expect(dto).not.toHaveProperty("assignment");
      expect(dto).not.toHaveProperty("internalNotes");
      expect(JSON.stringify(dto)).not.toContain("Nota interna fittizia M10-A");
      await expect(prisma.reservationAssignment.findUniqueOrThrow({ where: { restaurantId_reservationId: { restaurantId, reservationId: reservation.id } } })).resolves.toMatchObject({ clearedAt: null });
      await expect(prisma.reservationAuditEvent.count({ where: { restaurantId, reservationId: reservation.id, action: "UNASSIGNED" } })).resolves.toBe(0);
    });

    it("include una sola volta l'assegnazione multi-tavolo nell'impatto di disattivazione sala e applica grandfathering", async () => {
      const reservation = await createReservation({ roomCode: "sala-1" });
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1, { tableIds: [tableOneId, tableTwoId] }),
        now,
      });
      const proposal = {
        kind: "ROOM_CATALOG" as const,
        roomId: roomOneId,
        displayOrder: 1,
        isActive: false,
      };
      const preview = await previewRoomConfigurationChange(adminActor, proposal, { now });
      expect(preview).toMatchObject({
        confirmationRequired: true,
        impact: {
          reservationCount: 1,
          covers: 4,
          preferenceReservationCount: 1,
          assignmentReservationCount: 1,
        },
      });
      expect(preview.impact.items[0]?.classifications).toEqual([
        "ROOM_DISABLED",
        "RESERVATION_WITH_AFFECTED_ROOM_PREFERENCE",
        "RESERVATION_WITH_AFFECTED_FINAL_ASSIGNMENT",
      ]);
      expect(JSON.stringify(preview)).not.toContain("Nota interna fittizia M10-A");
      expect(JSON.stringify(preview)).not.toContain(reservation.id);

      await applyRoomConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now });
      const context = await getReservationAssignmentContext({ actor: adminActor, reservationId: reservation.id, now });
      expect(context.assignment).toMatchObject({
        id: expect.any(String),
        hasInactiveReferences: true,
        internalNotes: "Nota interna fittizia M10-A",
      });
      await expect(prisma.reservationAssignment.findUniqueOrThrow({ where: { restaurantId_reservationId: { restaurantId, reservationId: reservation.id } } })).resolves.toMatchObject({ clearedAt: null });
    });

    it("richiede conferma per la disattivazione di un tavolo assegnato e lo conserva grandfathered", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1, { tableIds: [tableOneId, tableTwoId] }),
        now,
      });
      const proposal = {
        kind: "DINING_TABLE" as const,
        tableId: tableOneId,
        name: "M10-A-T1",
        minimumSeats: 1,
        maximumSeats: 2,
        displayOrder: 1,
        isActive: false,
      };
      const preview = await previewRoomConfigurationChange(adminActor, proposal, { now });
      expect(preview).toMatchObject({
        confirmationRequired: true,
        impact: {
          reservationCount: 1,
          assignmentReservationCount: 1,
          preferenceReservationCount: 0,
        },
      });
      expect(preview.impact.items[0]?.classifications).toEqual([
        "TABLE_DISABLED",
        "RESERVATION_WITH_AFFECTED_FINAL_ASSIGNMENT",
      ]);
      await applyRoomConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now });
      const context = await getReservationAssignmentContext({ actor: staffActor, reservationId: reservation.id, now });
      expect(context.assignment).toMatchObject({ hasInactiveReferences: true });
      expect(context.assignment?.tables).toHaveLength(2);
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { restaurantId, action: "DINING_TABLE_DISABLED", entityId: tableOneId },
      });
      expect(audit.metadata).toMatchObject({
        reservationCount: 1,
        assignmentReservationCount: 1,
      });
      expect(JSON.stringify(audit.metadata)).not.toContain(reservation.id);
    });

    it("include l'assegnazione nell'indisponibilità effettiva per data/servizio senza rimuoverla", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1), now });
      const proposal = {
        kind: "SERVICE_ROOM_AVAILABILITY" as const,
        localDate: futureDate,
        serviceType: "DINNER" as const,
        roomId: roomOneId,
        isAvailable: false,
      };
      const preview = await previewRoomConfigurationChange(adminActor, proposal, { now });
      expect(preview).toMatchObject({
        confirmationRequired: true,
        impact: { reservationCount: 1, assignmentReservationCount: 1 },
      });
      await applyRoomConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now });
      const context = await getReservationAssignmentContext({ actor: staffActor, reservationId: reservation.id, now });
      expect(context.assignment).toMatchObject({
        hasUnavailableRoomReference: true,
        internalNotes: "Nota interna fittizia M10-A",
      });
      await expect(prisma.reservationAssignment.findUniqueOrThrow({ where: { restaurantId_reservationId: { restaurantId, reservationId: reservation.id } } })).resolves.toMatchObject({ clearedAt: null });
    });

    it("esclude da impatto cancellate, storiche, rimosse e altri tenant", async () => {
      const relevant = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: relevant.id, rawPayload: putPayload(1), now });

      const cancelled = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: cancelled.id, rawPayload: putPayload(1), now });
      await cancelStaffReservation({ actor: { id: staffId, restaurantId, role: "STAFF" }, reservationId: cancelled.id, rawPayload: { version: 2 }, now });

      const historical = await createReservation({ localDate: historicalDate });
      await putReservationAssignment({ actor: staffActor, reservationId: historical.id, rawPayload: putPayload(1), now });

      const removed = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: removed.id, rawPayload: putPayload(1), now });
      await deleteReservationAssignment({ actor: staffActor, reservationId: removed.id, rawPayload: { version: 2 }, now });

      const other = await createReservation({ restaurantId: otherRestaurantId, createdByUserId: otherStaffId });
      await putReservationAssignment({
        actor: otherStaffActor,
        reservationId: other.id,
        rawPayload: {
          version: 1,
          roomId: otherRoomId,
          tableIds: [otherTableId],
          internalNotes: "Nota altro tenant",
        },
        now,
      });

      const proposal = { kind: "ROOM_CATALOG" as const, roomId: roomOneId, displayOrder: 1, isActive: false };
      const preview = await previewRoomConfigurationChange(adminActor, proposal, { now });
      expect(preview.impact).toMatchObject({ reservationCount: 1, assignmentReservationCount: 1 });
      expect(JSON.stringify(preview)).not.toContain(cancelled.id);
      expect(JSON.stringify(preview)).not.toContain(historical.id);
      expect(JSON.stringify(preview)).not.toContain(removed.id);
      expect(JSON.stringify(preview)).not.toContain(other.id);
    });

    it("rifiuta il fingerprint quando una nuova assegnazione entra nell'impatto", async () => {
      const reservation = await createReservation();
      const proposal = { kind: "ROOM_CATALOG" as const, roomId: roomOneId, displayOrder: 1, isActive: false };
      const preview = await previewRoomConfigurationChange(adminActor, proposal, { now });
      expect(preview.impact.reservationCount).toBe(0);
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1), now });
      await expect(applyRoomConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now })).rejects.toMatchObject({ code: "IMPACT_CHANGED" });
      await expect(prisma.room.findUniqueOrThrow({ where: { id: roomOneId } })).resolves.toMatchObject({ isActive: true });
      await expect(prisma.auditEvent.count({ where: { restaurantId, action: "ROOM_DISABLED" } })).resolves.toBe(0);
    });

    it.each(["REASSIGN", "REMOVE", "CANCEL", "RESCHEDULE"] as const)(
      "rifiuta il fingerprint quando l'assegnazione pertinente cambia tramite %s",
      async (action) => {
        const reservation = await createReservation();
        await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1), now });
        const proposal = { kind: "ROOM_CATALOG" as const, roomId: roomOneId, displayOrder: 1, isActive: false };
        const preview = await previewRoomConfigurationChange(adminActor, proposal, { now });
        if (action === "REASSIGN") {
          await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(2, { roomId: roomTwoId, tableIds: [tableThreeId] }), now });
        } else if (action === "REMOVE") {
          await deleteReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: { version: 2 }, now });
        } else if (action === "CANCEL") {
          await cancelStaffReservation({ actor: { id: staffId, restaurantId, role: "STAFF" }, reservationId: reservation.id, rawPayload: { version: 2 }, now });
        } else {
          await updateStaffReservation({ actor: { id: staffId, restaurantId, role: "STAFF" }, reservationId: reservation.id, rawPayload: staffUpdatePayload(2, { arrivalTime: "19:15" }), now });
        }
        await expect(applyRoomConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now })).rejects.toMatchObject({ code: "IMPACT_CHANGED" });
        await expect(prisma.room.findUniqueOrThrow({ where: { id: roomOneId } })).resolves.toMatchObject({ isActive: true });
      },
    );

    it("ignora assegnazioni di altre sale nel fingerprint pertinente", async () => {
      const reservation = await createReservation();
      const proposal = { kind: "ROOM_CATALOG" as const, roomId: roomOneId, displayOrder: 1, isActive: false };
      const preview = await previewRoomConfigurationChange(adminActor, proposal, { now });
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1, { roomId: roomTwoId, tableIds: [tableThreeId] }),
        now,
      });
      await expect(applyRoomConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now })).resolves.toEqual({ changed: true });
    });

    it("consente una sola conferma concorrente con assegnazione impattata", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({ actor: staffActor, reservationId: reservation.id, rawPayload: putPayload(1), now });
      const proposal = { kind: "ROOM_CATALOG" as const, roomId: roomOneId, displayOrder: 1, isActive: false };
      const preview = await previewRoomConfigurationChange(adminActor, proposal, { now });
      const results = await Promise.allSettled([
        applyRoomConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now }),
        applyRoomConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now }),
      ]);
      expect(fulfilledCount(results)).toBe(1);
      await expect(prisma.auditEvent.count({ where: { restaurantId, action: "ROOM_DISABLED" } })).resolves.toBe(1);
      await expect(prisma.reservationAssignment.findUniqueOrThrow({ where: { restaurantId_reservationId: { restaurantId, reservationId: reservation.id } } })).resolves.toMatchObject({ clearedAt: null });
    });

    it("has one winner and one audit for concurrent first assignments", async () => {
      const reservation = await createReservation();
      const results = await Promise.allSettled([
        putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1, { tableIds: [tableOneId] }),
          now,
        }),
        putReservationAssignment({
          actor: adminActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1, { tableIds: [tableTwoId] }),
          now,
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(
        rejected && rejected.status === "rejected" ? rejected.reason : null,
      ).toMatchObject({ code: "VERSION_CONFLICT" });
      await expect(
        prisma.reservationAssignment.count({
          where: { restaurantId, reservationId: reservation.id },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.reservationAuditEvent.count({
          where: {
            restaurantId,
            reservationId: reservation.id,
            action: "ASSIGNED",
          },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      ).resolves.toMatchObject({ version: 2 });
    });

    it("has one winner and one audit for concurrent reassignments", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });
      const results = await Promise.allSettled([
        putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(2, {
            tableIds: [tableTwoId],
            internalNotes: "Concorrenza A fittizia",
          }),
          now: new Date(now.getTime() + 1_000),
        }),
        putReservationAssignment({
          actor: adminActor,
          reservationId: reservation.id,
          rawPayload: putPayload(2, {
            tableIds: [tableOneId, tableTwoId],
            internalNotes: "Concorrenza B fittizia",
          }),
          now: new Date(now.getTime() + 1_000),
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(
        prisma.reservationAuditEvent.count({
          where: {
            restaurantId,
            reservationId: reservation.id,
            action: "REASSIGNED",
          },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      ).resolves.toMatchObject({ version: 3 });
    });

    it("serializes assignment against logical removal with one winning audit", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });

      const results = await Promise.allSettled([
        putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(2, {
            tableIds: [tableTwoId],
            internalNotes: "Riassegnazione concorrente fittizia",
          }),
          now: new Date(now.getTime() + 1_000),
        }),
        deleteReservationAssignment({
          actor: adminActor,
          reservationId: reservation.id,
          rawPayload: { version: 2 },
          now: new Date(now.getTime() + 1_000),
        }),
      ]);

      expect(fulfilledCount(results)).toBe(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(
        prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      ).resolves.toMatchObject({ version: 3 });
      await expect(
        prisma.reservationAuditEvent.count({
          where: { restaurantId, reservationId: reservation.id },
        }),
      ).resolves.toBe(2);
    });

    it("serializes assignment against a Staff contact update", async () => {
      const reservation = await createReservation();
      const results = await Promise.allSettled([
        putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1),
          now,
        }),
        updateStaffReservation({
          actor: { id: staffId, restaurantId, role: "STAFF" },
          reservationId: reservation.id,
          rawPayload: staffUpdatePayload(1, {
            customerFirstName: "Cliente Modificato",
          }),
          now,
        }),
      ]);

      expect(fulfilledCount(results)).toBe(1);
      await expect(
        prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      ).resolves.toMatchObject({ version: 2, status: "CONFIRMED" });
      await expect(
        prisma.reservationAuditEvent.count({
          where: { restaurantId, reservationId: reservation.id },
        }),
      ).resolves.toBe(1);
      await expect(
        prisma.reservationAssignmentTable.count({
          where: { restaurantId, assignment: { reservationId: reservation.id } },
        }),
      ).resolves.toBe(results[0]?.status === "fulfilled" ? 1 : 0);
    });

    it("serializes assignment against cancellation without partial state", async () => {
      const reservation = await createReservation();
      const results = await Promise.allSettled([
        putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1),
          now,
        }),
        cancelStaffReservation({
          actor: { id: staffId, restaurantId, role: "STAFF" },
          reservationId: reservation.id,
          rawPayload: { version: 1 },
          now,
        }),
      ]);

      expect(fulfilledCount(results)).toBe(1);
      const stored = await prisma.reservation.findUniqueOrThrow({
        where: { id: reservation.id },
      });
      expect(stored.version).toBe(2);
      expect(stored.status).toBe(
        results[0]?.status === "fulfilled" ? "CONFIRMED" : "CANCELLED",
      );
      await expect(
        prisma.reservationAuditEvent.count({
          where: { restaurantId, reservationId: reservation.id },
        }),
      ).resolves.toBe(1);
    });

    it("serializes assignment against a date, service and arrival reschedule", async () => {
      const reservation = await createReservation();
      const results = await Promise.allSettled([
        putReservationAssignment({
          actor: adminActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1),
          now,
        }),
        updateStaffReservation({
          actor: { id: adminId, restaurantId, role: "ADMIN" },
          reservationId: reservation.id,
          rawPayload: staffUpdatePayload(1, {
            localDate: "2099-06-17",
            serviceType: "LUNCH",
            arrivalTime: "12:00",
          }),
          now,
        }),
      ]);

      expect(fulfilledCount(results)).toBe(1);
      const stored = await prisma.reservation.findUniqueOrThrow({
        where: { id: reservation.id },
      });
      expect(stored.version).toBe(2);
      const assignment = await prisma.reservationAssignment.findFirst({
        where: { restaurantId, reservationId: reservation.id },
      });
      expect(assignment !== null).toBe(results[0]?.status === "fulfilled");
      await expect(
        prisma.reservationAuditEvent.count({
          where: { restaurantId, reservationId: reservation.id },
        }),
      ).resolves.toBe(1);
    });

    it("serializes reassign against reschedule without partial assignment or duplicate audit", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });

      const results = await Promise.allSettled([
        putReservationAssignment({
          actor: adminActor,
          reservationId: reservation.id,
          rawPayload: putPayload(2, {
            tableIds: [tableTwoId],
            internalNotes: "Riassegnazione concorrente M10-B",
          }),
          now: new Date(now.getTime() + 1_000),
        }),
        updateStaffReservation({
          actor: { id: staffId, restaurantId, role: "STAFF" },
          reservationId: reservation.id,
          rawPayload: staffUpdatePayload(2, { arrivalTime: "19:15" }),
          now: new Date(now.getTime() + 1_000),
        }),
      ]);

      expect(fulfilledCount(results)).toBe(1);
      const reassignWon = results[0]?.status === "fulfilled";
      const stored = await prisma.reservation.findUniqueOrThrow({
        where: { id: reservation.id },
      });
      expect(stored).toMatchObject({
        version: 3,
        arrivalTime: operationalTimeToDatabase(reassignWon ? "19:00" : "19:15"),
      });
      const assignment = await prisma.reservationAssignment.findUniqueOrThrow({
        where: {
          restaurantId_reservationId: {
            restaurantId,
            reservationId: reservation.id,
          },
        },
        include: { tables: true },
      });
      expect(assignment.clearedAt === null).toBe(reassignWon);
      expect(assignment.tables).toHaveLength(1);
      expect(assignment.tables[0]?.diningTableId).toBe(
        reassignWon ? tableTwoId : tableOneId,
      );
      await expect(
        prisma.reservationAuditEvent.count({
          where: { restaurantId, reservationId: reservation.id },
        }),
      ).resolves.toBe(reassignWon ? 2 : 3);
      await expect(
        prisma.reservationAuditEvent.count({
          where: {
            restaurantId,
            reservationId: reservation.id,
            action: reassignWon ? "REASSIGNED" : "UNASSIGNED",
          },
        }),
      ).resolves.toBe(1);
    });

    it("serializes logical removal against reschedule with one UNASSIGNED audit", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });

      const results = await Promise.allSettled([
        deleteReservationAssignment({
          actor: adminActor,
          reservationId: reservation.id,
          rawPayload: { version: 2 },
          now: new Date(now.getTime() + 1_000),
        }),
        updateStaffReservation({
          actor: { id: staffId, restaurantId, role: "STAFF" },
          reservationId: reservation.id,
          rawPayload: staffUpdatePayload(2, { localDate: "2099-06-17" }),
          now: new Date(now.getTime() + 1_000),
        }),
      ]);

      const effectiveMutations = results.filter(
        (result) =>
          result.status === "fulfilled" &&
          result.value.changed,
      );
      expect(effectiveMutations).toHaveLength(1);
      const removalWon =
        results[0]?.status === "fulfilled" && results[0].value.changed;
      await expect(
        prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      ).resolves.toMatchObject({
        version: 3,
        localDate: new Date(`${removalWon ? futureDate : "2099-06-17"}T00:00:00.000Z`),
      });
      await expect(
        prisma.reservationAssignment.findUniqueOrThrow({
          where: {
            restaurantId_reservationId: {
              restaurantId,
              reservationId: reservation.id,
            },
          },
        }),
      ).resolves.toMatchObject({ clearedAt: expect.any(Date) });
      const unassignedAudits = await prisma.reservationAuditEvent.findMany({
        where: {
          restaurantId,
          reservationId: reservation.id,
          action: "UNASSIGNED",
        },
      });
      expect(unassignedAudits).toHaveLength(1);
      expect(unassignedAudits[0]?.newState).toMatchObject(
        removalWon
          ? { assignment: null }
          : {
              assignment: null,
              reason: "RESERVATION_SCHEDULE_CHANGED",
            },
      );
      await expect(
        prisma.reservationAuditEvent.count({
          where: { restaurantId, reservationId: reservation.id },
        }),
      ).resolves.toBe(removalWon ? 2 : 3);
    });

    it("serializes assignment against service-room availability changes", async () => {
      const reservation = await createReservation();
      const proposal = {
        kind: "SERVICE_ROOM_AVAILABILITY" as const,
        localDate: futureDate,
        serviceType: "DINNER" as const,
        roomId: roomOneId,
        isAvailable: false,
      };
      const preview = await previewRoomConfigurationChange(
        adminActor,
        proposal,
        { now },
      );
      const results = await Promise.allSettled([
        putReservationAssignment({
          actor: staffActor,
          reservationId: reservation.id,
          rawPayload: putPayload(1),
          now,
        }),
        applyRoomConfigurationChange(
          adminActor,
          { proposal, fingerprint: preview.fingerprint },
          { now },
        ),
      ]);

      expect(fulfilledCount(results)).toBe(1);
      const assignmentWon = results[0]?.status === "fulfilled";
      if (assignmentWon) {
        expect(results[1]).toMatchObject({
          status: "rejected",
          reason: { code: "IMPACT_CHANGED" },
        });
      } else {
        expect(results[0]).toMatchObject({
          status: "rejected",
          reason: { code: "ROOM_UNAVAILABLE" },
        });
      }
      await expect(
        prisma.reservationAuditEvent.count({
          where: {
            restaurantId,
            reservationId: reservation.id,
            action: "ASSIGNED",
          },
        }),
      ).resolves.toBe(assignmentWon ? 1 : 0);
      await expect(
        prisma.reservationAssignmentTable.count({
          where: { restaurantId, assignment: { reservationId: reservation.id } },
        }),
      ).resolves.toBe(assignmentWon ? 1 : 0);
    });

    it("serializes assignment against room and table deactivation", async () => {
      const roomReservation = await createReservation();
      const roomProposal = {
        kind: "ROOM_CATALOG" as const,
        roomId: roomOneId,
        displayOrder: 1,
        isActive: false,
      };
      const roomPreview = await previewRoomConfigurationChange(
        adminActor,
        roomProposal,
        { now },
      );
      const roomResults = await Promise.allSettled([
        putReservationAssignment({
          actor: staffActor,
          reservationId: roomReservation.id,
          rawPayload: putPayload(1),
          now,
        }),
        applyRoomConfigurationChange(
          adminActor,
          { proposal: roomProposal, fingerprint: roomPreview.fingerprint },
          { now },
        ),
      ]);
      expect(fulfilledCount(roomResults)).toBe(1);
      const roomAssignmentWon = roomResults[0]?.status === "fulfilled";
      if (roomAssignmentWon) {
        expect(roomResults[1]).toMatchObject({
          status: "rejected",
          reason: { code: "IMPACT_CHANGED" },
        });
      } else {
        expect(roomResults[0]).toMatchObject({
          status: "rejected",
          reason: { code: "ROOM_UNAVAILABLE" },
        });
      }

      await prisma.room.update({
        where: { id: roomOneId },
        data: { isActive: true },
      });
      const tableReservation = await createReservation();
      const tableProposal = {
        kind: "DINING_TABLE" as const,
        tableId: tableOneId,
        name: "M10-A-T1",
        minimumSeats: 1,
        maximumSeats: 2,
        displayOrder: 1,
        isActive: false,
      };
      const tablePreview = await previewRoomConfigurationChange(
        adminActor,
        tableProposal,
        { now: new Date(now.getTime() + 1_000) },
      );
      const tableResults = await Promise.allSettled([
        putReservationAssignment({
          actor: staffActor,
          reservationId: tableReservation.id,
          rawPayload: putPayload(1),
          now: new Date(now.getTime() + 1_000),
        }),
        applyRoomConfigurationChange(
          adminActor,
          {
            proposal: tableProposal,
            fingerprint: tablePreview.fingerprint,
          },
          { now: new Date(now.getTime() + 1_000) },
        ),
      ]);
      expect(fulfilledCount(tableResults)).toBe(1);
      const tableAssignmentWon = tableResults[0]?.status === "fulfilled";
      if (tableAssignmentWon) {
        expect(tableResults[1]).toMatchObject({
          status: "rejected",
          reason: { code: "IMPACT_CHANGED" },
        });
      } else {
        expect(tableResults[0]).toMatchObject({
          status: "rejected",
          reason: { code: "ROOM_UNAVAILABLE" },
        });
      }
      await expect(
        prisma.reservationAuditEvent.count({
          where: {
            restaurantId,
            reservationId: { in: [roomReservation.id, tableReservation.id] },
            action: "ASSIGNED",
          },
        }),
      ).resolves.toBe(
        Number(roomAssignmentWon) + Number(tableAssignmentWon),
      );
    });

    it("re-reads a concurrently disabled or role-changed assignment actor", async () => {
      const disabledRaceReservation = await createReservation({
        createdByUserId: concurrentActorId,
      });
      const disabledResults = await Promise.allSettled([
        putReservationAssignment({
          actor: concurrentActor,
          reservationId: disabledRaceReservation.id,
          rawPayload: putPayload(1),
          now,
        }),
        changeManagedUserStatus(adminActor, concurrentActorId, {
          isActive: false,
        }),
      ]);
      expect(disabledResults[1]).toMatchObject({
        status: "fulfilled",
        value: { changed: true },
      });
      if (disabledResults[0]?.status === "rejected") {
        expect(disabledResults[0].reason).toMatchObject({ code: "FORBIDDEN" });
      }
      const disabledAssignmentWon = disabledResults[0]?.status === "fulfilled";
      await expect(
        prisma.reservationAuditEvent.count({
          where: {
            restaurantId,
            reservationId: disabledRaceReservation.id,
            action: "ASSIGNED",
          },
        }),
      ).resolves.toBe(disabledAssignmentWon ? 1 : 0);

      await expect(
        putReservationAssignment({
          actor: concurrentActor,
          reservationId: (await createReservation()).id,
          rawPayload: putPayload(1),
          now: new Date(now.getTime() + 1_000),
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await prisma.user.update({
        where: { id: concurrentActorId },
        data: { role: "ADMIN", isActive: true, disabledAt: null },
      });
      const roleRaceReservation = await createReservation({
        createdByUserId: concurrentActorId,
      });
      const roleResults = await Promise.allSettled([
        putReservationAssignment({
          actor: concurrentActor,
          reservationId: roleRaceReservation.id,
          rawPayload: putPayload(1),
          now: new Date(now.getTime() + 2_000),
        }),
        changeManagedUserRole(adminActor, concurrentActorId, { role: "STAFF" }),
      ]);
      expect(roleResults).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
      const roleAudit = await prisma.reservationAuditEvent.findFirstOrThrow({
        where: {
          restaurantId,
          reservationId: roleRaceReservation.id,
          action: "ASSIGNED",
        },
      });
      expect(["ADMIN", "STAFF"]).toContain(roleAudit.actorRole);

      const freshRoleReservation = await createReservation({
        createdByUserId: concurrentActorId,
      });
      await putReservationAssignment({
        actor: concurrentActor,
        reservationId: freshRoleReservation.id,
        rawPayload: putPayload(1),
        now: new Date(now.getTime() + 3_000),
      });
      await expect(
        prisma.reservationAuditEvent.findFirstOrThrow({
          where: {
            restaurantId,
            reservationId: freshRoleReservation.id,
            action: "ASSIGNED",
          },
        }),
      ).resolves.toMatchObject({ actorRole: "STAFF" });
    });

    it("rolls back assignment and reservation version when audit persistence fails", async () => {
      const reservation = await createReservation();
      const before = await prisma.reservation.findUniqueOrThrow({
        where: { id: reservation.id },
      });
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION m10a_test_reject_assignment_audit() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.restaurant_id = '${restaurantId}'::uuid
             AND NEW.action::text = 'ASSIGNED' THEN
            RAISE EXCEPTION 'synthetic M10-A assignment audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER m10a_test_reject_assignment_audit_trigger
        BEFORE INSERT ON reservation_audit_events
        FOR EACH ROW EXECUTE FUNCTION m10a_test_reject_assignment_audit();
      `);
      try {
        await expect(
          putReservationAssignment({
            actor: staffActor,
            reservationId: reservation.id,
            rawPayload: putPayload(1),
            now,
          }),
        ).rejects.toThrow("synthetic M10-A assignment audit failure");
      } finally {
        await prisma.$executeRawUnsafe(
          "DROP TRIGGER IF EXISTS m10a_test_reject_assignment_audit_trigger ON reservation_audit_events",
        );
        await prisma.$executeRawUnsafe(
          "DROP FUNCTION IF EXISTS m10a_test_reject_assignment_audit()",
        );
      }

      await expect(
        prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      ).resolves.toEqual(before);
      await expect(
        prisma.reservationAssignment.count({
          where: { restaurantId, reservationId: reservation.id },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.reservationAuditEvent.count({
          where: { restaurantId, reservationId: reservation.id },
        }),
      ).resolves.toBe(0);
    });

    it("enforces one assignment, tenant-scoped references, room membership and duplicate prevention in PostgreSQL", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });
      const assignment = await prisma.reservationAssignment.findFirstOrThrow({
        where: { restaurantId, reservationId: reservation.id },
      });

      await expect(
        prisma.reservationAssignment.create({
          data: {
            restaurantId,
            reservationId: reservation.id,
            roomId: roomOneId,
            assignedByUserId: staffId,
            updatedByUserId: staffId,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        prisma.reservationAssignment.create({
          data: {
            restaurantId: otherRestaurantId,
            reservationId: reservation.id,
            roomId: otherRoomId,
            assignedByUserId: otherStaffId,
            updatedByUserId: otherStaffId,
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
      await expect(
        prisma.reservationAssignmentTable.create({
          data: {
            restaurantId,
            assignmentId: assignment.id,
            roomId: roomOneId,
            diningTableId: tableOneId,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        prisma.reservationAssignmentTable.create({
          data: {
            restaurantId,
            assignmentId: assignment.id,
            roomId: roomOneId,
            diningTableId: tableThreeId,
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("keeps successful, repeated and failing GET reads completely free of writes", async () => {
      const reservation = await createReservation();
      await putReservationAssignment({
        actor: staffActor,
        reservationId: reservation.id,
        rawPayload: putPayload(1),
        now,
      });
      const before = await databaseFingerprint();

      await getReservationAssignmentContext({
        actor: staffActor,
        reservationId: reservation.id,
        now,
      });
      await getReservationAssignmentContext({
        actor: adminActor,
        reservationId: reservation.id,
        now,
      });
      await expect(
        getReservationAssignmentContext({
          actor: otherStaffActor,
          reservationId: reservation.id,
          now,
        }),
      ).rejects.toBeInstanceOf(ReservationAssignmentError);
      await expect(
        getReservationAssignmentContext({
          actor: staffActor,
          reservationId: randomUUID(),
          now,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await getAssignmentRoute(
          new Request(
            `http://localhost:4000/api/staff/reservations/${reservation.id}/assignment`,
            { headers: { cookie: staffCookie } },
          ),
          { params: Promise.resolve({ id: reservation.id }) },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toContain("no-store");
        const serialized = JSON.stringify(await response.json());
        expect(serialized).toContain(reservation.id);
        expect(serialized).toContain(tableOneId);
      }

      const missingResponse = await getAssignmentRoute(
        new Request(
          `http://localhost:4000/api/staff/reservations/${randomUUID()}/assignment`,
          { headers: { cookie: staffCookie } },
        ),
        { params: Promise.resolve({ id: randomUUID() }) },
      );
      const crossTenantResponse = await getAssignmentRoute(
        new Request(
          `http://localhost:4000/api/staff/reservations/${reservation.id}/assignment`,
          { headers: { cookie: otherStaffCookie } },
        ),
        { params: Promise.resolve({ id: reservation.id }) },
      );
      const anonymousResponse = await getAssignmentRoute(
        new Request(
          `http://localhost:4000/api/staff/reservations/${reservation.id}/assignment`,
        ),
        { params: Promise.resolve({ id: reservation.id }) },
      );
      expect(missingResponse.status).toBe(404);
      expect(crossTenantResponse.status).toBe(404);
      expect(anonymousResponse.status).toBe(401);

      await expect(databaseFingerprint()).resolves.toBe(before);
    });
  },
);
