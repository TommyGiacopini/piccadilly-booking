import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET as availabilityPreviewGet } from "@/app/api/admin/availability-preview/route";
import {
  DayOfWeek,
  ServiceType,
  SpecialDateScope,
  UserRole,
} from "@/generated/prisma/client";
import { getAvailabilityPreview } from "@/modules/availability/application/availability-service";
import { getLocalDayOfWeek } from "@/modules/availability/domain/local-calendar";
import type { AvailabilityServiceType } from "@/modules/availability/domain/types";
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
import { createSessionForUser } from "@/server/auth/session";
import { getSessionCookieName } from "@/server/auth/session-token";
import { prisma } from "@/server/db/prisma";
import { getAppEnvironment } from "@/shared/config/app-environment";
import { DEMO_RESTAURANT_ID } from "../../../../prisma/seed";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const adminId = randomUUID();
const staffId = randomUUID();
const allClosedDate = "2099-12-24";
const serviceClosedDate = "2099-12-25";
const precedenceDate = "2099-12-26";
const capacityDate = "2099-12-31";
const apiDate = "2099-12-20";
const disabledDate = "2099-11-03";
let adminCookie = "";
let staffCookie = "";

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

function preview(
  restaurant: string,
  date: string,
  serviceType: AvailabilityServiceType,
) {
  return getAvailabilityPreview({
    restaurantId: restaurant,
    date,
    serviceType,
    partySize: 2,
    channel: "PUBLIC",
    now: new Date("2099-01-01T10:00:00.000Z"),
  });
}

function apiRequest(
  cookie?: string,
  query = `date=${apiDate}&service=LUNCH&partySize=2&channel=PUBLIC`,
): Request {
  const headers = new Headers();

  if (cookie) {
    headers.set("cookie", cookie);
  }

  return new Request(
    `http://localhost:4000/api/admin/availability-preview?${query}`,
    { headers },
  );
}

describe.sequential("M5 availability with real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.APP_ENV = "development";

    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "M5 Availability Demo", timezone: "Europe/Rome" },
        {
          id: otherRestaurantId,
          name: "M5 Availability Isolated Demo",
          timezone: "Europe/Rome",
        },
      ],
    });
    await prisma.restaurantBookingSettings.createMany({
      data: [
        { restaurantId, ...bookingSettingsData(30) },
        { restaurantId: otherRestaurantId, ...bookingSettingsData(9) },
      ],
    });
    await prisma.weeklyServiceSchedule.createMany({
      data: [
        ...weeklySchedules(restaurantId),
        ...weeklySchedules(otherRestaurantId),
      ],
    });
    await prisma.bookingCutoffRule.createMany({
      data: [DayOfWeek.FRIDAY, DayOfWeek.SATURDAY].map((dayOfWeek) => ({
        restaurantId,
        dayOfWeek,
        serviceType: ServiceType.DINNER,
        isEnabled: true,
        cutoffTime: operationalTimeToDatabase(
          DEFAULT_BOOKING_CUTOFFS.publicBookingCutoffTime,
        ),
      })),
    });
    await prisma.specialDateOverride.createMany({
      data: [
        {
          restaurantId,
          date: localDateToDatabase(allClosedDate),
          scope: SpecialDateScope.ALL,
          isClosed: true,
        },
        {
          restaurantId,
          date: localDateToDatabase(serviceClosedDate),
          scope: SpecialDateScope.LUNCH,
          isClosed: true,
        },
        {
          restaurantId,
          date: localDateToDatabase(precedenceDate),
          scope: SpecialDateScope.ALL,
          isClosed: true,
        },
        {
          restaurantId,
          date: localDateToDatabase(precedenceDate),
          scope: SpecialDateScope.DINNER,
          isClosed: false,
          specialStartTime: operationalTimeToDatabase("20:00"),
          specialEndTime: operationalTimeToDatabase("21:00"),
          specialCapacityCovers: 14,
        },
        {
          restaurantId,
          date: localDateToDatabase(capacityDate),
          scope: SpecialDateScope.DINNER,
          isClosed: false,
          specialCapacityCovers: 12,
        },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          restaurantId,
          username: `m5.admin.${restaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-availability-tests",
          role: UserRole.ADMIN,
        },
        {
          id: staffId,
          restaurantId,
          username: `m5.staff.${restaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-availability-tests",
          role: UserRole.STAFF,
        },
      ],
    });

    const adminSession = await createSessionForUser(adminId);
    const staffSession = await createSessionForUser(staffId);
    const cookieName = getSessionCookieName(getAppEnvironment());
    adminCookie = `${cookieName}=${adminSession.token}`;
    staffCookie = `${cookieName}=${staffSession.token}`;
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

  it("reads the operational seed with an empty persistent load", async () => {
    const result = await preview(
      DEMO_RESTAURANT_ID,
      "2099-12-21",
      "DINNER",
    );

    expect(result).toMatchObject({
      timezone: "Europe/Rome",
      capacityLimit: 30,
      rollingWindowMinutes: 30,
      isOpen: true,
    });
    expect(result.slots.every((slot) => slot.remainingCapacity === 30)).toBe(
      true,
    );
  });

  it("resolves seeded LUNCH slots inclusively", async () => {
    const result = await preview(restaurantId, apiDate, "LUNCH");

    expect(result.slots).toHaveLength(9);
    expect(result.slots[0]?.time).toBe("12:00");
    expect(result.slots.at(-1)?.time).toBe("14:00");
  });

  it("resolves seeded DINNER slots inclusively", async () => {
    const result = await preview(restaurantId, apiDate, "DINNER");

    expect(result.slots).toHaveLength(14);
    expect(result.slots[0]?.time).toBe("19:00");
    expect(result.slots.at(-1)?.time).toBe("22:15");
  });

  it("reads a generic Friday cutoff while keeping STAFF available", async () => {
    const input = {
      restaurantId,
      date: "2099-11-20",
      serviceType: "DINNER" as const,
      partySize: 2,
      now: new Date("2099-11-20T16:30:00.000Z"),
    };
    const [publicResult, staffResult] = await Promise.all([
      getAvailabilityPreview({ ...input, channel: "PUBLIC" }),
      getAvailabilityPreview({ ...input, channel: "STAFF" }),
    ]);

    expect(publicResult.slots[0]?.reason).toBe("ONLINE_CUTOFF_REACHED");
    expect(staffResult.slots[0]?.available).toBe(true);
  });

  it("resolves a disabled weekly rule as closed", async () => {
    const dayOfWeek = DayOfWeek[getLocalDayOfWeek(disabledDate)];

    await prisma.weeklyServiceSchedule.update({
      where: {
        restaurantId_dayOfWeek_serviceType: {
          restaurantId,
          dayOfWeek,
          serviceType: ServiceType.LUNCH,
        },
      },
      data: { isEnabled: false },
    });

    try {
      await expect(preview(restaurantId, disabledDate, "LUNCH")).resolves.toMatchObject({
        isOpen: false,
        reason: "SERVICE_CLOSED",
        source: "WEEKLY",
      });
    } finally {
      await prisma.weeklyServiceSchedule.update({
        where: {
          restaurantId_dayOfWeek_serviceType: {
            restaurantId,
            dayOfWeek,
            serviceType: ServiceType.LUNCH,
          },
        },
        data: { isEnabled: true },
      });
    }
  });

  it("resolves an ALL special-date closure", async () => {
    await expect(preview(restaurantId, allClosedDate, "DINNER")).resolves.toMatchObject({
      isOpen: false,
      source: "SPECIAL_DATE_ALL",
      reason: "SERVICE_CLOSED",
    });
  });

  it("resolves a service-specific special-date closure", async () => {
    await expect(preview(restaurantId, serviceClosedDate, "LUNCH")).resolves.toMatchObject({
      isOpen: false,
      source: "SPECIAL_DATE_SERVICE",
    });
    await expect(preview(restaurantId, serviceClosedDate, "DINNER")).resolves.toMatchObject({
      isOpen: true,
      source: "WEEKLY",
    });
  });

  it("gives a service-specific opening precedence over ALL", async () => {
    const result = await preview(restaurantId, precedenceDate, "DINNER");

    expect(result).toMatchObject({
      isOpen: true,
      source: "SPECIAL_DATE_SERVICE",
      capacityLimit: 14,
    });
    expect(result.slots.map((slot) => slot.time)).toEqual([
      "20:00",
      "20:15",
      "20:30",
      "20:45",
      "21:00",
    ]);
  });

  it("applies a special capacity", async () => {
    const result = await preview(restaurantId, capacityDate, "DINNER");

    expect(result.capacityLimit).toBe(12);
    expect(result.slots[0]?.remainingCapacity).toBe(12);
  });

  it("isolates configuration by restaurantId", async () => {
    const primary = await preview(restaurantId, apiDate, "DINNER");
    const isolated = await preview(otherRestaurantId, apiDate, "DINNER");

    expect(primary.capacityLimit).toBe(30);
    expect(isolated.capacityLimit).toBe(9);
  });

  it("does not write while reading availability", async () => {
    const before = {
      restaurants: await prisma.restaurant.count({
        where: { id: { in: [restaurantId, otherRestaurantId] } },
      }),
      schedules: await prisma.weeklyServiceSchedule.count({
        where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
      }),
      settings: await prisma.restaurantBookingSettings.count({
        where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
      }),
      overrides: await prisma.specialDateOverride.count({
        where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
      }),
    };

    await preview(restaurantId, apiDate, "LUNCH");

    const after = {
      restaurants: await prisma.restaurant.count({
        where: { id: { in: [restaurantId, otherRestaurantId] } },
      }),
      schedules: await prisma.weeklyServiceSchedule.count({
        where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
      }),
      settings: await prisma.restaurantBookingSettings.count({
        where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
      }),
      overrides: await prisma.specialDateOverride.count({
        where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
      }),
    };

    expect(after).toEqual(before);
  });

  it("keeps the preview consultative and does not create reservations", async () => {
    const before = await prisma.reservation.count({
      where: { restaurantId },
    });

    await preview(restaurantId, apiDate, "DINNER");

    await expect(
      prisma.reservation.count({ where: { restaurantId } }),
    ).resolves.toBe(before);
  });

  it("authorizes ADMIN and returns a no-store minimal DTO", async () => {
    const response = await availabilityPreviewGet(apiRequest(adminCookie));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toMatchObject({
      date: apiDate,
      serviceType: "LUNCH",
      isOpen: true,
    });
    expect(body.slots).toHaveLength(9);
    expect(JSON.stringify(body)).not.toContain(restaurantId);
    expect(JSON.stringify(body)).not.toContain("password");
  });

  it("rejects simulated loads and invalid query values", async () => {
    const simulatedLoadResponse = await availabilityPreviewGet(
      apiRequest(
        adminCookie,
        `date=${apiDate}&service=LUNCH&partySize=2&arrivals=19%3A00`,
      ),
    );
    const decimalResponse = await availabilityPreviewGet(
      apiRequest(
        adminCookie,
        `date=${apiDate}&service=LUNCH&partySize=1.5`,
      ),
    );

    expect(simulatedLoadResponse.status).toBe(400);
    expect(decimalResponse.status).toBe(400);
    expect(simulatedLoadResponse.headers.get("cache-control")).toContain(
      "no-store",
    );
  });

  it("rejects STAFF with no-store", async () => {
    const response = await availabilityPreviewGet(apiRequest(staffCookie));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects anonymous requests with no-store", async () => {
    const response = await availabilityPreviewGet(apiRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
