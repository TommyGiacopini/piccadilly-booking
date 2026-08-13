import "dotenv/config";

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { passwordSchema } from "../src/server/auth/password-core";
import { resolveDatabaseUrl } from "../src/server/db/database-config";
import { resolveAppEnvironment } from "../src/shared/config/app-environment";

const E2E_RESTAURANT_ID = "00000000-0000-4000-8000-000000000001";
const E2E_ORIGIN = "http://localhost:4000";
const E2E_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CleanupClient = Pick<PrismaClient, "restaurant" | "reservation">;
type CleanupFixture = { id: string; version: number };

export function parseE2eRunId(value: string | undefined): string {
  const runId = value?.trim();
  if (!runId || !E2E_RUN_ID_PATTERN.test(runId)) {
    throw new Error("E2E_RUN_ID must be a valid UUID.");
  }
  return runId.toLowerCase();
}

export function e2eReservationFirstName(runId: string): string {
  return `E2E-${parseE2eRunId(runId)}`;
}

export async function cleanupE2eReservations(
  client: CleanupClient,
  runId: string,
  cancelReservation: (fixture: CleanupFixture) => Promise<void>,
): Promise<number> {
  const restaurant = await client.restaurant.findUnique({
    where: { id: E2E_RESTAURANT_ID },
    select: { id: true },
  });
  if (!restaurant) {
    throw new Error("The explicit fake E2E restaurant is not available.");
  }

  const fixtures = await client.reservation.findMany({
    where: {
      restaurantId: restaurant.id,
      customerFirstName: e2eReservationFirstName(runId),
      status: "CONFIRMED",
    },
    select: { id: true, version: true },
  });

  for (const fixture of fixtures) {
    await cancelReservation(fixture);
  }
  return fixtures.length;
}

async function login(): Promise<string> {
  const password = passwordSchema.parse(process.env.AUTH_DEMO_ADMIN_PASSWORD);
  const response = await fetch(`${E2E_ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: E2E_ORIGIN,
    },
    body: new URLSearchParams({
      username: "e2e.admin",
      password,
      returnTo: "/dashboard",
    }),
    redirect: "manual",
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (response.status !== 303 || !cookie) {
    throw new Error("E2E cleanup login failed.");
  }
  return cookie;
}

async function main(): Promise<void> {
  if (resolveAppEnvironment(process.env.APP_ENV) === "production") {
    throw new Error("E2E reservations cannot be cleaned in production.");
  }

  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
      connectionTimeoutMillis: 5_000,
    }),
  });
  const runId = parseE2eRunId(process.env.E2E_RUN_ID);

  try {
    let cookie: string | null = null;
    const cleaned = await cleanupE2eReservations(
      client,
      runId,
      async (fixture) => {
        cookie ??= await login();
      const response = await fetch(
        `${E2E_ORIGIN}/api/staff/reservations/${fixture.id}`,
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: E2E_ORIGIN,
          },
          body: JSON.stringify({ version: fixture.version }),
        },
      );
      if (!response.ok) {
        throw new Error(`E2E reservation cleanup failed with ${response.status}.`);
      }
      },
    );

    console.info(
      cleaned === 0
        ? "No active reservations for this E2E run required cleanup."
        : `${cleaned} reservations for this E2E run logically cancelled.`,
    );
  } finally {
    await client.$disconnect();
  }
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (executedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "E2E cleanup failed.");
    process.exit(1);
  });
}
