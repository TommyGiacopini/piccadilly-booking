import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST as configurationPost } from "@/app/api/admin/configuration/route";
import {
  createSpecialDate,
  deleteSpecialDate,
  getOperationalConfiguration,
  updateBookingSettings,
  updateDiningTable,
  updateRoom,
  updateSpecialDate,
  updateWeeklySchedule,
} from "@/modules/configuration/application/configuration-service";
import {
  DEFAULT_BOOKING_CUTOFFS,
  DEFAULT_ROLLING_CAPACITY_COVERS,
  DEFAULT_SERVICE_TIMES,
  DEFAULT_SLOT_INTERVAL_MINUTES,
  FIXED_ROLLING_WINDOW_MINUTES,
} from "@/modules/configuration/domain/defaults";
import { operationalTimeToDatabase } from "@/modules/configuration/domain/operational-time";
import { createSessionForUser } from "@/server/auth/session";
import { LOCAL_RATE_LIMIT_SECRET } from "@/server/auth/auth-config";
import { prisma } from "@/server/db/prisma";
import {
  DayOfWeek,
  ServiceType,
  SpecialDateScope,
  UserRole,
} from "@/generated/prisma/client";
import {
  DEMO_RESTAURANT_ID,
  seedDemoOperationalConfiguration,
} from "../../../../prisma/seed";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const adminId = randomUUID();
const staffId = randomUUID();
let primaryRoomId = "";
let otherRoomId = "";
let diningTableId = "";
let scheduleId = "";
let adminCookie = "";
let staffCookie = "";

const adminActor = { restaurantId, role: "ADMIN" as const };
const staffActor = { restaurantId, role: "STAFF" as const };

function settingsData() {
  return {
    rollingCapacityCovers: DEFAULT_ROLLING_CAPACITY_COVERS,
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
  };
}

function scheduleInput(overrides: Record<string, unknown> = {}) {
  return {
    id: scheduleId,
    dayOfWeek: "MONDAY",
    serviceType: "LUNCH",
    isEnabled: "true",
    startTime: "12:00",
    endTime: "14:00",
    slotIntervalMinutes: "15",
    ...overrides,
  };
}

function specialDateInput(overrides: Record<string, unknown> = {}) {
  return {
    date: "2026-12-24",
    scope: "ALL",
    isClosed: "true",
    specialStartTime: "",
    specialEndTime: "",
    specialCapacityCovers: "",
    operationalNotes: "Chiusura completa fittizia",
    ...overrides,
  };
}

function formRequest(data: Record<string, string>, cookie?: string): Request {
  const headers = new Headers({
    accept: "application/json",
    host: "localhost:4000",
    origin: "http://localhost:4000",
    "content-type": "application/x-www-form-urlencoded",
  });

  if (cookie) {
    headers.set("cookie", cookie);
  }

  return new Request("http://localhost:4000/api/admin/configuration", {
    method: "POST",
    headers,
    body: new URLSearchParams(data),
  });
}

describe.sequential("M4 operational configuration with real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.APP_ENV = "development";
    process.env.AUTH_RESTAURANT_ID = restaurantId;
    process.env.AUTH_RATE_LIMIT_SECRET = LOCAL_RATE_LIMIT_SECRET;
    process.env.AUTH_TRUST_PROXY = "false";

    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "M4 Integration Demo", timezone: "Europe/Rome" },
        {
          id: otherRestaurantId,
          name: "M4 Isolated Demo",
          timezone: "Europe/Rome",
        },
      ],
    });
    await prisma.restaurantBookingSettings.createMany({
      data: [
        { restaurantId, ...settingsData() },
        { restaurantId: otherRestaurantId, ...settingsData() },
      ],
    });
    const primaryRoom = await prisma.room.create({
      data: {
        restaurantId,
        name: "Integration Room A",
        code: "integration-room-a",
        displayOrder: 2,
      },
    });
    const secondRoom = await prisma.room.create({
      data: {
        restaurantId,
        name: "Integration Room B",
        code: "integration-room-b",
        displayOrder: 1,
      },
    });
    const otherRoom = await prisma.room.create({
      data: {
        restaurantId: otherRestaurantId,
        name: "Other Restaurant Room",
        code: "other-room",
        displayOrder: 1,
      },
    });
    const diningTable = await prisma.diningTable.create({
      data: {
        roomId: primaryRoom.id,
        name: "DEMO-INTEGRATION-01",
        minimumSeats: 2,
        maximumSeats: 4,
        displayOrder: 1,
      },
    });
    const schedule = await prisma.weeklyServiceSchedule.create({
      data: {
        restaurantId,
        dayOfWeek: DayOfWeek.MONDAY,
        serviceType: ServiceType.LUNCH,
        isEnabled: true,
        startTime: operationalTimeToDatabase(DEFAULT_SERVICE_TIMES.LUNCH.startTime),
        endTime: operationalTimeToDatabase(DEFAULT_SERVICE_TIMES.LUNCH.endTime),
        slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
      },
    });

    primaryRoomId = primaryRoom.id;
    otherRoomId = otherRoom.id;
    diningTableId = diningTable.id;
    scheduleId = schedule.id;

    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          restaurantId,
          username: `m4.admin.${secondRoom.id.slice(0, 8)}`,
          passwordHash: "not-used-in-configuration-tests",
          role: UserRole.ADMIN,
        },
        {
          id: staffId,
          restaurantId,
          username: `m4.staff.${secondRoom.id.slice(0, 8)}`,
          passwordHash: "not-used-in-configuration-tests",
          role: UserRole.STAFF,
        },
      ],
    });

    const adminSession = await createSessionForUser(adminId);
    const staffSession = await createSessionForUser(staffId);
    adminCookie = `piccadilly_session=${adminSession.token}`;
    staffCookie = `piccadilly_session=${staffSession.token}`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurant.deleteMany({
      where: { id: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.$disconnect();
  });

  it("persists Restaurant-Room and Room-DiningTable relations", async () => {
    const room = await prisma.room.findUniqueOrThrow({
      where: { id: primaryRoomId },
      include: { restaurant: true, diningTables: true },
    });

    expect(room.restaurant.id).toBe(restaurantId);
    expect(room.diningTables.map((table) => table.id)).toContain(diningTableId);
  });

  it("enforces unique rooms per restaurant and unique tables per room", async () => {
    await expect(
      prisma.room.create({
        data: {
          restaurantId,
          name: "Integration Room A",
          code: "another-code",
          displayOrder: 9,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.diningTable.create({
        data: {
          roomId: primaryRoomId,
          name: "DEMO-INTEGRATION-01",
          minimumSeats: 1,
          maximumSeats: 2,
          displayOrder: 2,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("returns rooms in display order and supports activation changes", async () => {
    const configuration = await getOperationalConfiguration(restaurantId);
    expect(configuration.rooms.slice(0, 2).map((room) => room.displayOrder)).toEqual([
      1, 2,
    ]);

    await updateRoom(adminActor, {
      id: primaryRoomId,
      displayOrder: "3",
      isActive: undefined,
    });
    await expect(
      prisma.room.findUnique({ where: { id: primaryRoomId } }),
    ).resolves.toMatchObject({ displayOrder: 3, isActive: false });
    await updateRoom(adminActor, {
      id: primaryRoomId,
      displayOrder: "2",
      isActive: "true",
    });
  });

  it("allows ADMIN and rejects STAFF before any configuration write", async () => {
    await updateDiningTable(adminActor, {
      id: diningTableId,
      name: "DEMO-INTEGRATION-UPDATED",
      minimumSeats: "2",
      maximumSeats: "6",
      displayOrder: "2",
      isActive: "true",
    });
    await expect(
      updateRoom(staffActor, {
        id: primaryRoomId,
        displayOrder: "9",
        isActive: "true",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      prisma.room.findUnique({ where: { id: primaryRoomId } }),
    ).resolves.toMatchObject({ displayOrder: 2 });
  });

  it("validates schedule ordering, positive slots, and rolling window coherence", async () => {
    await expect(
      updateWeeklySchedule(adminActor, scheduleInput({ startTime: "14:00" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      updateWeeklySchedule(adminActor, scheduleInput({ slotIntervalMinutes: "0" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      updateWeeklySchedule(adminActor, scheduleInput({ slotIntervalMinutes: "31" })),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await updateWeeklySchedule(adminActor, scheduleInput({ isEnabled: undefined }));
    await expect(
      prisma.weeklyServiceSchedule.findUnique({ where: { id: scheduleId } }),
    ).resolves.toMatchObject({ isEnabled: false, slotIntervalMinutes: 15 });
  });

  it("enforces time, slot, and capacity checks inside PostgreSQL", async () => {
    await expect(
      prisma.weeklyServiceSchedule.create({
        data: {
          restaurantId,
          dayOfWeek: DayOfWeek.TUESDAY,
          serviceType: ServiceType.LUNCH,
          startTime: operationalTimeToDatabase("14:00"),
          endTime: operationalTimeToDatabase("14:00"),
          slotIntervalMinutes: 15,
        },
      }),
    ).rejects.toBeTruthy();
    await expect(
      prisma.weeklyServiceSchedule.create({
        data: {
          restaurantId,
          dayOfWeek: DayOfWeek.TUESDAY,
          serviceType: ServiceType.DINNER,
          startTime: operationalTimeToDatabase("19:00"),
          endTime: operationalTimeToDatabase("22:15"),
          slotIntervalMinutes: 0,
        },
      }),
    ).rejects.toBeTruthy();
  });

  it("validates positive capacity and configurable cut-offs", async () => {
    await expect(
      updateBookingSettings(adminActor, {
        rollingCapacityCovers: "0",
        rollingWindowMinutes: "30",
        ...DEFAULT_BOOKING_CUTOFFS,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await updateBookingSettings(adminActor, {
      rollingCapacityCovers: "32",
      rollingWindowMinutes: "30",
      lunchModificationCutoff: "10:15",
      dinnerModificationCutoff: "17:15",
      fridayDinnerBookingCutoff: "17:20",
      saturdayDinnerBookingCutoff: "17:25",
    });
    const configuration = await getOperationalConfiguration(restaurantId);
    expect(configuration.settings).toMatchObject({
      rollingCapacityCovers: 32,
      lunchModificationCutoff: "10:15",
      dinnerModificationCutoff: "17:15",
      fridayDinnerBookingCutoff: "17:20",
      saturdayDinnerBookingCutoff: "17:25",
    });
  });

  it("creates complete, lunch-only, dinner-only and open special dates", async () => {
    await createSpecialDate(adminActor, specialDateInput());
    await expect(
      createSpecialDate(adminActor, specialDateInput()),
    ).rejects.toMatchObject({ code: "DUPLICATE" });
    await createSpecialDate(
      adminActor,
      specialDateInput({ date: "2026-12-25", scope: "LUNCH" }),
    );
    await createSpecialDate(
      adminActor,
      specialDateInput({ date: "2026-12-25", scope: "DINNER" }),
    );
    await createSpecialDate(
      adminActor,
      specialDateInput({
        date: "2026-12-31",
        scope: "DINNER",
        isClosed: undefined,
        specialStartTime: "20:00",
        specialEndTime: "23:00",
        specialCapacityCovers: "24",
        operationalNotes: "Apertura straordinaria demo",
      }),
    );

    const configuration = await getOperationalConfiguration(restaurantId);
    expect(
      configuration.specialDateOverrides.map((override) => [
        override.date,
        override.scope,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["2026-12-24", SpecialDateScope.ALL],
        ["2026-12-25", SpecialDateScope.LUNCH],
        ["2026-12-25", SpecialDateScope.DINNER],
        ["2026-12-31", SpecialDateScope.DINNER],
      ]),
    );
    expect(
      configuration.specialDateOverrides.find(
        (override) => override.date === "2026-12-31",
      ),
    ).toMatchObject({
      specialStartTime: "20:00",
      specialEndTime: "23:00",
      specialCapacityCovers: 24,
    });
  });

  it("updates and removes a special date", async () => {
    const existing = await prisma.specialDateOverride.findFirstOrThrow({
      where: {
        restaurantId,
        date: new Date("2026-12-31T00:00:00.000Z"),
      },
    });

    await updateSpecialDate(
      adminActor,
      specialDateInput({
        id: existing.id,
        date: "2026-12-31",
        scope: "DINNER",
        isClosed: undefined,
        specialStartTime: "19:30",
        specialEndTime: "23:15",
        specialCapacityCovers: "26",
      }),
    );
    await deleteSpecialDate(adminActor, { id: existing.id });
    await expect(
      prisma.specialDateOverride.findUnique({ where: { id: existing.id } }),
    ).resolves.toBeNull();
  });

  it("prevents cross-restaurant updates", async () => {
    await expect(
      updateRoom(adminActor, {
        id: otherRoomId,
        displayOrder: "8",
        isActive: undefined,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      prisma.room.findUnique({ where: { id: otherRoomId } }),
    ).resolves.toMatchObject({ displayOrder: 1, isActive: true });
  });

  it("enforces anonymous, STAFF and ADMIN mutation authorization at the HTTP boundary", async () => {
    const data = {
      action: "update-room",
      id: primaryRoomId,
      displayOrder: "4",
      isActive: "true",
    };

    expect((await configurationPost(formRequest(data))).status).toBe(401);
    expect((await configurationPost(formRequest(data, staffCookie))).status).toBe(
      403,
    );
    const adminResponse = await configurationPost(formRequest(data, adminCookie));
    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.json()).resolves.toEqual({ ok: true });
    await expect(
      prisma.room.findUnique({ where: { id: primaryRoomId } }),
    ).resolves.toMatchObject({ displayOrder: 4 });
  });

  it("keeps the operational seed idempotent without reservations", async () => {
    await seedDemoOperationalConfiguration(prisma);
    await seedDemoOperationalConfiguration(prisma);

    await expect(
      prisma.room.count({ where: { restaurantId: DEMO_RESTAURANT_ID } }),
    ).resolves.toBe(5);
    await expect(
      prisma.diningTable.count({
        where: { room: { restaurantId: DEMO_RESTAURANT_ID } },
      }),
    ).resolves.toBe(5);
    await expect(
      prisma.weeklyServiceSchedule.count({
        where: { restaurantId: DEMO_RESTAURANT_ID },
      }),
    ).resolves.toBe(14);
    await expect(
      prisma.restaurantBookingSettings.count({
        where: { restaurantId: DEMO_RESTAURANT_ID },
      }),
    ).resolves.toBe(1);
  });
});
