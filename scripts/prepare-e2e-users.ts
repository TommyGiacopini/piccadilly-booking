import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword, passwordSchema } from "../src/server/auth/password-core";
import { resolveDatabaseUrl } from "../src/server/db/database-config";
import { resolveAppEnvironment } from "../src/shared/config/app-environment";

const E2E_RESTAURANT_ID = "00000000-0000-4000-8000-000000000001";
const E2E_ADMIN_ID = "00000000-0000-4000-8000-000000000901";
const E2E_STAFF_ID = "00000000-0000-4000-8000-000000000902";

async function main(): Promise<void> {
  if (resolveAppEnvironment(process.env.APP_ENV) === "production") {
    throw new Error("E2E users cannot be prepared in production.");
  }

  const adminPassword = passwordSchema.parse(
    process.env.AUTH_DEMO_ADMIN_PASSWORD,
  );
  const staffPassword = passwordSchema.parse(
    process.env.AUTH_DEMO_STAFF_PASSWORD,
  );
  const [adminPasswordHash, staffPasswordHash] = await Promise.all([
    hashPassword(adminPassword),
    hashPassword(staffPassword),
  ]);
  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
      connectionTimeoutMillis: 5_000,
    }),
  });

  try {
    await client.$transaction(async (transaction) => {
      await transaction.user.upsert({
        where: {
          restaurantId_username: {
            restaurantId: E2E_RESTAURANT_ID,
            username: "e2e.admin",
          },
        },
        update: {
          passwordHash: adminPasswordHash,
          role: "ADMIN",
          isActive: true,
          disabledAt: null,
          mustChangePassword: false,
        },
        create: {
          id: E2E_ADMIN_ID,
          restaurantId: E2E_RESTAURANT_ID,
          username: "e2e.admin",
          passwordHash: adminPasswordHash,
          role: "ADMIN",
          mustChangePassword: false,
        },
      });
      await transaction.user.upsert({
        where: {
          restaurantId_username: {
            restaurantId: E2E_RESTAURANT_ID,
            username: "e2e.staff",
          },
        },
        update: {
          passwordHash: staffPasswordHash,
          role: "STAFF",
          isActive: true,
          disabledAt: null,
          mustChangePassword: false,
        },
        create: {
          id: E2E_STAFF_ID,
          restaurantId: E2E_RESTAURANT_ID,
          username: "e2e.staff",
          passwordHash: staffPasswordHash,
          role: "STAFF",
          mustChangePassword: false,
        },
      });
      await transaction.session.updateMany({
        where: {
          userId: { in: [E2E_ADMIN_ID, E2E_STAFF_ID] },
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    });

    console.info("Dedicated fake E2E users prepared.");
  } finally {
    await client.$disconnect();
  }
}

main().catch(() => {
  console.error("Dedicated fake E2E user preparation failed.");
  process.exit(1);
});
