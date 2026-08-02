import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { pathToFileURL } from "node:url";

import { PrismaClient } from "../src/generated/prisma/client";
import { resolveDatabaseUrl } from "../src/server/db/database-config";

export const DEMO_RESTAURANT_ID = "00000000-0000-4000-8000-000000000001";

type SeedClient = Pick<PrismaClient, "restaurant">;

export async function seedDemoRestaurant(client: SeedClient) {
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

async function main(): Promise<void> {
  const adapter = new PrismaPg({
    connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
    connectionTimeoutMillis: 5_000,
  });
  const client = new PrismaClient({ adapter, log: ["error"] });

  try {
    await seedDemoRestaurant(client);
    console.info("Demo restaurant seed completed.");
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
