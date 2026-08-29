import "dotenv/config";

import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
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
import { readDashboardReservationsWithClient } from "@/modules/dashboard/infrastructure/dashboard-repository";
import {
  getReservationAssignmentContext,
  putReservationAssignment,
} from "@/modules/rooms/application/reservation-assignment-service";
import { PrismaClient } from "@/generated/prisma/client";
import { resolveDatabaseUrl } from "@/server/db/database-config";
import { prisma } from "@/server/db/prisma";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const userId = randomUUID();
const otherUserId = randomUUID();
const roomOneId = randomUUID();
const roomTwoId = randomUUID();
const otherRoomId = randomUUID();
const tableOneId = randomUUID();
const tableTwoId = randomUUID();
const tableThreeId = randomUUID();
const otherTableId = randomUUID();
const localDate = "2099-10-20";
const now = new Date("2099-01-10T10:00:00.000Z");
const internalNotesSentinel = "M10-C-INTERNAL-NOTES-MUST-NOT-ENTER-LIST";

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

function reservationData(input: {
  id: string;
  targetRestaurantId: string;
  partySize: number;
  status?: "CONFIRMED" | "CANCELLED";
  preferenceRoomCode: string;
}) {
  const status = input.status ?? "CONFIRMED";
  return {
    id: input.id,
    restaurantId: input.targetRestaurantId,
    localDate: localDateToDatabase(localDate),
    serviceType: "DINNER" as const,
    arrivalTime: operationalTimeToDatabase("19:00"),
    partySize: input.partySize,
    status,
    origin: "PHONE" as const,
    customerFirstName: "Cliente",
    customerLastName: `Fittizio ${input.id.slice(0, 6)}`,
    customerPhone: "+39000000000",
    customerEmail: null,
    preferences: JSON.stringify({
      roomCode: input.preferenceRoomCode,
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
    privacyPolicyVersion: "m10-c-fake-v1",
    privacyConsentAt: now,
    privacyConsentMethod: "VERBAL" as const,
    createdByUserId:
      input.targetRestaurantId === restaurantId ? userId : otherUserId,
    cancelledAt: status === "CANCELLED" ? now : null,
  };
}

async function createAssignment(input: {
  reservationId: string;
  targetRestaurantId?: string;
  targetUserId?: string;
  roomId?: string;
  tableId?: string;
  notes?: string | null;
}) {
  const targetRestaurantId = input.targetRestaurantId ?? restaurantId;
  const targetUserId = input.targetUserId ?? userId;
  const targetRoomId = input.roomId ?? roomTwoId;
  const targetTableId = input.tableId ?? tableTwoId;
  const assignment = await prisma.reservationAssignment.create({
    data: {
      restaurantId: targetRestaurantId,
      reservationId: input.reservationId,
      roomId: targetRoomId,
      internalNotes: input.notes ?? null,
      assignedByUserId: targetUserId,
      updatedByUserId: targetUserId,
    },
  });
  await prisma.reservationAssignmentTable.create({
    data: {
      restaurantId: targetRestaurantId,
      assignmentId: assignment.id,
      roomId: targetRoomId,
      diningTableId: targetTableId,
    },
  });
}

describe.sequential("M10-C dashboard read model with real PostgreSQL", () => {
  beforeAll(async () => {
    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "M10-C Demo", timezone: "Europe/Rome" },
        {
          id: otherRestaurantId,
          name: "M10-C Other Demo",
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
          id: roomOneId,
          restaurantId,
          code: "sala-1",
          name: "Sala 1",
          displayOrder: 1,
        },
        {
          id: roomTwoId,
          restaurantId,
          code: "sala-2",
          name: "Sala 2",
          displayOrder: 2,
        },
        {
          id: otherRoomId,
          restaurantId: otherRestaurantId,
          code: "sala-1",
          name: "Sala 1",
          displayOrder: 1,
        },
      ],
    });
    await prisma.diningTable.createMany({
      data: [
        {
          id: tableOneId,
          roomId: roomOneId,
          name: "M10C-T1",
          minimumSeats: 2,
          maximumSeats: 4,
        },
        {
          id: tableTwoId,
          roomId: roomTwoId,
          name: "M10C-T2",
          minimumSeats: 2,
          maximumSeats: 6,
        },
        {
          id: tableThreeId,
          roomId: roomTwoId,
          name: "M10C-T3",
          minimumSeats: 1,
          maximumSeats: 2,
          displayOrder: 2,
        },
        {
          id: otherTableId,
          roomId: otherRoomId,
          name: "M10C-OTHER",
          minimumSeats: 2,
          maximumSeats: 4,
        },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: userId,
          restaurantId,
          username: `m10c.staff.${restaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m10-c-tests",
          role: "STAFF",
        },
        {
          id: otherUserId,
          restaurantId: otherRestaurantId,
          username: `m10c.other.${otherRestaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m10-c-tests",
          role: "STAFF",
        },
      ],
    });
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
    await prisma.serviceRoomAvailability.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.serviceInstance.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservationAssignmentTable.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservationAssignment.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservation.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.room.updateMany({
      where: { restaurantId },
      data: { isActive: true },
    });
    await prisma.diningTable.updateMany({
      where: { roomId: { in: [roomOneId, roomTwoId] } },
      data: { isActive: true },
    });

    const assignedReservationId = randomUUID();
    const unassignedReservationId = randomUUID();
    const cancelledReservationId = randomUUID();
    const otherReservationRowId = randomUUID();
    await prisma.reservation.createMany({
      data: [
        reservationData({
          id: assignedReservationId,
          targetRestaurantId: restaurantId,
          partySize: 2,
          preferenceRoomCode: "sala-1",
        }),
        reservationData({
          id: unassignedReservationId,
          targetRestaurantId: restaurantId,
          partySize: 3,
          preferenceRoomCode: "sala-2",
        }),
        reservationData({
          id: cancelledReservationId,
          targetRestaurantId: restaurantId,
          partySize: 7,
          status: "CANCELLED",
          preferenceRoomCode: "sala-1",
        }),
        reservationData({
          id: otherReservationRowId,
          targetRestaurantId: otherRestaurantId,
          partySize: 19,
          preferenceRoomCode: "sala-1",
        }),
      ],
    });
    await createAssignment({
      reservationId: assignedReservationId,
      notes: internalNotesSentinel,
    });
    await createAssignment({ reservationId: cancelledReservationId });
    await createAssignment({
      reservationId: otherReservationRowId,
      targetRestaurantId: otherRestaurantId,
      targetUserId: otherUserId,
      roomId: otherRoomId,
      tableId: otherTableId,
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
    await prisma.serviceRoomAvailability.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.serviceInstance.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservationAssignmentTable.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservationAssignment.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservation.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.diningTable.deleteMany({
      where: { roomId: { in: [roomOneId, roomTwoId, otherRoomId] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.room.deleteMany({
      where: { id: { in: [roomOneId, roomTwoId, otherRoomId] } },
    });
    await prisma.weeklyServiceSchedule.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurantBookingSettings.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurant.deleteMany({
      where: { id: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.$disconnect();
  });

  it("projects tenant-scoped latest notification health without delivery details", async () => {
    const ownReservations = await prisma.reservation.findMany({
      where: { restaurantId, status: "CONFIRMED" },
      orderBy: { id: "asc" },
    });
    const otherReservation = await prisma.reservation.findFirstOrThrow({
      where: { restaurantId: otherRestaurantId },
    });
    const partialId = ownReservations[0]!.id;
    const deadId = ownReservations[1]!.id;
    const common = {
      source: "PHONE" as const,
      actorUserId: userId,
      strategy: "WHATSAPP_AND_EMAIL_PARALLEL" as const,
      payloadVersion: 1,
      payload: {
        schemaVersion: 1,
        templateKey: "RESERVATION_UPDATED",
        templateVersion: 1,
        locale: "IT",
        params: {
          customerFirstName: "Cliente",
          restaurantName: "M10-C Demo",
          localDate,
          serviceType: "DINNER",
          arrivalTime: "19:00",
          partySize: 2,
        },
      },
      scheduledAt: now,
      availableAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
      attemptCount: 1,
      maxAttempts: 4,
      retryPolicyVersion: 1,
      originCorrelationId: randomUUID(),
      terminalAt: now,
    };
    const partialGroup = randomUUID();
    await prisma.notificationOutbox.createMany({
      data: [
        {
          ...common,
          restaurantId,
          reservationId: partialId,
          eventGroupId: randomUUID(),
          reservationVersion: 1,
          eventType: "RESERVATION_CONFIRMED",
          channel: "WHATSAPP",
          destination: "+39000000000",
          status: "DEAD",
          terminalFailureCode: "RETRY_EXHAUSTED",
          idempotencyKey: "1".repeat(64),
          createdAt: new Date(now.getTime() - 10_000),
        },
        {
          ...common,
          restaurantId,
          reservationId: partialId,
          eventGroupId: partialGroup,
          reservationVersion: 2,
          eventType: "RESERVATION_UPDATED",
          channel: "WHATSAPP",
          destination: "+39000000000",
          status: "SUCCEEDED",
          terminalFailureCode: null,
          idempotencyKey: "2".repeat(64),
        },
        {
          ...common,
          restaurantId,
          reservationId: partialId,
          eventGroupId: partialGroup,
          reservationVersion: 2,
          eventType: "RESERVATION_UPDATED",
          channel: "EMAIL",
          destination: "fake@example.invalid",
          status: "DEAD",
          terminalFailureCode: "SIMULATED_PERMANENT_FAILURE",
          idempotencyKey: "3".repeat(64),
        },
        {
          ...common,
          restaurantId,
          reservationId: deadId,
          eventGroupId: randomUUID(),
          reservationVersion: 1,
          eventType: "RESERVATION_CONFIRMED",
          channel: "WHATSAPP",
          destination: "+39000000000",
          status: "DEAD",
          terminalFailureCode: "RETRY_EXHAUSTED",
          idempotencyKey: "4".repeat(64),
        },
        {
          ...common,
          restaurantId: otherRestaurantId,
          reservationId: otherReservation.id,
          actorUserId: otherUserId,
          eventGroupId: randomUUID(),
          reservationVersion: 1,
          eventType: "RESERVATION_CONFIRMED",
          channel: "WHATSAPP",
          destination: "+39000000000",
          status: "DEAD",
          terminalFailureCode: "RETRY_EXHAUSTED",
          idempotencyKey: "5".repeat(64),
        },
      ],
    });

    const dashboard = await getDashboardDay({ restaurantId, rawDate: localDate, now });
    expect(dashboard.reservations.find((row) => row.id === partialId)?.notificationHealth).toBe("PARTIAL_SUCCESS");
    expect(dashboard.reservations.find((row) => row.id === deadId)?.notificationHealth).toBe("NOT_DELIVERED");
    expect(JSON.stringify(dashboard.reservations.map((row) => row.notificationHealth))).not.toMatch(/destination|payload|provider|attempt/iu);
    expect(dashboard.reservations.some((row) => row.id === otherReservation.id)).toBe(false);
  });

  it("projects assignment state, keeps preference separate and aggregates final rooms", async () => {
    const dashboard = await getDashboardDay({
      restaurantId,
      rawDate: localDate,
      now,
    });

    expect(dashboard.reservations).toHaveLength(3);
    expect(dashboard.summary).toMatchObject({
      confirmedReservations: 2,
      confirmedCovers: 5,
      cancellations: 1,
      assignedReservations: 1,
      unassignedReservations: 1,
      unassignedCovers: 3,
    });
    expect(dashboard.summary.finalRoomCovers).toContainEqual({
      code: "sala-2",
      label: "Sala 2",
      covers: 2,
    });
    const assigned = dashboard.reservations.find(
      (reservation) => reservation.assignment !== null && reservation.status === "CONFIRMED",
    );
    expect(assigned).toMatchObject({
      preferredRoom: "Sala 1",
      assignment: {
        roomCode: "sala-2",
        roomName: "Sala 2",
        tableNames: ["M10C-T2"],
        internalNotesPresent: true,
      },
    });
    expect(JSON.stringify(dashboard)).not.toContain(internalNotesSentinel);
    expect(JSON.stringify(dashboard)).not.toContain("M10C-OTHER");
  });

  it("projects note presence with a fixed tenant-scoped query without selecting note text", async () => {
    const queryClient = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
      }),
      log: [{ emit: "event", level: "query" }],
    });
    const queries: string[] = [];
    queryClient.$on("query", (event) => queries.push(event.query));
    const extraReservationId = randomUUID();

    try {
      const firstRead = await readDashboardReservationsWithClient(queryClient, {
        restaurantId,
        localDate,
      });
      const firstSelectCount = queries.filter((query) =>
        /^\s*SELECT\b/iu.test(query),
      ).length;
      const noteProjectionQueries = queries.filter((query) =>
        /internal_notes/iu.test(query),
      );

      expect(
        firstRead.find(
          (row) =>
            row.reservation.status === "CONFIRMED" && row.assignment !== null,
        )?.assignment,
      ).toMatchObject({ internalNotesPresent: true });
      expect(noteProjectionQueries).toHaveLength(1);
      expect(noteProjectionQueries[0]).toContain(
        'assignment.internal_notes IS NOT NULL AS "internalNotesPresent"',
      );
      expect(noteProjectionQueries[0]).toContain(
        "assignment.restaurant_id = $1::uuid",
      );
      expect(noteProjectionQueries[0]).toContain(
        "reservation.restaurant_id = $2::uuid",
      );
      expect(noteProjectionQueries[0]).not.toContain(
        'assignment.internal_notes AS "internalNotes"',
      );

      await prisma.reservation.create({
        data: reservationData({
          id: extraReservationId,
          targetRestaurantId: restaurantId,
          partySize: 4,
          preferenceRoomCode: "sala-1",
        }),
      });
      queries.length = 0;
      await readDashboardReservationsWithClient(queryClient, {
        restaurantId,
        localDate,
      });

      expect(
        queries.filter((query) => /^\s*SELECT\b/iu.test(query)),
      ).toHaveLength(firstSelectCount);
    } finally {
      await prisma.reservation.deleteMany({
        where: { id: extraReservationId, restaurantId },
      });
      await queryClient.$disconnect();
    }
  });

  it("filters operationally unassigned and final-room rows without treating cancelled as unassigned", async () => {
    const unassigned = await getDashboardDay({
      restaurantId,
      rawDate: localDate,
      rawAssignment: "UNASSIGNED",
      now,
    });
    const finalRoom = await getDashboardDay({
      restaurantId,
      rawDate: localDate,
      rawAssignment: "ASSIGNED",
      rawFinalRoom: "sala-2",
      now,
    });

    expect(unassigned.reservations).toHaveLength(1);
    expect(unassigned.reservations[0]?.status).toBe("CONFIRMED");
    expect(unassigned.reservations[0]?.assignment).toBeNull();
    expect(finalRoom.reservations).toHaveLength(2);
    expect(finalRoom.reservations.every((row) => row.assignment?.roomCode === "sala-2")).toBe(true);
  });

  it("does not materialize service instances during dashboard reads", async () => {
    const before = await prisma.serviceInstance.count({ where: { restaurantId } });

    await getDashboardDay({ restaurantId, rawDate: localDate, now });
    await getDashboardDay({ restaurantId, rawDate: localDate, now });

    expect(await prisma.serviceInstance.count({ where: { restaurantId } })).toBe(before);
  });

  it("preserves an assigned room after deactivation and rejects another inactive room", async () => {
    const reservation = await prisma.reservation.findFirstOrThrow({
      where: {
        restaurantId,
        status: "CONFIRMED",
        assignment: { is: { clearedAt: null } },
      },
      select: { id: true, version: true },
    });
    await prisma.room.updateMany({
      where: { id: { in: [roomOneId, roomTwoId] }, restaurantId },
      data: { isActive: false },
    });

    const dashboard = await getDashboardDay({
      restaurantId,
      rawDate: localDate,
      now,
    });
    const assigned = dashboard.reservations.find(
      (row) => row.id === reservation.id,
    );
    const noOp = await putReservationAssignment({
      actor: { id: userId, restaurantId },
      reservationId: reservation.id,
      rawPayload: {
        version: reservation.version,
        roomId: roomTwoId,
        tableIds: [tableTwoId],
        internalNotes: internalNotesSentinel,
      },
      now,
    });

    expect(assigned?.assignment).toMatchObject({
      roomName: "Sala 2",
      tableNames: ["M10C-T2"],
      internalNotesPresent: true,
      hasInactiveReferences: true,
    });
    expect(noOp).toMatchObject({
      changed: false,
      reservationVersion: reservation.version,
    });
    await expect(
      getReservationAssignmentContext({
        actor: { id: userId, restaurantId },
        reservationId: reservation.id,
        now,
      }),
    ).resolves.toMatchObject({
      assignment: {
        room: { id: roomTwoId },
        tables: [{ id: tableTwoId }],
        internalNotes: internalNotesSentinel,
        hasInactiveReferences: true,
      },
    });
    await expect(
      putReservationAssignment({
        actor: { id: userId, restaurantId },
        reservationId: reservation.id,
        rawPayload: {
          version: reservation.version,
          roomId: roomOneId,
          tableIds: [tableOneId],
          internalNotes: internalNotesSentinel,
        },
        now,
      }),
    ).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
  });

  it("preserves an assigned inactive table and rejects another inactive table", async () => {
    const reservation = await prisma.reservation.findFirstOrThrow({
      where: {
        restaurantId,
        status: "CONFIRMED",
        assignment: { is: { clearedAt: null } },
      },
      select: { id: true, version: true },
    });
    await prisma.diningTable.updateMany({
      where: { id: { in: [tableTwoId, tableThreeId] }, roomId: roomTwoId },
      data: { isActive: false },
    });

    const dashboard = await getDashboardDay({
      restaurantId,
      rawDate: localDate,
      now,
    });
    const assigned = dashboard.reservations.find(
      (row) => row.id === reservation.id,
    );
    const noOp = await putReservationAssignment({
      actor: { id: userId, restaurantId },
      reservationId: reservation.id,
      rawPayload: {
        version: reservation.version,
        roomId: roomTwoId,
        tableIds: [tableTwoId],
        internalNotes: internalNotesSentinel,
      },
      now,
    });

    expect(assigned?.assignment).toMatchObject({
      roomName: "Sala 2",
      tableNames: ["M10C-T2"],
      internalNotesPresent: true,
      hasInactiveReferences: true,
      hasUnavailableRoomReference: false,
    });
    expect(noOp).toMatchObject({
      changed: false,
      reservationVersion: reservation.version,
    });
    await expect(
      getReservationAssignmentContext({
        actor: { id: userId, restaurantId },
        reservationId: reservation.id,
        now,
      }),
    ).resolves.toMatchObject({
      assignment: {
        tables: [{ id: tableTwoId, isActive: false }],
        internalNotes: internalNotesSentinel,
        hasInactiveReferences: true,
      },
    });
    await expect(
      putReservationAssignment({
        actor: { id: userId, restaurantId },
        reservationId: reservation.id,
        rawPayload: {
          version: reservation.version,
          roomId: roomTwoId,
          tableIds: [tableTwoId, tableThreeId],
          internalNotes: internalNotesSentinel,
        },
        now,
      }),
    ).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
  });

  it("preserves an assigned unavailable room and rejects another unavailable room", async () => {
    const reservation = await prisma.reservation.findFirstOrThrow({
      where: {
        restaurantId,
        status: "CONFIRMED",
        assignment: { is: { clearedAt: null } },
      },
      select: { id: true, version: true },
    });
    const serviceInstance = await prisma.serviceInstance.create({
      data: {
        restaurantId,
        localDate: localDateToDatabase(localDate),
        serviceType: "DINNER",
      },
    });
    await prisma.serviceRoomAvailability.createMany({
      data: [roomOneId, roomTwoId].map((roomId) => ({
        restaurantId,
        serviceInstanceId: serviceInstance.id,
        roomId,
        isAvailable: false,
      })),
    });
    const instanceCountBefore = await prisma.serviceInstance.count({
      where: { restaurantId },
    });

    const dashboard = await getDashboardDay({
      restaurantId,
      rawDate: localDate,
      now,
    });
    const assigned = dashboard.reservations.find(
      (row) => row.id === reservation.id,
    );
    const noOp = await putReservationAssignment({
      actor: { id: userId, restaurantId },
      reservationId: reservation.id,
      rawPayload: {
        version: reservation.version,
        roomId: roomTwoId,
        tableIds: [tableTwoId],
        internalNotes: internalNotesSentinel,
      },
      now,
    });

    expect(assigned?.assignment).toMatchObject({
      roomName: "Sala 2",
      tableNames: ["M10C-T2"],
      internalNotesPresent: true,
      hasInactiveReferences: false,
      hasUnavailableRoomReference: true,
    });
    expect(noOp).toMatchObject({
      changed: false,
      reservationVersion: reservation.version,
    });
    await expect(
      getReservationAssignmentContext({
        actor: { id: userId, restaurantId },
        reservationId: reservation.id,
        now,
      }),
    ).resolves.toMatchObject({
      assignment: {
        room: { id: roomTwoId, isAvailableForService: false },
        tables: [{ id: tableTwoId }],
        internalNotes: internalNotesSentinel,
        hasUnavailableRoomReference: true,
      },
    });
    await expect(
      putReservationAssignment({
        actor: { id: userId, restaurantId },
        reservationId: reservation.id,
        rawPayload: {
          version: reservation.version,
          roomId: roomOneId,
          tableIds: [tableOneId],
          internalNotes: internalNotesSentinel,
        },
        now,
      }),
    ).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
    expect(
      await prisma.serviceInstance.count({ where: { restaurantId } }),
    ).toBe(instanceCountBefore);
  });
});
