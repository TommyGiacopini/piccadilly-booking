import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "../src/generated/prisma/client";
import { resolveDatabaseUrl } from "../src/server/db/database-config";
import {
  assertE2ePurgeEnvironment,
  fingerprintDatabaseOutsideRun,
  purgeE2eRun,
} from "./cleanup-e2e-reservations";
import {
  e2eAuthRateLimitSecret,
  e2eCreatedUsernames,
  e2eDiningTableName,
  e2eLoginRateLimitHashes,
  e2eOwnedUsernames,
  e2ePublicRateLimitSecret,
  e2ePurgeOptIn,
  e2eReservationFirstName,
  e2eRestaurantId,
} from "./e2e-fixture-ownership";
import { prepareE2eTenant } from "./prepare-e2e-users";

const client = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
    connectionTimeoutMillis: 5_000,
  }),
});
const testPassword = process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "Fake E2E password 123!";

function guardedEnvironment(runId: string) {
  return {
    APP_ENV: "development",
    NODE_ENV: "test",
    E2E_RUN_ID: runId,
    E2E_TEST_MODE: "true",
    E2E_PURGE_OPT_IN: e2ePurgeOptIn(runId),
    AUTH_RESTAURANT_ID: e2eRestaurantId(runId),
    AUTH_RATE_LIMIT_SECRET: e2eAuthRateLimitSecret(runId),
    AUTH_TRUST_PROXY: "false",
    PUBLIC_BOOKING_RATE_LIMIT_SECRET: e2ePublicRateLimitSecret(runId),
  };
}

function fakeReservationData(
  runId: string,
  input: { firstName?: string; createdByUserId?: string | null } = {},
) {
  return {
    restaurantId: e2eRestaurantId(runId),
    localDate: new Date("2099-12-29T00:00:00.000Z"),
    serviceType: "DINNER" as const,
    arrivalTime: new Date("1970-01-01T19:00:00.000Z"),
    partySize: 2,
    status: "CANCELLED" as const,
    origin: "STAFF" as const,
    customerFirstName: input.firstName ?? e2eReservationFirstName(runId),
    customerLastName: "Cleanup Fixture",
    customerPhone: "+390000000099",
    customerEmail: "cleanup@example.test",
    notes: "Synthetic cleanup fixture",
    preferences: null,
    allergies: null,
    privacyPolicyVersion: "test-v1",
    privacyConsentAt: new Date("2099-01-01T00:00:00.000Z"),
    privacyConsentMethod: "STAFF_RECORDED" as const,
    termsPolicyVersion: null,
    termsConsentAt: null,
    termsConsentMethod: null,
    consentLanguage: null,
    createdByUserId: input.createdByUserId ?? null,
    cancelledAt: new Date("2099-01-01T00:00:00.000Z"),
  };
}

async function prepare(runId: string) {
  await prepareE2eTenant(client, runId, {
    admin: testPassword,
    staff: testPassword,
  });
}

async function runGraphCounts(runId: string) {
  const restaurantId = e2eRestaurantId(runId);
  const result = await client.$queryRaw<Array<{ fingerprint: string }>>`
    SELECT md5(concat_ws('|',
      (SELECT count(*) FROM restaurants WHERE id = ${restaurantId}::uuid),
      (SELECT count(*) FROM users WHERE restaurant_id = ${restaurantId}::uuid),
      (SELECT count(*) FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.restaurant_id = ${restaurantId}::uuid),
      (SELECT count(*) FROM reservations WHERE restaurant_id = ${restaurantId}::uuid),
      (SELECT count(*) FROM reservation_assignments WHERE restaurant_id = ${restaurantId}::uuid),
      (SELECT count(*) FROM reservation_assignment_tables WHERE restaurant_id = ${restaurantId}::uuid),
      (SELECT count(*) FROM reservation_audit_events WHERE restaurant_id = ${restaurantId}::uuid),
      (SELECT count(*) FROM audit_events WHERE restaurant_id = ${restaurantId}::uuid),
      (SELECT count(*) FROM dining_tables dt JOIN rooms r ON r.id = dt.room_id WHERE r.restaurant_id = ${restaurantId}::uuid)
    )) AS fingerprint
  `;
  return result[0]?.fingerprint;
}

async function addCompleteHistoricalGraph(runId: string) {
  const restaurantId = e2eRestaurantId(runId);
  const admin = await client.user.findFirstOrThrow({
    where: { restaurantId, role: "ADMIN" },
  });
  const room = await client.room.findFirstOrThrow({
    where: { restaurantId, code: "sala-1" },
  });
  const managedUsername = e2eCreatedUsernames(runId)[0]!;
  const managedUser = await client.user.create({
    data: {
      restaurantId,
      username: managedUsername,
      passwordHash: "fake-test-only-hash",
      role: "STAFF",
      isActive: false,
      mustChangePassword: true,
      disabledAt: new Date(),
    },
  });
  const table = await client.diningTable.create({
    data: {
      roomId: room.id,
      name: e2eDiningTableName(runId),
      minimumSeats: 2,
      maximumSeats: 4,
      isActive: false,
      displayOrder: 99,
    },
  });
  const reservation = await client.reservation.create({
    data: fakeReservationData(runId, { createdByUserId: admin.id }),
  });
  const assignment = await client.reservationAssignment.create({
    data: {
      restaurantId,
      reservationId: reservation.id,
      roomId: room.id,
      internalNotes: "Never expose this cleanup note",
      assignedByUserId: admin.id,
      updatedByUserId: admin.id,
      clearedAt: new Date(),
    },
  });
  await client.reservationAssignmentTable.create({
    data: {
      restaurantId,
      assignmentId: assignment.id,
      roomId: room.id,
      diningTableId: table.id,
    },
  });
  await client.reservationAuditEvent.create({
    data: {
      restaurantId,
      reservationId: reservation.id,
      action: "UNASSIGNED",
      actorOrigin: "STAFF",
      actorUserId: admin.id,
      actorRole: "ADMIN",
      correlationId: randomUUID(),
      previousState: { assignment: { internalNotesPresent: true } },
      newState: { assignment: null },
    },
  });
  const loginHash = e2eLoginRateLimitHashes(runId)[0]!;
  await client.auditEvent.createMany({
    data: [
      {
        restaurantId,
        category: "CONFIGURATION",
        action: "DINING_TABLE_DISABLED",
        outcome: "SUCCESS",
        actorUserId: admin.id,
        actorRole: "ADMIN",
        entityType: "DINING_TABLE",
        entityId: table.id,
        correlationId: randomUUID(),
        previousState: { isActive: true },
        newState: { isActive: false },
      },
      {
        restaurantId,
        category: "AUTHENTICATION",
        action: "LOGIN_FAILED",
        outcome: "FAILURE",
        actorUserId: null,
        actorRole: null,
        entityType: null,
        entityId: null,
        correlationId: randomUUID(),
        metadata: { credentialFingerprint: loginHash },
      },
    ],
  });
  await client.loginRateLimit.create({
    data: {
      keyHash: loginHash,
      attempts: 1,
      windowStartedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await client.session.create({
    data: {
      id: randomUUID(),
      secretHash: "a".repeat(64),
      userId: managedUser.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await client.reservationIdempotencyKey.create({
    data: {
      restaurantId,
      keyHash: "b".repeat(64),
      requestHash: "c".repeat(64),
      reservationId: reservation.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await client.reservationManagementToken.create({
    data: {
      reservationId: reservation.id,
      tokenHash: "d".repeat(64),
      viewExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  await client.publicReservationRateLimit.create({
    data: {
      restaurantId,
      action: "CREATE",
      keyHash: "e".repeat(64),
      expiresAt: new Date(Date.now() + 60_000),
      windowStartedAt: new Date(),
    },
  });
  const instance = await client.serviceInstance.create({
    data: {
      restaurantId,
      localDate: new Date("2099-12-29T00:00:00.000Z"),
      serviceType: "DINNER",
    },
  });
  await client.serviceRoomAvailability.create({
    data: {
      restaurantId,
      serviceInstanceId: instance.id,
      roomId: room.id,
      isAvailable: false,
    },
  });
  return { loginHash, reservationId: reservation.id };
}

describe("run-scoped E2E fixture purge", () => {
  beforeAll(async () => {
    await client.$connect();
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  it("rejects missing and malformed run IDs", () => {
    expect(() => assertE2ePurgeEnvironment({})).toThrow(/valid UUID/u);
    expect(() =>
      assertE2ePurgeEnvironment({ E2E_RUN_ID: "not-a-run" }),
    ).toThrow(/valid UUID/u);
  });

  it("rejects production, missing E2E mode, and missing explicit opt-in", () => {
    const runId = randomUUID();
    expect(() =>
      assertE2ePurgeEnvironment({
        ...guardedEnvironment(runId),
        APP_ENV: "production",
      }),
    ).toThrow(/forbidden in production/u);
    expect(() =>
      assertE2ePurgeEnvironment({
        ...guardedEnvironment(runId),
        E2E_TEST_MODE: undefined,
      }),
    ).toThrow(/E2E_TEST_MODE=true/u);
    expect(() =>
      assertE2ePurgeEnvironment({
        ...guardedEnvironment(runId),
        E2E_PURGE_OPT_IN: undefined,
      }),
    ).toThrow(/explicit run-scoped opt-in/u);
  });

  it("rejects NODE_ENV=test without E2E_TEST_MODE before any purge query", async () => {
    const runId = randomUUID();
    await prepare(runId);
    const graphBefore = await runGraphCounts(runId);
    const fingerprintBefore = await fingerprintDatabaseOutsideRun(client, runId);

    try {
      await expect(
        purgeE2eRun(client, {
          ...guardedEnvironment(runId),
          NODE_ENV: "test",
          E2E_TEST_MODE: undefined,
        }),
      ).rejects.toThrow(/E2E_TEST_MODE=true/u);
      expect(await runGraphCounts(runId)).toBe(graphBefore);
      expect(await fingerprintDatabaseOutsideRun(client, runId)).toEqual(
        fingerprintBefore,
      );
    } finally {
      await purgeE2eRun(client, guardedEnvironment(runId));
    }
  });

  it("guards the exported purge before opening a transaction", async () => {
    const runId = randomUUID();
    const transaction = vi.fn();
    const guardedClient = { $transaction: transaction } as unknown as PrismaClient;
    const valid = guardedEnvironment(runId);
    const invalidEnvironments = [
      { ...valid, E2E_PURGE_OPT_IN: undefined },
      { ...valid, AUTH_RESTAURANT_ID: undefined },
      { ...valid, AUTH_RATE_LIMIT_SECRET: undefined },
      { ...valid, PUBLIC_BOOKING_RATE_LIMIT_SECRET: undefined },
    ];

    for (const environment of invalidEnvironments) {
      await expect(purgeE2eRun(guardedClient, environment)).rejects.toThrow();
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it("purges the complete current and historical graph and is idempotent", async () => {
    const runId = randomUUID();
    const nonRunBefore = await fingerprintDatabaseOutsideRun(client, runId);
    await prepare(runId);
    const fixture = await addCompleteHistoricalGraph(runId);

    const result = await purgeE2eRun(client, guardedEnvironment(runId));
    expect(result.alreadyAbsent).toBe(false);
    expect(result.runRowsAfter).toBe(0);
    expect(result.deleted).toMatchObject({
      assignments: 1,
      "assignment-tables": 1,
      "reservation-audits": 1,
      "administrative-audits": 2,
      "management-tokens": 1,
      idempotency: 1,
      reservations: 1,
      "public-rate-limits": 1,
      "login-rate-limits": 1,
      "service-instances": 1,
      restaurant: 1,
    });
    await expect(
      client.loginRateLimit.count({ where: { keyHash: fixture.loginHash } }),
    ).resolves.toBe(0);
    await expect(
      purgeE2eRun(client, guardedEnvironment(runId)),
    ).resolves.toMatchObject({
      alreadyAbsent: true,
      runRowsAfter: 0,
    });
    expect(await fingerprintDatabaseOutsideRun(client, runId)).toEqual(
      nonRunBefore,
    );
  });

  it("preserves same-tenant non-run and similar markers by refusing uncertain ownership", async () => {
    const runId = randomUUID();
    await prepare(runId);
    const admin = await client.user.findFirstOrThrow({
      where: { restaurantId: runId, role: "ADMIN" },
    });
    const decoy = await client.reservation.create({
      data: fakeReservationData(runId, {
        firstName: `${e2eReservationFirstName(runId)}-similar-not-owned`,
        createdByUserId: admin.id,
      }),
    });
    const before = await runGraphCounts(runId);
    await expect(
      purgeE2eRun(client, guardedEnvironment(runId)),
    ).rejects.toThrow(
      /without an exact run ownership marker/u,
    );
    expect(await runGraphCounts(runId)).toBe(before);
    await expect(
      client.reservation.count({ where: { id: decoy.id } }),
    ).resolves.toBe(1);
    await client.reservation.delete({ where: { id: decoy.id } });
    await purgeE2eRun(client, guardedEnvironment(runId));
  });

  it("preserves an exact decoy in another tenant and its fingerprint", async () => {
    const runId = randomUUID();
    const otherTenantReservation = await client.reservation.create({
      data: {
        ...fakeReservationData(runId, {
          firstName: e2eReservationFirstName(runId),
          createdByUserId: "00000000-0000-4000-8000-000000000101",
        }),
        restaurantId: "00000000-0000-4000-8000-000000000001",
      },
    });
    try {
      const before = await fingerprintDatabaseOutsideRun(client, runId);
      await prepare(runId);
      await addCompleteHistoricalGraph(runId);
      await purgeE2eRun(client, guardedEnvironment(runId));
      expect(await fingerprintDatabaseOutsideRun(client, runId)).toEqual(before);
      await expect(
        client.reservation.count({ where: { id: otherTenantReservation.id } }),
      ).resolves.toBe(1);
    } finally {
      await client.reservation.deleteMany({
        where: { id: otherTenantReservation.id },
      });
      await purgeE2eRun(client, guardedEnvironment(runId)).catch(
        () => undefined,
      );
    }
  });

  it("preserves a global login bucket even when run audit metadata claims its fingerprint", async () => {
    const runId = randomUUID();
    const decoyHash = createHash("sha256")
      .update(`global-login-decoy-${runId}`)
      .digest("hex");
    expect(e2eLoginRateLimitHashes(runId)).not.toContain(decoyHash);
    await client.loginRateLimit.create({
      data: {
        keyHash: decoyHash,
        attempts: 3,
        windowStartedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const fingerprintBefore = await fingerprintDatabaseOutsideRun(client, runId);

    try {
      await prepare(runId);
      const admin = await client.user.findFirstOrThrow({
        where: { restaurantId: runId, role: "ADMIN" },
      });
      await client.auditEvent.create({
        data: {
          restaurantId: runId,
          category: "AUTHENTICATION",
          action: "LOGIN_FAILED",
          outcome: "FAILURE",
          actorUserId: admin.id,
          actorRole: "ADMIN",
          correlationId: randomUUID(),
          metadata: { credentialFingerprint: decoyHash },
        },
      });

      await purgeE2eRun(client, guardedEnvironment(runId));
      await expect(
        client.loginRateLimit.count({ where: { keyHash: decoyHash } }),
      ).resolves.toBe(1);
      expect(await fingerprintDatabaseOutsideRun(client, runId)).toEqual(
        fingerprintBefore,
      );
    } finally {
      await client.loginRateLimit.deleteMany({ where: { keyHash: decoyHash } });
      await purgeE2eRun(client, guardedEnvironment(runId)).catch(
        () => undefined,
      );
    }
  });

  it("rolls back every deletion when an intermediate purge step fails", async () => {
    const runId = randomUUID();
    await prepare(runId);
    await addCompleteHistoricalGraph(runId);
    const before = await runGraphCounts(runId);
    await expect(
      purgeE2eRun(client, guardedEnvironment(runId), {
        afterStep: (step) => {
          if (step === "assignments") throw new Error("synthetic purge failure");
        },
      }),
    ).rejects.toThrow("synthetic purge failure");
    expect(await runGraphCounts(runId)).toBe(before);
    expect((await client.user.findMany({ where: { restaurantId: runId } })).map((u) => u.username).every((username) => e2eOwnedUsernames(runId).includes(username))).toBe(true);
    await purgeE2eRun(client, guardedEnvironment(runId));
  });
});
