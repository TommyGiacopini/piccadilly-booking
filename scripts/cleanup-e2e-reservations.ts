import "dotenv/config";

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { resolveDatabaseUrl } from "../src/server/db/database-config";
import { resolveAppEnvironment } from "../src/shared/config/app-environment";
import {
  E2E_TEMPLATE_RESTAURANT_ID,
  e2eAuthRateLimitSecret,
  e2eDiningTableName,
  e2eLoginRateLimitHashes,
  e2eOwnedUsernames,
  e2ePublicRateLimitSecret,
  e2ePurgeOptIn,
  e2eReservationFirstName,
  e2eRestaurantId,
  e2eRestaurantName,
  parseE2eRunId,
} from "./e2e-fixture-ownership";

type CleanupTransaction = Prisma.TransactionClient;
type CleanupStep =
  | "login-rate-limits"
  | "assignment-tables"
  | "assignments"
  | "reservation-audits"
  | "administrative-audits"
  | "management-tokens"
  | "idempotency"
  | "reservations"
  | "public-rate-limits"
  | "sessions"
  | "service-room-availability"
  | "service-instances"
  | "dining-tables"
  | "rooms"
  | "special-dates"
  | "cutoff-rules"
  | "weekly-schedules"
  | "public-content"
  | "public-settings"
  | "booking-settings"
  | "users"
  | "restaurant";

export interface E2ePurgeResult {
  runId: string;
  restaurantId: string;
  alreadyAbsent: boolean;
  deleted: Record<CleanupStep, number>;
  nonRunFingerprint: string;
  runRowsAfter: number;
}

interface PurgeOptions {
  afterStep?: (step: CleanupStep) => Promise<void> | void;
}

interface E2ePurgeContext {
  runId: string;
  restaurantId: string;
  loginRateLimitHashes: string[];
}

const TABLE_FINGERPRINTS = [
  ["restaurants", "id <> $1::uuid"],
  ["restaurant_public_settings", "restaurant_id <> $1::uuid"],
  ["public_contents", "restaurant_id <> $1::uuid"],
  ["rooms", "restaurant_id <> $1::uuid"],
  ["service_instances", "restaurant_id <> $1::uuid"],
  ["service_room_availability", "restaurant_id <> $1::uuid"],
  [
    "dining_tables",
    "NOT EXISTS (SELECT 1 FROM rooms r WHERE r.id = t.room_id AND r.restaurant_id = $1::uuid)",
  ],
  ["weekly_service_schedules", "restaurant_id <> $1::uuid"],
  ["restaurant_booking_settings", "restaurant_id <> $1::uuid"],
  ["booking_cutoff_rules", "restaurant_id <> $1::uuid"],
  ["special_date_overrides", "restaurant_id <> $1::uuid"],
  ["users", "restaurant_id <> $1::uuid"],
  [
    "sessions",
    "NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id AND u.restaurant_id = $1::uuid)",
  ],
  ["login_rate_limits", "NOT (key_hash = ANY($1::text[]))"],
  ["reservations", "restaurant_id <> $1::uuid"],
  ["reservation_assignments", "restaurant_id <> $1::uuid"],
  ["reservation_assignment_tables", "restaurant_id <> $1::uuid"],
  ["reservation_idempotency_keys", "restaurant_id <> $1::uuid"],
  [
    "reservation_management_tokens",
    "NOT EXISTS (SELECT 1 FROM reservations r WHERE r.id = t.reservation_id AND r.restaurant_id = $1::uuid)",
  ],
  ["public_reservation_rate_limits", "restaurant_id <> $1::uuid"],
  ["reservation_audit_events", "restaurant_id <> $1::uuid"],
  ["audit_events", "restaurant_id <> $1::uuid"],
] as const;

function emptyDeletedCounts(): Record<CleanupStep, number> {
  return {
    "login-rate-limits": 0,
    "assignment-tables": 0,
    assignments: 0,
    "reservation-audits": 0,
    "administrative-audits": 0,
    "management-tokens": 0,
    idempotency: 0,
    reservations: 0,
    "public-rate-limits": 0,
    sessions: 0,
    "service-room-availability": 0,
    "service-instances": 0,
    "dining-tables": 0,
    rooms: 0,
    "special-dates": 0,
    "cutoff-rules": 0,
    "weekly-schedules": 0,
    "public-content": 0,
    "public-settings": 0,
    "booking-settings": 0,
    users: 0,
    restaurant: 0,
  };
}

export function assertE2ePurgeEnvironment(
  environment: Record<string, string | undefined>,
): E2ePurgeContext {
  const runId = parseE2eRunId(environment.E2E_RUN_ID);
  if (resolveAppEnvironment(environment.APP_ENV) === "production") {
    throw new Error("E2E fixture purge is forbidden in production.");
  }
  if (environment.E2E_TEST_MODE !== "true") {
    throw new Error("E2E fixture purge requires E2E_TEST_MODE=true.");
  }
  if (environment.E2E_PURGE_OPT_IN !== e2ePurgeOptIn(runId)) {
    throw new Error("E2E fixture purge requires the explicit run-scoped opt-in.");
  }
  if (environment.AUTH_RESTAURANT_ID !== e2eRestaurantId(runId)) {
    throw new Error("E2E fixture purge tenant does not match the explicit run ID.");
  }
  if (
    environment.PUBLIC_BOOKING_RATE_LIMIT_SECRET !==
    e2ePublicRateLimitSecret(runId)
  ) {
    throw new Error("The E2E public rate-limit secret is not scoped to this run.");
  }
  if (environment.AUTH_RATE_LIMIT_SECRET !== e2eAuthRateLimitSecret(runId)) {
    throw new Error("The E2E authentication rate-limit secret is not scoped to this run.");
  }
  if (environment.AUTH_TRUST_PROXY !== "false") {
    throw new Error("E2E fixture purge requires the allow-listed direct client address.");
  }
  return {
    runId,
    restaurantId: e2eRestaurantId(runId),
    loginRateLimitHashes: e2eLoginRateLimitHashes(runId),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function fingerprintDatabaseOutsideRunWithOwnership(
  client: CleanupTransaction | PrismaClient,
  runIdInput: string,
  excludedLoginRateLimitHashes: string[],
): Promise<{ fingerprint: string; tables: Record<string, { count: number; sha256: string }> }> {
  const restaurantId = e2eRestaurantId(runIdInput);
  const tables: Record<string, { count: number; sha256: string }> = {};

  for (const [table, where] of TABLE_FINGERPRINTS) {
    const parameters =
      table === "login_rate_limits"
        ? [excludedLoginRateLimitHashes]
        : [restaurantId];
    const rows = await client.$queryRawUnsafe<Array<{ value: string }>>(
      `SELECT to_jsonb(t)::text AS value FROM ${table} t WHERE ${where} ORDER BY to_jsonb(t)::text`,
      ...parameters,
    );
    const serialized = rows.map((row) => row.value).join("\n");
    tables[table] = { count: rows.length, sha256: sha256(serialized) };
  }

  return { fingerprint: sha256(JSON.stringify(tables)), tables };
}

export async function fingerprintDatabaseOutsideRun(
  client: CleanupTransaction | PrismaClient,
  runIdInput: string,
): Promise<{ fingerprint: string; tables: Record<string, { count: number; sha256: string }> }> {
  const runId = parseE2eRunId(runIdInput);
  return fingerprintDatabaseOutsideRunWithOwnership(
    client,
    runId,
    e2eLoginRateLimitHashes(runId),
  );
}

async function assertExclusiveRunOwnership(
  transaction: CleanupTransaction,
  runId: string,
): Promise<void> {
  const restaurantId = e2eRestaurantId(runId);
  const restaurant = await transaction.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true },
  });
  if (!restaurant) return;
  if (restaurant.name !== e2eRestaurantName(runId)) {
    throw new Error("The run UUID belongs to a restaurant without the exact E2E ownership marker.");
  }

  const users = await transaction.user.findMany({
    where: { restaurantId },
    select: { username: true },
  });
  const reservations = await transaction.reservation.findMany({
    where: { restaurantId },
    select: { customerFirstName: true },
  });
  const rooms = await transaction.room.findMany({
    where: { restaurantId },
    select: { code: true, diningTables: { select: { name: true } } },
  });
  const templateRooms = await transaction.room.findMany({
    where: { restaurantId: E2E_TEMPLATE_RESTAURANT_ID },
    select: { code: true, diningTables: { select: { name: true } } },
  });
  const allowedUsers = new Set(e2eOwnedUsernames(runId));
  if (users.some((user) => !allowedUsers.has(user.username))) {
    throw new Error("The run tenant contains a user without an exact run ownership marker.");
  }
  const reservationMarker = e2eReservationFirstName(runId);
  if (
    reservations.some(
      (reservation) => reservation.customerFirstName !== reservationMarker,
    )
  ) {
    throw new Error("The run tenant contains a reservation without an exact run ownership marker.");
  }
  const allowedTables = new Map(
    templateRooms.map((room) => [
      room.code,
      new Set(room.diningTables.map((table) => table.name)),
    ]),
  );
  const expectedRoomCodes = new Set(templateRooms.map((room) => room.code));
  const runTableName = e2eDiningTableName(runId);
  if (
    rooms.some(
      (room) =>
        !expectedRoomCodes.has(room.code) ||
        room.diningTables.some(
          (table) =>
            table.name !== runTableName &&
            !allowedTables.get(room.code)?.has(table.name),
        ),
    )
  ) {
    throw new Error("The run tenant contains a room or table without proven run ownership.");
  }

  const crossTenantReferences = [
    await transaction.reservation.count({
      where: { createdByUser: { restaurantId }, restaurantId: { not: restaurantId } },
    }),
    await transaction.reservationAuditEvent.count({
      where: { actorUser: { restaurantId }, restaurantId: { not: restaurantId } },
    }),
    await transaction.auditEvent.count({
      where: { actorUser: { restaurantId }, restaurantId: { not: restaurantId } },
    }),
  ];
  if (crossTenantReferences.some((count) => count !== 0)) {
    throw new Error("Run-owned users are referenced by rows outside the run tenant.");
  }

}

async function countRunRows(
  transaction: CleanupTransaction,
  runId: string,
  loginHashes: string[],
): Promise<number> {
  const restaurantId = e2eRestaurantId(runId);
  const counts = [
    await transaction.restaurant.count({ where: { id: restaurantId } }),
    await transaction.user.count({ where: { restaurantId } }),
    await transaction.reservation.count({ where: { restaurantId } }),
    await transaction.reservationAssignment.count({ where: { restaurantId } }),
    await transaction.reservationAssignmentTable.count({ where: { restaurantId } }),
    await transaction.reservationAuditEvent.count({ where: { restaurantId } }),
    await transaction.auditEvent.count({ where: { restaurantId } }),
    await transaction.publicReservationRateLimit.count({ where: { restaurantId } }),
    loginHashes.length === 0
      ? 0
      : await transaction.loginRateLimit.count({
          where: { keyHash: { in: loginHashes } },
        }),
  ];
  return counts.reduce((sum, count) => sum + count, 0);
}

export async function purgeE2eRun(
  client: PrismaClient,
  environment: Record<string, string | undefined>,
  options: PurgeOptions = {},
): Promise<E2ePurgeResult> {
  const context = assertE2ePurgeEnvironment(environment);
  const { runId, restaurantId, loginRateLimitHashes } = context;

  return client.$transaction(
    async (transaction) => {
      await assertExclusiveRunOwnership(transaction, runId);
      const before = await fingerprintDatabaseOutsideRunWithOwnership(
        transaction,
        runId,
        loginRateLimitHashes,
      );
      const exists = await transaction.restaurant.count({
        where: { id: restaurantId },
      });
      const deleted = emptyDeletedCounts();
      if (exists === 0) {
        return {
          runId,
          restaurantId,
          alreadyAbsent: true,
          deleted,
          nonRunFingerprint: before.fingerprint,
          runRowsAfter: 0,
        };
      }

      async function remove(
        step: CleanupStep,
        operation: () => Promise<{ count: number }>,
      ) {
        deleted[step] = (await operation()).count;
        await options.afterStep?.(step);
      }

      await remove("login-rate-limits", () =>
        loginRateLimitHashes.length === 0
          ? Promise.resolve({ count: 0 })
          : transaction.loginRateLimit.deleteMany({
              where: { keyHash: { in: loginRateLimitHashes } },
            }),
      );
      await remove("assignment-tables", () =>
        transaction.reservationAssignmentTable.deleteMany({ where: { restaurantId } }),
      );
      await remove("assignments", () =>
        transaction.reservationAssignment.deleteMany({ where: { restaurantId } }),
      );
      await remove("reservation-audits", () =>
        transaction.reservationAuditEvent.deleteMany({ where: { restaurantId } }),
      );
      await remove("administrative-audits", () =>
        transaction.auditEvent.deleteMany({ where: { restaurantId } }),
      );
      await remove("management-tokens", () =>
        transaction.reservationManagementToken.deleteMany({
          where: { reservation: { restaurantId } },
        }),
      );
      await remove("idempotency", () =>
        transaction.reservationIdempotencyKey.deleteMany({ where: { restaurantId } }),
      );
      await remove("reservations", () =>
        transaction.reservation.deleteMany({ where: { restaurantId } }),
      );
      await remove("public-rate-limits", () =>
        transaction.publicReservationRateLimit.deleteMany({ where: { restaurantId } }),
      );
      await remove("sessions", () =>
        transaction.session.deleteMany({ where: { user: { restaurantId } } }),
      );
      await remove("service-room-availability", () =>
        transaction.serviceRoomAvailability.deleteMany({ where: { restaurantId } }),
      );
      await remove("service-instances", () =>
        transaction.serviceInstance.deleteMany({ where: { restaurantId } }),
      );
      await remove("dining-tables", () =>
        transaction.diningTable.deleteMany({ where: { room: { restaurantId } } }),
      );
      await remove("rooms", () => transaction.room.deleteMany({ where: { restaurantId } }));
      await remove("special-dates", () =>
        transaction.specialDateOverride.deleteMany({ where: { restaurantId } }),
      );
      await remove("cutoff-rules", () =>
        transaction.bookingCutoffRule.deleteMany({ where: { restaurantId } }),
      );
      await remove("weekly-schedules", () =>
        transaction.weeklyServiceSchedule.deleteMany({ where: { restaurantId } }),
      );
      await remove("public-content", () =>
        transaction.publicContent.deleteMany({ where: { restaurantId } }),
      );
      await remove("public-settings", () =>
        transaction.restaurantPublicSettings.deleteMany({ where: { restaurantId } }),
      );
      await remove("booking-settings", () =>
        transaction.restaurantBookingSettings.deleteMany({ where: { restaurantId } }),
      );
      await remove("users", () => transaction.user.deleteMany({ where: { restaurantId } }));
      await remove("restaurant", () =>
        transaction.restaurant.deleteMany({
          where: { id: restaurantId, name: e2eRestaurantName(runId) },
        }),
      );

      const after = await fingerprintDatabaseOutsideRunWithOwnership(
        transaction,
        runId,
        loginRateLimitHashes,
      );
      if (after.fingerprint !== before.fingerprint) {
        throw new Error("Non-run database fingerprint changed during E2E purge.");
      }
      const runRowsAfter = await countRunRows(
        transaction,
        runId,
        loginRateLimitHashes,
      );
      if (runRowsAfter !== 0) {
        throw new Error(`E2E purge left ${runRowsAfter} run-owned rows.`);
      }
      return {
        runId,
        restaurantId,
        alreadyAbsent: false,
        deleted,
        nonRunFingerprint: after.fingerprint,
        runRowsAfter,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function main(): Promise<void> {
  assertE2ePurgeEnvironment(process.env);
  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
      connectionTimeoutMillis: 5_000,
    }),
  });
  try {
    console.info(JSON.stringify(await purgeE2eRun(client, process.env)));
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
