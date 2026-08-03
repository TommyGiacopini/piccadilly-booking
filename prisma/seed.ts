import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { pathToFileURL } from "node:url";

import {
  DayOfWeek,
  Prisma,
  PrismaClient,
  ServiceType,
  UserRole,
} from "../src/generated/prisma/client";
import {
  DAY_OF_WEEK_VALUES,
  DEFAULT_BOOKING_CUTOFFS,
  DEFAULT_ROLLING_CAPACITY_COVERS,
  DEFAULT_SERVICE_TIMES,
  DEFAULT_SLOT_INTERVAL_MINUTES,
  DEMO_ROOMS,
  FIXED_ROLLING_WINDOW_MINUTES,
  RESTAURANT_TIMEZONE,
  SERVICE_TYPE_VALUES,
} from "../src/modules/configuration/domain/defaults";
import { operationalTimeToDatabase } from "../src/modules/configuration/domain/operational-time";
import {
  hashPassword,
  normalizeUsername,
  passwordSchema,
} from "../src/server/auth/password-core";
import { resolveDatabaseUrl } from "../src/server/db/database-config";
import { resolveAppEnvironment } from "../src/shared/config/app-environment";

export const DEMO_RESTAURANT_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_ADMIN_ID = "00000000-0000-4000-8000-000000000101";
export const DEMO_STAFF_ID = "00000000-0000-4000-8000-000000000102";
export const DEMO_ADMIN_USERNAME = "demo.admin";
export const DEMO_STAFF_USERNAME = "demo.staff";

type RestaurantSeedClient = Pick<PrismaClient, "restaurant">;
type AuthenticationSeedClient = Pick<PrismaClient, "user">;
type OperationalConfigurationSeedClient = Pick<
  PrismaClient,
  "restaurantBookingSettings" | "room" | "weeklyServiceSchedule" | "diningTable"
>;
type SeedClient = RestaurantSeedClient &
  AuthenticationSeedClient &
  OperationalConfigurationSeedClient;

export interface DemoUserPasswords {
  admin: string;
  staff: string;
}

export async function seedDemoRestaurant(client: RestaurantSeedClient) {
  return client.restaurant.upsert({
    where: { id: DEMO_RESTAURANT_ID },
    update: {
      name: "Piccadilly Demo",
      timezone: RESTAURANT_TIMEZONE,
    },
    create: {
      id: DEMO_RESTAURANT_ID,
      name: "Piccadilly Demo",
      timezone: RESTAURANT_TIMEZONE,
    },
  });
}

const DEMO_TABLES = [
  { roomCode: "sala-1", name: "DEMO-S1-01", minimumSeats: 2, maximumSeats: 4 },
  { roomCode: "sala-2", name: "DEMO-S2-01", minimumSeats: 2, maximumSeats: 6 },
  { roomCode: "sala-3", name: "DEMO-S3-01", minimumSeats: 2, maximumSeats: 6 },
  { roomCode: "galleria", name: "DEMO-G-01", minimumSeats: 2, maximumSeats: 4 },
  { roomCode: "terrazzo", name: "DEMO-T-01", minimumSeats: 2, maximumSeats: 4 },
] as const;

export async function seedDemoOperationalConfiguration(
  client: OperationalConfigurationSeedClient,
) {
  const settings = await client.restaurantBookingSettings.upsert({
    where: { restaurantId: DEMO_RESTAURANT_ID },
    update: {
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
    },
    create: {
      restaurantId: DEMO_RESTAURANT_ID,
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
    },
  });

  const rooms = [];

  for (const roomSeed of DEMO_ROOMS) {
    let room: { id: string; code: string };

    try {
      room = await client.room.upsert({
        where: {
          restaurantId_code: {
            restaurantId: DEMO_RESTAURANT_ID,
            code: roomSeed.code,
          },
        },
        update: {
          name: roomSeed.name,
          displayOrder: roomSeed.displayOrder,
          isActive: true,
        },
        create: {
          restaurantId: DEMO_RESTAURANT_ID,
          ...roomSeed,
        },
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }

      const existingRoom = await client.room.findFirst({
        where: {
          restaurantId: DEMO_RESTAURANT_ID,
          OR: [{ code: roomSeed.code }, { name: roomSeed.name }],
        },
      });

      if (!existingRoom) {
        throw error;
      }

      room = await client.room.update({
        where: { id: existingRoom.id },
        data: {
          name: roomSeed.name,
          code: roomSeed.code,
          displayOrder: roomSeed.displayOrder,
          isActive: true,
        },
      });
    }

    rooms.push(room);
  }

  const roomByCode = new Map(rooms.map((room) => [room.code, room]));
  const diningTables = [];

  for (const [index, tableSeed] of DEMO_TABLES.entries()) {
    const room = roomByCode.get(tableSeed.roomCode);

    if (!room) {
      throw new Error("Demo room configuration is incomplete.");
    }

    diningTables.push(
      await client.diningTable.upsert({
        where: {
          roomId_name: {
            roomId: room.id,
            name: tableSeed.name,
          },
        },
        update: {
          minimumSeats: tableSeed.minimumSeats,
          maximumSeats: tableSeed.maximumSeats,
          displayOrder: index + 1,
          isActive: true,
        },
        create: {
          roomId: room.id,
          name: tableSeed.name,
          minimumSeats: tableSeed.minimumSeats,
          maximumSeats: tableSeed.maximumSeats,
          displayOrder: index + 1,
        },
      }),
    );
  }

  const weeklySchedules = [];

  for (const dayOfWeekValue of DAY_OF_WEEK_VALUES) {
    for (const serviceTypeValue of SERVICE_TYPE_VALUES) {
      const serviceType = ServiceType[serviceTypeValue];
      const serviceTimes = DEFAULT_SERVICE_TIMES[serviceTypeValue];

      weeklySchedules.push(
        await client.weeklyServiceSchedule.upsert({
          where: {
            restaurantId_dayOfWeek_serviceType: {
              restaurantId: DEMO_RESTAURANT_ID,
              dayOfWeek: DayOfWeek[dayOfWeekValue],
              serviceType,
            },
          },
          update: {
            isEnabled: true,
            startTime: operationalTimeToDatabase(serviceTimes.startTime),
            endTime: operationalTimeToDatabase(serviceTimes.endTime),
            slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
          },
          create: {
            restaurantId: DEMO_RESTAURANT_ID,
            dayOfWeek: DayOfWeek[dayOfWeekValue],
            serviceType,
            isEnabled: true,
            startTime: operationalTimeToDatabase(serviceTimes.startTime),
            endTime: operationalTimeToDatabase(serviceTimes.endTime),
            slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
          },
        }),
      );
    }
  }

  return { settings, rooms, diningTables, weeklySchedules };
}

export function resolveDemoUserPasswords(
  environment: Record<string, string | undefined> = process.env,
): DemoUserPasswords {
  if (resolveAppEnvironment(environment.APP_ENV) === "production") {
    throw new Error("Demo users cannot be seeded in production.");
  }

  return {
    admin: passwordSchema.parse(environment.AUTH_DEMO_ADMIN_PASSWORD),
    staff: passwordSchema.parse(environment.AUTH_DEMO_STAFF_PASSWORD),
  };
}

export async function seedDemoUsers(
  client: AuthenticationSeedClient,
  passwords: DemoUserPasswords,
) {
  const [adminPasswordHash, staffPasswordHash] = await Promise.all([
    hashPassword(passwords.admin),
    hashPassword(passwords.staff),
  ]);

  const admin = await client.user.upsert({
    where: {
      restaurantId_username: {
        restaurantId: DEMO_RESTAURANT_ID,
        username: normalizeUsername(DEMO_ADMIN_USERNAME),
      },
    },
    update: {
      passwordHash: adminPasswordHash,
      role: UserRole.ADMIN,
      isActive: true,
      disabledAt: null,
    },
    create: {
      id: DEMO_ADMIN_ID,
      restaurantId: DEMO_RESTAURANT_ID,
      username: normalizeUsername(DEMO_ADMIN_USERNAME),
      passwordHash: adminPasswordHash,
      role: UserRole.ADMIN,
    },
  });
  const staff = await client.user.upsert({
    where: {
      restaurantId_username: {
        restaurantId: DEMO_RESTAURANT_ID,
        username: normalizeUsername(DEMO_STAFF_USERNAME),
      },
    },
    update: {
      passwordHash: staffPasswordHash,
      role: UserRole.STAFF,
      isActive: true,
      disabledAt: null,
    },
    create: {
      id: DEMO_STAFF_ID,
      restaurantId: DEMO_RESTAURANT_ID,
      username: normalizeUsername(DEMO_STAFF_USERNAME),
      passwordHash: staffPasswordHash,
      role: UserRole.STAFF,
    },
  });

  return { admin, staff };
}

export async function seedDemoData(
  client: SeedClient,
  passwords: DemoUserPasswords,
) {
  const restaurant = await seedDemoRestaurant(client);
  const users = await seedDemoUsers(client, passwords);
  const configuration = await seedDemoOperationalConfiguration(client);

  return { restaurant, ...users, ...configuration };
}

async function main(): Promise<void> {
  const adapter = new PrismaPg({
    connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
    connectionTimeoutMillis: 5_000,
  });
  const client = new PrismaClient({ adapter, log: ["error"] });

  try {
    await seedDemoData(client, resolveDemoUserPasswords());
    console.info("Demo restaurant, users and operational configuration seed completed.");
  } finally {
    await client.$disconnect();
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entryPoint === import.meta.url) {
  main().catch(() => {
    console.error("Demo restaurant seed failed.");
    process.exit(1);
  });
}
