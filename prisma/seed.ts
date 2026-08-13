import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { pathToFileURL } from "node:url";

import {
  DayOfWeek,
  PrismaClient,
  PublicContentKey,
  PublicContentLocale,
  ServiceType,
  UserRole,
} from "../src/generated/prisma/client";
import {
  DAY_OF_WEEK_VALUES,
  DEFAULT_BOOKING_CUTOFFS,
  DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
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
  | "restaurantBookingSettings"
  | "bookingCutoffRule"
  | "room"
  | "weeklyServiceSchedule"
  | "diningTable"
>;
type PublicConfigurationSeedClient = Pick<
  PrismaClient,
  "restaurantPublicSettings" | "publicContent"
>;
type SeedClient = RestaurantSeedClient &
  AuthenticationSeedClient &
  OperationalConfigurationSeedClient &
  PublicConfigurationSeedClient;

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

export const DEMO_PUBLIC_CONTACTS = {
  publicPhone: "+390000000000",
  publicBookingBaseUrl: "https://prenota.example.test/",
  publicEmail: "demo@example.test",
  whatsappNumber: "+390000000001",
} as const;

export const DEMO_PUBLIC_CONTENTS = {
  IT: {
    BOOKING_PAGE_TITLE: "Prenotazione dimostrativa Piccadilly",
    BOOKING_PAGE_INTRO:
      "Contenuto dimostrativo: scegli data, servizio e orario disponibili.",
    UNAVAILABLE_MESSAGE:
      "Nessuna disponibilità dimostrativa per la selezione corrente.",
    CONTACT_PROMPT:
      "Per assistenza sulla dimostrazione puoi usare uno dei contatti indicati.",
    CONFIRMATION_MESSAGE:
      "La prenotazione dimostrativa è stata registrata correttamente.",
    MANAGEMENT_PAGE_TITLE: "Gestisci la prenotazione dimostrativa",
    MANAGEMENT_PAGE_INTRO:
      "Consulta, modifica o annulla la prenotazione entro i termini disponibili.",
  },
  EN: {
    BOOKING_PAGE_TITLE: "Piccadilly demonstration booking",
    BOOKING_PAGE_INTRO:
      "Demonstration content: choose an available date, service and time.",
    UNAVAILABLE_MESSAGE:
      "No demonstration availability exists for the current selection.",
    CONTACT_PROMPT:
      "For help with this demonstration, use one of the listed contacts.",
    CONFIRMATION_MESSAGE:
      "The demonstration booking has been recorded successfully.",
    MANAGEMENT_PAGE_TITLE: "Manage the demonstration booking",
    MANAGEMENT_PAGE_INTRO:
      "View, change or cancel the booking within the available time limits.",
  },
} as const;

export async function seedDemoPublicConfiguration(
  client: PublicConfigurationSeedClient,
) {
  await client.restaurantPublicSettings.createMany({
    data: [{ restaurantId: DEMO_RESTAURANT_ID, ...DEMO_PUBLIC_CONTACTS }],
    skipDuplicates: true,
  });

  await client.publicContent.createMany({
    data: Object.entries(DEMO_PUBLIC_CONTENTS).flatMap(
      ([locale, contents]) =>
        Object.entries(contents).map(([contentKey, contentText]) => ({
          restaurantId: DEMO_RESTAURANT_ID,
          locale: locale as PublicContentLocale,
          contentKey: contentKey as PublicContentKey,
          contentText,
        })),
    ),
    skipDuplicates: true,
  });

  return {
    publicSettings: await client.restaurantPublicSettings.findUnique({
      where: { restaurantId: DEMO_RESTAURANT_ID },
    }),
    publicContents: await client.publicContent.findMany({
      where: { restaurantId: DEMO_RESTAURANT_ID },
      orderBy: [{ locale: "asc" }, { contentKey: "asc" }],
    }),
  };
}

export async function seedDemoOperationalConfiguration(
  client: OperationalConfigurationSeedClient,
) {
  const settings = await client.restaurantBookingSettings.upsert({
    where: { restaurantId: DEMO_RESTAURANT_ID },
    update: {},
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
      managementLinkDurationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
    },
  });

  await client.bookingCutoffRule.createMany({
    data: DAY_OF_WEEK_VALUES.flatMap((dayOfWeekValue) =>
      SERVICE_TYPE_VALUES.map((serviceTypeValue) => ({
        restaurantId: DEMO_RESTAURANT_ID,
        dayOfWeek: DayOfWeek[dayOfWeekValue],
        serviceType: ServiceType[serviceTypeValue],
        isEnabled:
          serviceTypeValue === "DINNER" &&
          (dayOfWeekValue === "FRIDAY" || dayOfWeekValue === "SATURDAY"),
        cutoffTime: operationalTimeToDatabase(
          DEFAULT_BOOKING_CUTOFFS.publicBookingCutoffTime,
        ),
      })),
    ),
    skipDuplicates: true,
  });

  const rooms = [];

  for (const roomSeed of DEMO_ROOMS) {
    const room = await client.room.upsert({
        where: {
          restaurantId_code: {
            restaurantId: DEMO_RESTAURANT_ID,
            code: roomSeed.code,
          },
        },
        update: {},
        create: {
          restaurantId: DEMO_RESTAURANT_ID,
          ...roomSeed,
        },
      });

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
        update: {},
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
          update: {},
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

  const bookingCutoffRules = await client.bookingCutoffRule.findMany({
    where: { restaurantId: DEMO_RESTAURANT_ID },
    orderBy: [{ dayOfWeek: "asc" }, { serviceType: "asc" }],
  });

  return { settings, rooms, diningTables, weeklySchedules, bookingCutoffRules };
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
    update: {},
    create: {
      id: DEMO_ADMIN_ID,
      restaurantId: DEMO_RESTAURANT_ID,
      username: normalizeUsername(DEMO_ADMIN_USERNAME),
      passwordHash: adminPasswordHash,
      role: UserRole.ADMIN,
      mustChangePassword: false,
    },
  });
  const staff = await client.user.upsert({
    where: {
      restaurantId_username: {
        restaurantId: DEMO_RESTAURANT_ID,
        username: normalizeUsername(DEMO_STAFF_USERNAME),
      },
    },
    update: {},
    create: {
      id: DEMO_STAFF_ID,
      restaurantId: DEMO_RESTAURANT_ID,
      username: normalizeUsername(DEMO_STAFF_USERNAME),
      passwordHash: staffPasswordHash,
      role: UserRole.STAFF,
      mustChangePassword: false,
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
  const publicConfiguration = await seedDemoPublicConfiguration(client);

  return { restaurant, ...users, ...configuration, ...publicConfiguration };
}

async function main(): Promise<void> {
  const adapter = new PrismaPg({
    connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
    connectionTimeoutMillis: 5_000,
  });
  const client = new PrismaClient({ adapter, log: ["error"] });

  try {
    await seedDemoData(client, resolveDemoUserPasswords());
    console.info("Demo restaurant seed completed.");
  } finally {
    await client.$disconnect();
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entryPoint === import.meta.url) {
  main().catch((error: unknown) => {
    const detail =
      error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
    console.error(`Demo restaurant seed failed: ${detail}`);
    process.exit(1);
  });
}
