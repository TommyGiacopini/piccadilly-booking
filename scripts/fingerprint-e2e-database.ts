import "dotenv/config";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { resolveDatabaseUrl } from "../src/server/db/database-config";
import { resolveAppEnvironment } from "../src/shared/config/app-environment";
import { fingerprintDatabaseOutsideRun } from "./cleanup-e2e-reservations";
import { e2eRestaurantId, parseE2eRunId } from "./e2e-fixture-ownership";

export async function e2eDatabaseEvidence(
  client: PrismaClient,
  runIdInput: string,
) {
  const runId = parseE2eRunId(runIdInput);
  const restaurantId = e2eRestaurantId(runId);
  const fingerprint = await fingerprintDatabaseOutsideRun(client, runId);
  const historical = await client.$queryRaw<Array<{ count: string }>>`
    SELECT (
      (SELECT count(*) FROM reservations
       WHERE restaurant_id <> ${restaurantId}::uuid
         AND customer_first_name LIKE 'E2E-%')
      + (SELECT count(*) FROM users
         WHERE restaurant_id <> ${restaurantId}::uuid
           AND username LIKE 'e2e.%')
      + (SELECT count(*) FROM dining_tables dt
         JOIN rooms r ON r.id = dt.room_id
         WHERE r.restaurant_id <> ${restaurantId}::uuid
           AND dt.name LIKE 'E2E-%')
    )::text AS count
  `;
  const runRows = await client.restaurant.count({ where: { id: restaurantId } });
  return {
    runId,
    restaurantId,
    nonRunFingerprint: fingerprint.fingerprint,
    tables: fingerprint.tables,
    historicalFixtureRows: Number(historical[0]?.count ?? "0"),
    runTenantRows: runRows,
  };
}

async function main(): Promise<void> {
  if (resolveAppEnvironment(process.env.APP_ENV) === "production") {
    throw new Error("E2E fingerprint cannot run in production.");
  }
  if (process.env.E2E_TEST_MODE !== "true") {
    throw new Error("E2E_TEST_MODE=true is required for E2E fingerprinting.");
  }
  const runId = parseE2eRunId(process.env.E2E_RUN_ID);
  if (process.env.AUTH_RESTAURANT_ID !== e2eRestaurantId(runId)) {
    throw new Error("E2E fingerprint tenant does not match the explicit run ID.");
  }
  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
      connectionTimeoutMillis: 5_000,
    }),
  });
  try {
    console.info(JSON.stringify(await e2eDatabaseEvidence(client, runId)));
  } finally {
    await client.$disconnect();
  }
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (executedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "E2E fingerprint failed.");
    process.exit(1);
  });
}
