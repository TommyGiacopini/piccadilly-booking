import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  acquireStagingPreBaseline,
  assertStagingToolingGuard,
  cleanupStagingRun,
  scanStagingFakeData,
  STAGING_DEMO_RESTAURANT_ID,
  StagingFakeDataScanError,
  stagingRunPrefix,
  verifyStagingNotificationRun,
  verifyStagingSeed,
  type StagingDatabase,
} from "./staging-tooling";
import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { resolveDatabaseUrl } from "../src/server/db/database-config";

const { Pool } = pg;

function guardedEnvironment() {
  return {
    APP_ENV: "staging",
    RENDER: "true",
    RENDER_SERVICE_TYPE: "web",
    AUTH_RESTAURANT_ID: "00000000-0000-4000-8000-000000000001",
    DATABASE_URL: "postgresql://fake:fake@db.example.test/staging",
  };
}

describe("M13 guarded staging tooling", () => {
  it("allows only staging Render services and the exact demo tenant", () => {
    expect(assertStagingToolingGuard(guardedEnvironment())).toMatchObject({
      serviceType: "web",
    });
    expect(() =>
      assertStagingToolingGuard({ ...guardedEnvironment(), APP_ENV: "production" }),
    ).toThrow("APP_ENV=staging");
    expect(() =>
      assertStagingToolingGuard({ ...guardedEnvironment(), RENDER: "false" }),
    ).toThrow("Render environment");
    expect(() =>
      assertStagingToolingGuard({
        ...guardedEnvironment(),
        AUTH_RESTAURANT_ID: "00000000-0000-4000-8000-000000000002",
      }),
    ).toThrow("exact demo tenant");
    expect(() =>
      assertStagingToolingGuard({
        ...guardedEnvironment(),
        META_ACCESS_TOKEN: "forbidden",
      }),
    ).toThrow("provider");
  });

  it("verifies the exact clean fake seed contract", async () => {
    const database: StagingDatabase = {
      query: vi.fn(async () => ({
        rows: [
          {
            restaurantName: "Piccadilly Demo",
            timezone: "Europe/Rome",
            publicPhone: "+390000000000",
            publicBookingBaseUrl: "https://piccadilly-m13.onrender.com/",
            publicEmail: "demo@example.test",
            whatsappNumber: "+390000000001",
            notificationStrategy: "WHATSAPP_ONLY",
            demoUserCount: "2",
            demoTableCount: "5",
            reservationCount: "0",
            outboxCount: "0",
            attemptCount: "0",
            receiptCount: "0",
          },
        ],
      })),
    };
    await expect(verifyStagingSeed(database)).resolves.toEqual({
      demoUsers: 2,
      demoTables: 5,
      operationalRows: 0,
    });
  });

  it("rejects real-looking data and accepts only prefixed fake rows", async () => {
    const safeDatabase: StagingDatabase = {
      query: vi.fn(async () => ({
        rows: [
          {
            recordType: "restaurant",
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            nameValue: "Piccadilly Demo",
            phoneValue: null,
            secondaryPhoneValue: null,
            emailValue: null,
            urlValue: null,
            textValue: "Europe/Rome",
            channelValue: null,
          },
          {
            recordType: "public-settings",
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            nameValue: null,
            phoneValue: "+390000000000",
            secondaryPhoneValue: "+390000000001",
            emailValue: "demo@example.test",
            urlValue: "https://piccadilly-m13.onrender.com/",
            textValue: null,
            channelValue: null,
          },
          {
            recordType: "reservation",
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            nameValue: "M13-FIRST M13-LAST",
            phoneValue: "+390000001234",
            secondaryPhoneValue: null,
            emailValue: "fixture@example.test",
            urlValue: null,
            textValue: "M13 fixture",
            channelValue: null,
          },
        ],
      })),
    };
    await expect(scanStagingFakeData(safeDatabase)).resolves.toMatchObject({
      violationClasses: 0,
    });
    const unsafeDatabase: StagingDatabase = {
      query: vi.fn(async () => ({
        rows: [
          {
            recordType: "restaurant",
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            nameValue: "Piccadilly Demo",
            phoneValue: null,
            secondaryPhoneValue: null,
            emailValue: null,
            urlValue: null,
            textValue: "Europe/Rome",
            channelValue: null,
          },
          {
            recordType: "public-settings",
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            nameValue: null,
            phoneValue: "+390000000000",
            secondaryPhoneValue: "+390000000001",
            emailValue: "demo@example.test",
            urlValue: "https://piccadilly-m13.onrender.com/",
            textValue: null,
            channelValue: null,
          },
          {
            recordType: "reservation",
            restaurantId: "00000000-0000-4000-8000-000000000099",
            nameValue: "Unexpected Person",
            phoneValue: "+393331234567",
            secondaryPhoneValue: null,
            emailValue: "person@example.com",
            urlValue: null,
            textValue: "live",
            channelValue: null,
          },
          {
            recordType: "destination",
            restaurantId: "00000000-0000-4000-8000-000000000099",
            nameValue: null,
            phoneValue: "+393331234569",
            secondaryPhoneValue: null,
            emailValue: null,
            urlValue: null,
            textValue: null,
            channelValue: "WHATSAPP",
          },
        ],
      })),
    };
    const failure = await scanStagingFakeData(unsafeDatabase).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StagingFakeDataScanError);
    expect(
      (failure as StagingFakeDataScanError).findings.map((finding) => finding.type),
    ).toEqual(
      expect.arrayContaining([
        "unexpected-reservation",
        "unexpected-notification-destination",
      ]),
    );
  });

  it("verifies one simulated WhatsApp acceptance run with zero fallback", async () => {
    const database: StagingDatabase = {
      query: vi.fn(async () => ({
        rows: [
          {
            reservationCount: "1",
            confirmedCount: "1",
            succeededOutboxCount: "1",
            emailOutboxCount: "0",
            attemptCount: "1",
            successfulAttemptCount: "1",
            receiptCount: "1",
            simulatedWhatsappReceiptCount: "1",
            providerReferenceCount: "1",
          },
        ],
      })),
    };
    await expect(
      verifyStagingNotificationRun(database, "RUN-20260830"),
    ).resolves.toMatchObject({ fallback: 0 });
  });

  it("cleans only a confirmed run and preserves the non-run fingerprint", async () => {
    expect(stagingRunPrefix("run-20260830")).toBe("M13-RUN-20260830-");
    const queries: string[] = [];
    const database: StagingDatabase = {
      query: vi.fn(async (text): Promise<{ rows: unknown[]; rowCount?: number }> => {
        queries.push(text);
        if (text.includes("staging:pre-existing-run")) {
          return { rows: [{ rowCount: "0" }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const preBaseline = await acquireStagingPreBaseline(
      database,
      "RUN-20260830",
    );

    await expect(
      cleanupStagingRun({
        database,
        runId: "RUN-20260830",
        confirmation: "RUN-20260830",
        preBaseline,
      }),
    ).resolves.toMatchObject({ runRowsAfter: 0 });
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("COMMIT");
    expect(queries).not.toContain("ROLLBACK");
    await expect(
      cleanupStagingRun({
        database,
        runId: "RUN-20260830",
        confirmation: "WRONG-RUN",
        preBaseline,
      }),
    ).rejects.toThrow("exact run-scoped confirmation");
  });
});

function fakeReservationData(input: {
  restaurantId: string;
  userId: string;
  firstName: string;
  lastName: string;
}) {
  return {
    restaurantId: input.restaurantId,
    localDate: new Date("2099-12-30T00:00:00.000Z"),
    serviceType: "DINNER" as const,
    arrivalTime: new Date("1970-01-01T19:00:00.000Z"),
    partySize: 2,
    status: "CANCELLED" as const,
    origin: "STAFF" as const,
    customerFirstName: input.firstName,
    customerLastName: input.lastName,
    customerPhone: "+390000001399",
    customerEmail: "lqg-fixture@example.test",
    notes: "M13-LQG synthetic fixture",
    preferences: null,
    allergies: null,
    privacyPolicyVersion: "staging-demo-v1",
    privacyConsentAt: new Date("2099-01-01T00:00:00.000Z"),
    privacyConsentMethod: "STAFF_RECORDED" as const,
    termsPolicyVersion: null,
    termsConsentAt: null,
    termsConsentMethod: null,
    consentLanguage: null,
    createdByUserId: input.userId,
    cancelledAt: new Date("2099-01-01T00:00:00.000Z"),
  };
}

function hashFixture(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const runPostgresqlAdversarialTests =
  process.env.M13_STAGING_TOOLING_PG_TEST === "true";

describe
  .runIf(runPostgresqlAdversarialTests)
  .sequential("M13 staging tooling PostgreSQL adversarial evidence", () => {
    let client: PrismaClient;
    let pool: pg.Pool;

    beforeAll(async () => {
      const connectionString = resolveDatabaseUrl(process.env.DATABASE_URL);
      client = new PrismaClient({
        adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }),
      });
      pool = new Pool({
        connectionString,
        connectionTimeoutMillis: 5_000,
        query_timeout: 15_000,
        max: 1,
      });
      await client.$connect();
    });

    afterAll(async () => {
      await pool.end();
      await client.$disconnect();
    });

    async function demoSeedFingerprint(): Promise<string> {
      const state = await client.restaurant.findUniqueOrThrow({
        where: { id: STAGING_DEMO_RESTAURANT_ID },
        select: {
          id: true,
          name: true,
          timezone: true,
          publicSettings: true,
          notificationSettings: true,
          users: {
            orderBy: { username: "asc" },
            select: { id: true, username: true, role: true, isActive: true },
          },
          rooms: {
            orderBy: { code: "asc" },
            select: {
              id: true,
              code: true,
              diningTables: {
                orderBy: { name: "asc" },
                select: { id: true, name: true },
              },
            },
          },
        },
      });
      return hashFixture(JSON.stringify(state));
    }

    it("LQG-001 rejects an unexpected tenant with non-fake data globally", async () => {
      const decoyRestaurantId = randomUUID();
      try {
        await client.restaurant.create({
          data: {
            id: decoyRestaurantId,
            name: "Live Decoy Tenant",
            timezone: "Europe/Rome",
          },
        });
        await client.restaurantPublicSettings.create({
          data: {
            restaurantId: decoyRestaurantId,
            publicPhone: "+393331234567",
            whatsappNumber: "+393331234568",
            publicEmail: "customer@invalid.example",
            publicBookingBaseUrl: "https://ristopizzapiccadilly.it/",
          },
        });

        let failure: StagingFakeDataScanError | undefined;
        try {
          await scanStagingFakeData(pool as unknown as StagingDatabase);
        } catch (error) {
          if (error instanceof StagingFakeDataScanError) failure = error;
          else throw error;
        }
        expect(failure).toBeInstanceOf(StagingFakeDataScanError);
        const types = failure?.findings.map((finding) => finding.type) ?? [];
        expect(types).toEqual(
          expect.arrayContaining([
            "restaurant-cardinality",
            "unexpected-restaurant",
            "unexpected-public-settings",
            "unexpected-tenant-data",
            "non-fake-phone",
            "non-fake-email",
            "non-staging-hostname",
            "official-or-production-marker",
          ]),
        );
        expect(failure?.message).not.toMatch(
          /customer@|\+39333|ristopizzapiccadilly/i,
        );
        console.info(
          JSON.stringify({
            evidence: "M13-LQG-001",
            expectedFailure: true,
            sanitizedFindings: failure?.findings,
          }),
        );
        console.info(
          JSON.stringify({ evidence: "unexpected-tenant", rejected: true }),
        );
        console.info(
          JSON.stringify({ evidence: "non-fake-decoy", rejected: true }),
        );
      } finally {
        await client.restaurantPublicSettings.deleteMany({
          where: { restaurantId: decoyRestaurantId },
        });
        await client.restaurant.deleteMany({ where: { id: decoyRestaurantId } });
      }

      expect(
        await client.restaurant.count({ where: { id: decoyRestaurantId } }),
      ).toBe(0);
      expect(
        await client.restaurantPublicSettings.count({
          where: { restaurantId: decoyRestaurantId },
        }),
      ).toBe(0);
    });

    it("LQG-002 restores a non-empty lifecycle exactly to its PRE manifest", async () => {
      const runId = "RUN-LQG-20260831";
      const prefix = stagingRunPrefix(runId);
      const decoyRestaurantId = randomUUID();
      const fixtureIds = {
        preReservationId: "",
        preAuditId: "",
        decoyAuditId: "",
        runReservationId: "",
        assignmentId: "",
        reservationAuditId: "",
        auditId: "",
        managementTokenId: "",
        idempotencyId: "",
        outboxId: "",
        attemptId: "",
        sessionId: "",
        publicRateLimitId: "",
        serviceInstanceId: "",
        serviceAvailabilityId: "",
      };
      const loginRateLimitHash = hashFixture(randomUUID());
      const seedBefore = await demoSeedFingerprint();

      try {
        const admin = await client.user.findFirstOrThrow({
          where: { restaurantId: STAGING_DEMO_RESTAURANT_ID, role: "ADMIN" },
        });
        const room = await client.room.findFirstOrThrow({
          where: { restaurantId: STAGING_DEMO_RESTAURANT_ID, code: "sala-1" },
        });
        const diningTable = await client.diningTable.findFirstOrThrow({
          where: { roomId: room.id },
        });

        await client.restaurant.create({
          data: {
            id: decoyRestaurantId,
            name: "M13 Decoy Baseline",
            timezone: "Europe/Rome",
          },
        });
        const decoyAudit = await client.auditEvent.create({
          data: {
            restaurantId: decoyRestaurantId,
            category: "EXPORT",
            action: "BASELINE_DECOY",
            outcome: "SUCCESS",
            entityId: null,
            correlationId: randomUUID(),
          },
        });
        fixtureIds.decoyAuditId = decoyAudit.id;

        const preReservation = await client.reservation.create({
          data: fakeReservationData({
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            userId: admin.id,
            firstName: "M13-NONRUN-FIRST",
            lastName: "M13-NONRUN-LAST",
          }),
        });
        fixtureIds.preReservationId = preReservation.id;
        const preAudit = await client.auditEvent.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            category: "EXPORT",
            action: "BASELINE_NON_RUN",
            outcome: "SUCCESS",
            actorUserId: admin.id,
            actorRole: "ADMIN",
            entityId: null,
            correlationId: randomUUID(),
          },
        });
        fixtureIds.preAuditId = preAudit.id;

        const preBaseline = await acquireStagingPreBaseline(
          pool as unknown as StagingDatabase,
          runId,
        );

        const runReservation = await client.reservation.create({
          data: fakeReservationData({
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            userId: admin.id,
            firstName: `${prefix}FIRST`,
            lastName: `${prefix}LAST`,
          }),
        });
        fixtureIds.runReservationId = runReservation.id;
        const assignment = await client.reservationAssignment.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            reservationId: runReservation.id,
            roomId: room.id,
            internalNotes: `${prefix}ASSIGNMENT`,
            assignedByUserId: admin.id,
            updatedByUserId: admin.id,
          },
        });
        fixtureIds.assignmentId = assignment.id;
        await client.reservationAssignmentTable.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            assignmentId: assignment.id,
            roomId: room.id,
            diningTableId: diningTable.id,
          },
        });
        const reservationAudit = await client.reservationAuditEvent.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            reservationId: runReservation.id,
            action: "ASSIGNED",
            actorOrigin: "STAFF",
            actorUserId: admin.id,
            actorRole: "ADMIN",
            correlationId: randomUUID(),
            previousState: { assignment: null },
            newState: { assignment: { tableCount: 1 } },
          },
        });
        fixtureIds.reservationAuditId = reservationAudit.id;
        const runAudit = await client.auditEvent.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            category: "EXPORT",
            action: "RUN_ENTITY_NULL",
            outcome: "SUCCESS",
            actorUserId: admin.id,
            actorRole: "ADMIN",
            entityId: null,
            correlationId: randomUUID(),
          },
        });
        fixtureIds.auditId = runAudit.id;
        const managementToken = await client.reservationManagementToken.create({
          data: {
            reservationId: runReservation.id,
            tokenHash: hashFixture(`token-${randomUUID()}`),
            viewExpiresAt: new Date(Date.now() + 60_000),
          },
        });
        fixtureIds.managementTokenId = managementToken.id;
        const idempotency = await client.reservationIdempotencyKey.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            keyHash: hashFixture(`key-${randomUUID()}`),
            requestHash: hashFixture(`request-${randomUUID()}`),
            reservationId: runReservation.id,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        fixtureIds.idempotencyId = idempotency.id;
        const now = new Date();
        const outbox = await client.notificationOutbox.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            reservationId: runReservation.id,
            eventGroupId: randomUUID(),
            reservationVersion: runReservation.version,
            eventType: "RESERVATION_CONFIRMED",
            source: "PHONE",
            actorUserId: admin.id,
            channel: "WHATSAPP",
            strategy: "WHATSAPP_ONLY",
            destination: "+390000001399",
            payloadVersion: 1,
            payload: { fixture: "M13-LQG-002" } as Prisma.InputJsonValue,
            scheduledAt: now,
            availableAt: now,
            expiresAt: new Date(now.getTime() + 60_000),
            status: "PENDING",
            attemptCount: 1,
            maxAttempts: 4,
            retryPolicyVersion: 1,
            idempotencyKey: hashFixture(`outbox-${randomUUID()}`),
            originCorrelationId: randomUUID(),
          },
        });
        fixtureIds.outboxId = outbox.id;
        const attempt = await client.notificationAttempt.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            outboxId: outbox.id,
            attemptNumber: 1,
            providerKind: "SIMULATED_WHATSAPP",
            attemptCorrelationId: randomUUID(),
            startedAt: now,
            completedAt: now,
            outcome: "SUCCESS",
            providerReference: "simulated-lqg-002",
            deduplicated: false,
          },
        });
        fixtureIds.attemptId = attempt.id;
        await client.notificationSimulationReceipt.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            idempotencyKey: hashFixture(`receipt-${randomUUID()}`),
            outboxId: outbox.id,
            providerKind: "SIMULATED_WHATSAPP",
            payloadHash: hashFixture("M13-LQG-002-payload"),
            providerReference: "simulated-lqg-002",
          },
        });
        const session = await client.session.create({
          data: {
            id: randomUUID(),
            secretHash: hashFixture(`session-${randomUUID()}`),
            userId: admin.id,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        fixtureIds.sessionId = session.id;
        await client.loginRateLimit.create({
          data: {
            keyHash: loginRateLimitHash,
            attempts: 1,
            windowStartedAt: now,
            expiresAt: new Date(now.getTime() + 60_000),
          },
        });
        const publicRateLimit = await client.publicReservationRateLimit.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            action: "CREATE",
            keyHash: hashFixture(`public-rate-${randomUUID()}`),
            attempts: 1,
            windowStartedAt: now,
            expiresAt: new Date(now.getTime() + 60_000),
          },
        });
        fixtureIds.publicRateLimitId = publicRateLimit.id;
        const serviceInstance = await client.serviceInstance.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            localDate: new Date("2099-12-30T00:00:00.000Z"),
            serviceType: "DINNER",
          },
        });
        fixtureIds.serviceInstanceId = serviceInstance.id;
        const serviceAvailability = await client.serviceRoomAvailability.create({
          data: {
            restaurantId: STAGING_DEMO_RESTAURANT_ID,
            serviceInstanceId: serviceInstance.id,
            roomId: room.id,
            isAvailable: true,
          },
        });
        fixtureIds.serviceAvailabilityId = serviceAvailability.id;

        const result = await cleanupStagingRun({
          database: pool as unknown as StagingDatabase,
          runId,
          confirmation: runId,
          preBaseline,
        });

        expect(result.runRowsAfter).toBe(0);
        expect(result.beforeFingerprint).toBe(preBaseline.fingerprint);
        expect(result.afterFingerprint).toBe(preBaseline.fingerprint);
        for (const deleted of Object.values(result.deleted)) expect(deleted).toBe(1);
        expect(
          await client.reservation.count({
            where: { id: fixtureIds.preReservationId },
          }),
        ).toBe(1);
        expect(
          await client.auditEvent.count({ where: { id: fixtureIds.preAuditId } }),
        ).toBe(1);
        expect(
          await client.auditEvent.count({ where: { id: fixtureIds.decoyAuditId } }),
        ).toBe(1);
        expect(await demoSeedFingerprint()).toBe(seedBefore);
        expect(
          await client.session.count({ where: { id: fixtureIds.sessionId } }),
        ).toBe(0);
        expect(
          await client.loginRateLimit.count({
            where: { keyHash: loginRateLimitHash },
          }),
        ).toBe(0);
        expect(
          await client.publicReservationRateLimit.count({
            where: { id: fixtureIds.publicRateLimitId },
          }),
        ).toBe(0);
        expect(
          await client.auditEvent.count({ where: { id: fixtureIds.auditId } }),
        ).toBe(0);
        console.info(
          JSON.stringify({
            evidence: "M13-LQG-002",
            nonEmptyRun: true,
            coveredFamilies: Object.keys(result.deleted),
            deleted: result.deleted,
            runRowsAfter: result.runRowsAfter,
            preFingerprint: result.beforeFingerprint,
            postFingerprint: result.afterFingerprint,
            sessionRemaining: 0,
            loginRateLimitRemaining: 0,
            publicRateLimitRemaining: 0,
            entityNullAuditRemaining: 0,
            nonRunPreserved: true,
            crossTenantPreserved: true,
            seedPreserved: true,
          }),
        );
        for (const evidence of [
          { evidence: "non-empty-cleanup", runRowsAfter: 0, preEqualsPost: true },
          { evidence: "session-cleanup", deleted: 1, remaining: 0 },
          {
            evidence: "rate-limit-cleanup",
            loginDeleted: 1,
            loginRemaining: 0,
            publicDeleted: 1,
            publicRemaining: 0,
          },
          { evidence: "entity-id-null-audit-cleanup", deleted: 1, remaining: 0 },
          { evidence: "cross-tenant-preservation", preserved: true },
          { evidence: "non-run-preservation", preserved: true },
        ]) {
          console.info(JSON.stringify(evidence));
        }
      } finally {
        if (fixtureIds.outboxId) {
          await client.notificationSimulationReceipt.deleteMany({
            where: { outboxId: fixtureIds.outboxId },
          });
        }
        if (fixtureIds.attemptId) {
          await client.notificationAttempt.deleteMany({
            where: { id: fixtureIds.attemptId },
          });
        }
        if (fixtureIds.outboxId) {
          await client.notificationOutbox.deleteMany({
            where: { id: fixtureIds.outboxId },
          });
        }
        if (fixtureIds.assignmentId) {
          await client.reservationAssignmentTable.deleteMany({
            where: { assignmentId: fixtureIds.assignmentId },
          });
          await client.reservationAssignment.deleteMany({
            where: { id: fixtureIds.assignmentId },
          });
        }
        if (fixtureIds.reservationAuditId) {
          await client.reservationAuditEvent.deleteMany({
            where: { id: fixtureIds.reservationAuditId },
          });
        }
        if (fixtureIds.managementTokenId) {
          await client.reservationManagementToken.deleteMany({
            where: { id: fixtureIds.managementTokenId },
          });
        }
        if (fixtureIds.idempotencyId) {
          await client.reservationIdempotencyKey.deleteMany({
            where: { id: fixtureIds.idempotencyId },
          });
        }
        await client.auditEvent.deleteMany({
          where: {
            id: {
              in: [fixtureIds.auditId, fixtureIds.preAuditId, fixtureIds.decoyAuditId].filter(
                Boolean,
              ),
            },
          },
        });
        if (fixtureIds.sessionId) {
          await client.session.deleteMany({
            where: { id: fixtureIds.sessionId },
          });
        }
        await client.loginRateLimit.deleteMany({
          where: { keyHash: loginRateLimitHash },
        });
        if (fixtureIds.publicRateLimitId) {
          await client.publicReservationRateLimit.deleteMany({
            where: { id: fixtureIds.publicRateLimitId },
          });
        }
        await client.reservation.deleteMany({
          where: {
            id: {
              in: [fixtureIds.runReservationId, fixtureIds.preReservationId].filter(
                Boolean,
              ),
            },
          },
        });
        if (fixtureIds.serviceAvailabilityId) {
          await client.serviceRoomAvailability.deleteMany({
            where: { id: fixtureIds.serviceAvailabilityId },
          });
        }
        if (fixtureIds.serviceInstanceId) {
          await client.serviceInstance.deleteMany({
            where: { id: fixtureIds.serviceInstanceId },
          });
        }
        await client.restaurant.deleteMany({ where: { id: decoyRestaurantId } });
      }
    });
  });
