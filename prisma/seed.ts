import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { pathToFileURL } from "node:url";

import { PrismaClient, UserRole } from "../src/generated/prisma/client";
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
type SeedClient = RestaurantSeedClient & AuthenticationSeedClient;

export interface DemoUserPasswords {
  admin: string;
  staff: string;
}

export async function seedDemoRestaurant(client: RestaurantSeedClient) {
  return client.restaurant.upsert({
    where: { id: DEMO_RESTAURANT_ID },
    update: {
      name: "Piccadilly Demo",
      timezone: "Europe/Rome",
    },
    create: {
      id: DEMO_RESTAURANT_ID,
      name: "Piccadilly Demo",
      timezone: "Europe/Rome",
    },
  });
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

  return { restaurant, ...users };
}

async function main(): Promise<void> {
  const adapter = new PrismaPg({
    connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
    connectionTimeoutMillis: 5_000,
  });
  const client = new PrismaClient({ adapter, log: ["error"] });

  try {
    await seedDemoData(client, resolveDemoUserPasswords());
    console.info("Demo restaurant and users seed completed.");
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
