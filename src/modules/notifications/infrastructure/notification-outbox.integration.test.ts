import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import type { NotificationProvider } from "@/modules/notifications/application/ports";
import { processClaimedNotification } from "@/modules/notifications/application/processor";
import { processDueNotificationBatch } from "@/modules/notifications/application/worker";
import { notificationIdempotencyKey } from "@/modules/notifications/domain/delivery-policy";
import { toVersionedMessage } from "@/modules/notifications/domain/notification-rules";
import type { NotificationPayloadV1 } from "@/modules/notifications/domain/types";
import { PrismaNotificationWorkerRepository } from "@/modules/notifications/infrastructure/notification-worker-repository";
import {
  SimulatedEmailProvider,
  SimulatedWhatsAppProvider,
} from "@/modules/notifications/infrastructure/simulated-providers";
import { prisma } from "@/server/db/prisma";

const restaurantA = randomUUID();
const restaurantB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const reservationA = randomUUID();
const reservationB = randomUUID();
const baseNow = new Date("2028-08-20T10:00:00.000Z");
const expiry = new Date("2028-08-21T10:00:00.000Z");

const payload: NotificationPayloadV1 = {
  schemaVersion: 1,
  templateKey: "RESERVATION_CONFIRMED",
  templateVersion: 1,
  locale: "IT",
  params: {
    customerFirstName: "Ada",
    restaurantName: "M12 Demo A",
    localDate: "2028-08-21",
    serviceType: "DINNER",
    arrivalTime: "20:00",
    partySize: 2,
  },
};

async function createOutbox(input: {
  restaurantId?: string;
  reservationId?: string;
  actorUserId?: string | null;
  reservationVersion?: number;
  eventType?: "RESERVATION_CONFIRMED" | "RESERVATION_UPDATED" | "RESERVATION_CANCELLED" | "RESERVATION_REMINDER";
  channel?: "WHATSAPP" | "EMAIL";
  strategy?: "WHATSAPP_ONLY" | "WHATSAPP_WITH_EMAIL_FALLBACK" | "WHATSAPP_AND_EMAIL_PARALLEL";
  destination?: string | null;
  eventGroupId?: string;
  scheduledAt?: Date;
  availableAt?: Date;
  expiresAt?: Date;
}) {
  const restaurantId = input.restaurantId ?? restaurantA;
  const reservationId = input.reservationId ?? reservationA;
  const reservationVersion = input.reservationVersion ?? 1;
  const eventType = input.eventType ?? "RESERVATION_CONFIRMED";
  const channel = input.channel ?? "WHATSAPP";
  const strategy = input.strategy ?? "WHATSAPP_ONLY";
  return prisma.notificationOutbox.create({
    data: {
      restaurantId,
      reservationId,
      eventGroupId: input.eventGroupId ?? randomUUID(),
      reservationVersion,
      eventType,
      source: "PHONE",
      actorUserId: input.actorUserId === undefined ? (restaurantId === restaurantA ? userA : userB) : input.actorUserId,
      channel,
      strategy,
      destination: input.destination === undefined ? (channel === "WHATSAPP" ? "+39000000000" : "ada@example.test") : input.destination,
      payloadVersion: 1,
      payload: payload as unknown as Prisma.InputJsonValue,
      scheduledAt: input.scheduledAt ?? baseNow,
      availableAt: input.availableAt ?? baseNow,
      expiresAt: input.expiresAt ?? expiry,
      status: "PENDING",
      attemptCount: 0,
      maxAttempts: 4,
      retryPolicyVersion: 1,
      idempotencyKey: notificationIdempotencyKey({ restaurantId, reservationId, reservationVersion, eventType, channel }),
      originCorrelationId: randomUUID(),
    },
  });
}

async function deleteNotificationRows() {
  await prisma.notificationSimulationReceipt.deleteMany({ where: { restaurantId: { in: [restaurantA, restaurantB] } } });
  await prisma.notificationAttempt.deleteMany({ where: { restaurantId: { in: [restaurantA, restaurantB] } } });
  await prisma.notificationOutbox.deleteMany({ where: { restaurantId: { in: [restaurantA, restaurantB] } } });
}

const testSleeper = {
  wait: async (_milliseconds: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
};

function worker(input: {
  now: Date;
  whatsapp?: NotificationProvider;
  email?: NotificationProvider;
}) {
  return {
    repository: new PrismaNotificationWorkerRepository(),
    whatsappProvider: input.whatsapp ?? new SimulatedWhatsAppProvider(),
    emailProvider: input.email ?? new SimulatedEmailProvider(),
    clock: { now: () => input.now },
    sleeper: testSleeper,
    ids: { generate: randomUUID },
  };
}

describe.sequential("M12 transactional outbox with real PostgreSQL", () => {
  beforeAll(async () => {
    await prisma.restaurant.createMany({
      data: [
        { id: restaurantA, name: "M12 Demo A", timezone: "Europe/Rome" },
        { id: restaurantB, name: "M12 Demo B", timezone: "Europe/Rome" },
      ],
    });
    await prisma.restaurantNotificationSettings.createMany({
      data: [
        { restaurantId: restaurantA, strategy: "WHATSAPP_ONLY" },
        { restaurantId: restaurantB, strategy: "WHATSAPP_ONLY" },
      ],
    });
    await prisma.user.createMany({
      data: [
        { id: userA, restaurantId: restaurantA, username: `m12-a-${restaurantA}`, passwordHash: "not-used", role: "ADMIN" },
        { id: userB, restaurantId: restaurantB, username: `m12-b-${restaurantB}`, passwordHash: "not-used", role: "ADMIN" },
      ],
    });
    await prisma.reservation.createMany({
      data: [
        {
          id: reservationA,
          restaurantId: restaurantA,
          localDate: new Date("2028-08-21T00:00:00.000Z"),
          serviceType: "DINNER",
          arrivalTime: new Date("1970-01-01T20:00:00.000Z"),
          partySize: 2,
          status: "CONFIRMED",
          origin: "PHONE",
          customerFirstName: "Ada",
          customerLastName: "Test",
          customerPhone: "+39000000000",
          customerEmail: "ada@example.test",
          privacyPolicyVersion: "m12-test-v1",
          privacyConsentAt: baseNow,
          privacyConsentMethod: "VERBAL",
          createdByUserId: userA,
        },
        {
          id: reservationB,
          restaurantId: restaurantB,
          localDate: new Date("2028-08-21T00:00:00.000Z"),
          serviceType: "DINNER",
          arrivalTime: new Date("1970-01-01T20:00:00.000Z"),
          partySize: 2,
          status: "CONFIRMED",
          origin: "PHONE",
          customerFirstName: "Berta",
          customerLastName: "Test",
          customerPhone: "+39000000001",
          customerEmail: null,
          privacyPolicyVersion: "m12-test-v1",
          privacyConsentAt: baseNow,
          privacyConsentMethod: "VERBAL",
          createdByUserId: userB,
        },
      ],
    });
  });

  beforeEach(deleteNotificationRows);

  afterAll(async () => {
    await deleteNotificationRows();
    await prisma.reservation.deleteMany({ where: { id: { in: [reservationA, reservationB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
    await prisma.restaurantNotificationSettings.deleteMany({ where: { restaurantId: { in: [restaurantA, restaurantB] } } });
    await prisma.restaurant.deleteMany({ where: { id: { in: [restaurantA, restaurantB] } } });
    await prisma.$disconnect();
  });

  it("has all four M12 tables, the required indexes and settings for every migrated restaurant", async () => {
    const rows = await prisma.$queryRaw<Array<{ table_count: bigint; index_count: bigint; missing_settings: bigint }>>`
      SELECT
        (SELECT COUNT(*) FROM pg_class WHERE relname IN ('restaurant_notification_settings', 'notification_outbox', 'notification_attempts', 'notification_simulation_receipts') AND relkind = 'r') AS table_count,
        (SELECT COUNT(*) FROM pg_indexes WHERE indexname IN ('notification_outbox_work_eligibility_idx', 'notification_outbox_lease_recovery_idx', 'notification_outbox_restaurant_reservation_created_idx', 'notification_outbox_restaurant_group_status_idx')) AS index_count,
        (SELECT COUNT(*) FROM restaurants r LEFT JOIN restaurant_notification_settings s ON s.restaurant_id = r.id WHERE s.restaurant_id IS NULL) AS missing_settings
    `;
    expect(rows[0]).toEqual({ table_count: BigInt(4), index_count: BigInt(4), missing_settings: BigInt(0) });
  });

  it("rejects cross-tenant reservation and actor references", async () => {
    await expect(createOutbox({ restaurantId: restaurantA, reservationId: reservationB, actorUserId: userA })).rejects.toThrow();
    await expect(createOutbox({ restaurantId: restaurantA, reservationId: reservationA, actorUserId: userB })).rejects.toThrow();
    await expect(prisma.notificationOutbox.count()).resolves.toBe(0);
  });

  it("enforces logical-delivery and idempotency uniqueness", async () => {
    const first = await createOutbox({});
    await expect(createOutbox({ eventGroupId: randomUUID() })).rejects.toThrow();
    const second = await createOutbox({ reservationVersion: 2, eventType: "RESERVATION_UPDATED" });
    await expect(prisma.notificationOutbox.update({ where: { id: second.id }, data: { idempotencyKey: first.idempotencyKey } })).rejects.toThrow();
    await expect(prisma.notificationOutbox.count()).resolves.toBe(2);
  });

  it("enforces lifecycle, lease, attempt-count and JSON-object checks in PostgreSQL", async () => {
    const row = await createOutbox({});
    await expect(prisma.$executeRaw`UPDATE notification_outbox SET attempt_count = 5 WHERE id = ${row.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE notification_outbox SET status = 'CLAIMED' WHERE id = ${row.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE notification_outbox SET status = 'SUCCEEDED' WHERE id = ${row.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE notification_outbox SET payload = '[]'::jsonb WHERE id = ${row.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE notification_outbox SET terminal_failure_code = 'EXPIRED' WHERE id = ${row.id}::uuid`).rejects.toThrow();
  });

  it("enforces attempt and persistent receipt uniqueness plus attempt outcome checks", async () => {
    const first = await createOutbox({});
    const second = await createOutbox({
      reservationVersion: 2,
      eventType: "RESERVATION_UPDATED",
    });
    const repository = new PrismaNotificationWorkerRepository();
    const claimed = await repository.claimDue({
      now: baseNow,
      batchSize: 1,
      maxPerTenant: 5,
      leaseMilliseconds: 120_000,
    });
    const started = await repository.startAttempt({
      notification: claimed[0]!,
      attemptCorrelationId: randomUUID(),
      now: baseNow,
    });
    const persistedAttempt = await prisma.notificationAttempt.findUniqueOrThrow({
      where: {
        restaurantId_outboxId_attemptNumber: {
          restaurantId: started!.notification.restaurantId,
          outboxId: started!.notification.id,
          attemptNumber: started!.attemptNumber,
        },
      },
    });

    await expect(
      prisma.notificationAttempt.create({
        data: {
          ...persistedAttempt,
          id: randomUUID(),
          createdAt: undefined,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.notificationAttempt.create({
        data: {
          restaurantId: restaurantA,
          outboxId: first.id,
          attemptNumber: 2,
          providerKind: "SIMULATED_WHATSAPP",
          attemptCorrelationId: randomUUID(),
          startedAt: baseNow,
          completedAt: baseNow,
          outcome: "SUCCESS",
          providerReference: null,
        },
      }),
    ).rejects.toThrow();

    const firstReceiptKey = "a".repeat(64);
    await prisma.notificationSimulationReceipt.create({
      data: {
        restaurantId: restaurantA,
        idempotencyKey: firstReceiptKey,
        outboxId: first.id,
        providerKind: "SIMULATED_WHATSAPP",
        payloadHash: "b".repeat(64),
        providerReference: "sim-unique-receipt",
      },
    });
    await expect(
      prisma.notificationSimulationReceipt.create({
        data: {
          restaurantId: restaurantA,
          idempotencyKey: firstReceiptKey,
          outboxId: second.id,
          providerKind: "SIMULATED_WHATSAPP",
          payloadHash: "b".repeat(64),
          providerReference: "sim-duplicate-key",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.notificationSimulationReceipt.create({
        data: {
          restaurantId: restaurantA,
          idempotencyKey: "c".repeat(64),
          outboxId: first.id,
          providerKind: "SIMULATED_WHATSAPP",
          payloadHash: "b".repeat(64),
          providerReference: "sim-duplicate-outbox",
        },
      }),
    ).rejects.toThrow();
  });

  it("allows only one concurrent claim for the same delivery leg", async () => {
    await createOutbox({});
    const repository = new PrismaNotificationWorkerRepository();
    const input = { now: baseNow, batchSize: 25, maxPerTenant: 5, leaseMilliseconds: 120_000 };
    const [left, right] = await Promise.all([repository.claimDue(input), repository.claimDue(input)]);
    expect([...left, ...right]).toHaveLength(1);
    expect(new Set([...left, ...right].map((row) => row.id)).size).toBe(1);
  });

  it("caps a global batch at five legs per tenant", async () => {
    for (let version = 1; version <= 7; version += 1) await createOutbox({ reservationVersion: version, eventType: "RESERVATION_UPDATED" });
    for (let version = 1; version <= 4; version += 1) await createOutbox({ restaurantId: restaurantB, reservationId: reservationB, actorUserId: userB, reservationVersion: version, eventType: "RESERVATION_UPDATED" });
    const claimed = await new PrismaNotificationWorkerRepository().claimDue({ now: baseNow, batchSize: 25, maxPerTenant: 5, leaseMilliseconds: 120_000 });
    expect(claimed).toHaveLength(9);
    expect(claimed.filter((row) => row.restaurantId === restaurantA)).toHaveLength(5);
    expect(claimed.filter((row) => row.restaurantId === restaurantB)).toHaveLength(4);
  });

  it("does not let a later immediate lifecycle group pass an earlier claimed group", async () => {
    await createOutbox({ reservationVersion: 1, eventType: "RESERVATION_CONFIRMED", availableAt: new Date(baseNow.getTime() - 2_000) });
    await createOutbox({ reservationVersion: 2, eventType: "RESERVATION_UPDATED", availableAt: new Date(baseNow.getTime() - 1_000) });
    const repository = new PrismaNotificationWorkerRepository();
    const first = await repository.claimDue({ now: baseNow, batchSize: 1, maxPerTenant: 5, leaseMilliseconds: 120_000 });
    expect(first[0]?.reservationVersion).toBe(1);
    await expect(repository.claimDue({ now: baseNow, batchSize: 25, maxPerTenant: 5, leaseMilliseconds: 120_000 })).resolves.toHaveLength(0);
  });

  it("does not let a future reminder block an immediate lifecycle event", async () => {
    await createOutbox({ reservationVersion: 1, eventType: "RESERVATION_REMINDER", scheduledAt: new Date(baseNow.getTime() + 3_600_000), availableAt: new Date(baseNow.getTime() + 3_600_000) });
    await createOutbox({ reservationVersion: 2, eventType: "RESERVATION_UPDATED" });
    const claimed = await new PrismaNotificationWorkerRepository().claimDue({ now: baseNow, batchSize: 25, maxPerTenant: 5, leaseMilliseconds: 120_000 });
    expect(claimed.map((row) => row.eventType)).toEqual(["RESERVATION_UPDATED"]);
  });

  it("reclaims a lease without an attempt and abandons an incomplete attempt", async () => {
    await createOutbox({});
    const repository = new PrismaNotificationWorkerRepository();
    const [claimed] = await repository.claimDue({ now: baseNow, batchSize: 1, maxPerTenant: 5, leaseMilliseconds: 120_000 });
    expect(claimed).toBeDefined();
    const attempt = await repository.startAttempt({ notification: claimed!, attemptCorrelationId: randomUUID(), now: baseNow });
    expect(attempt).not.toBeNull();
    await expect(repository.recoverExpiredLeases(new Date(baseNow.getTime() + 120_001))).resolves.toBe(1);
    await expect(prisma.notificationAttempt.findFirstOrThrow()).resolves.toMatchObject({ outcome: "ABANDONED", failureCode: "WORKER_INTERRUPTED" });
    await expect(prisma.notificationOutbox.findUniqueOrThrow({ where: { id: claimed!.id } })).resolves.toMatchObject({ status: "PENDING", attemptCount: 1, leaseToken: null });
    await expect(repository.finalizeAttempt({ attempt: attempt!, result: { type: "SUCCESS", providerReference: "stale", deduplicated: false }, now: new Date(baseNow.getTime() + 120_002), nextAvailableAt: null, terminalFailureCode: null })).resolves.toBe("STALE");
  });

  it("requeues an expired lease that crashed before an attempt started", async () => {
    const row = await createOutbox({});
    const repository = new PrismaNotificationWorkerRepository();
    await repository.claimDue({ now: baseNow, batchSize: 1, maxPerTenant: 5, leaseMilliseconds: 120_000 });
    await expect(repository.recoverExpiredLeases(new Date(baseNow.getTime() + 120_001))).resolves.toBe(1);
    await expect(prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({ status: "PENDING", attemptCount: 0, leaseToken: null });
    await expect(prisma.notificationAttempt.count({ where: { outboxId: row.id } })).resolves.toBe(0);
  });

  it("replays a crash after receipt with one receipt and a deduplicated second attempt", async () => {
    await createOutbox({});
    const repository = new PrismaNotificationWorkerRepository();
    const provider = new SimulatedWhatsAppProvider({ type: "TIMEOUT_AFTER_RECEIPT" });
    const [claimed] = await repository.claimDue({ now: baseNow, batchSize: 1, maxPerTenant: 5, leaseMilliseconds: 120_000 });
    const firstAttempt = await repository.startAttempt({ notification: claimed!, attemptCorrelationId: randomUUID(), now: baseNow });
    expect(firstAttempt).not.toBeNull();
    await expect(repository.confirmProviderCall({ attempt: firstAttempt!, now: baseNow })).resolves.toBe(true);
    await expect(
      provider.send(
        {
          destination: claimed!.destination,
          message: toVersionedMessage(claimed!.payload),
          idempotencyKey: claimed!.idempotencyKey,
          correlationId: firstAttempt!.attemptCorrelationId,
          context: {
            restaurantId: claimed!.restaurantId,
            outboxId: claimed!.id,
            providerKind: firstAttempt!.providerKind,
          },
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      type: "TRANSIENT_FAILURE",
      failureCode: "SIMULATED_TIMEOUT",
    });

    const replayAt = new Date(baseNow.getTime() + 120_001);
    await repository.recoverExpiredLeases(replayAt);
    const [reclaimed] = await repository.claimDue({ now: replayAt, batchSize: 1, maxPerTenant: 5, leaseMilliseconds: 120_000 });
    await processClaimedNotification({
      dependencies: {
        repository,
        whatsappProvider: provider,
        emailProvider: new SimulatedEmailProvider(),
        clock: { now: () => replayAt },
        sleeper: testSleeper,
      },
      notification: reclaimed!,
      attemptCorrelationId: randomUUID(),
      signal: new AbortController().signal,
    });

    await expect(prisma.notificationSimulationReceipt.count({ where: { outboxId: claimed!.id } })).resolves.toBe(1);
    expect(await prisma.notificationAttempt.findMany({ where: { outboxId: claimed!.id }, orderBy: { attemptNumber: "asc" }, select: { outcome: true, deduplicated: true } })).toEqual([
      { outcome: "ABANDONED", deduplicated: null },
      { outcome: "SUCCESS", deduplicated: true },
    ]);
    await expect(prisma.notificationOutbox.findUniqueOrThrow({ where: { id: claimed!.id } })).resolves.toMatchObject({ status: "SUCCEEDED", attemptCount: 2 });
  });

  it("creates fallback atomically only after permanent WhatsApp failure", async () => {
    const group = randomUUID();
    await createOutbox({ strategy: "WHATSAPP_WITH_EMAIL_FALLBACK", eventGroupId: group });
    await processDueNotificationBatch(worker({ now: baseNow, whatsapp: new SimulatedWhatsAppProvider({ type: "PERMANENT" }) }));
    const legs = await prisma.notificationOutbox.findMany({ where: { eventGroupId: group }, orderBy: { channel: "desc" }, select: { channel: true, status: true, terminalFailureCode: true, attemptCount: true } });
    expect(legs).toEqual([
      { channel: "EMAIL", status: "PENDING", terminalFailureCode: null, attemptCount: 0 },
      { channel: "WHATSAPP", status: "DEAD", terminalFailureCode: "SIMULATED_PERMANENT_FAILURE", attemptCount: 1 },
    ]);
  });

  it("does not create fallback after WhatsApp success", async () => {
    const group = randomUUID();
    await createOutbox({ strategy: "WHATSAPP_WITH_EMAIL_FALLBACK", eventGroupId: group });
    await processDueNotificationBatch(worker({ now: baseNow }));
    await expect(prisma.notificationOutbox.findMany({ where: { eventGroupId: group }, select: { channel: true, status: true } })).resolves.toEqual([
      { channel: "WHATSAPP", status: "SUCCEEDED" },
    ]);
  });

  it("retries transient WhatsApp on 1/5/15 minutes before creating fallback at exhaustion", async () => {
    const group = randomUUID();
    const provider = new SimulatedWhatsAppProvider({ type: "TRANSIENT_THEN_SUCCESS", failures: 10 });
    const times = [
      baseNow,
      new Date(baseNow.getTime() + 60_000),
      new Date(baseNow.getTime() + 6 * 60_000),
      new Date(baseNow.getTime() + 21 * 60_000),
    ];
    await createOutbox({ strategy: "WHATSAPP_WITH_EMAIL_FALLBACK", eventGroupId: group });
    for (let attempt = 0; attempt < times.length; attempt += 1) {
      await processDueNotificationBatch(worker({ now: times[attempt]!, whatsapp: provider }));
      const emailCount = await prisma.notificationOutbox.count({ where: { eventGroupId: group, channel: "EMAIL" } });
      expect(emailCount).toBe(attempt === 3 ? 1 : 0);
    }
    await expect(prisma.notificationOutbox.findFirstOrThrow({ where: { eventGroupId: group, channel: "WHATSAPP" } })).resolves.toMatchObject({ status: "DEAD", attemptCount: 4, terminalFailureCode: "RETRY_EXHAUSTED" });
  });

  it("processes parallel channel legs independently", async () => {
    const group = randomUUID();
    await createOutbox({ strategy: "WHATSAPP_AND_EMAIL_PARALLEL", eventGroupId: group, channel: "WHATSAPP" });
    await createOutbox({ strategy: "WHATSAPP_AND_EMAIL_PARALLEL", eventGroupId: group, channel: "EMAIL" });
    const result = await processDueNotificationBatch(worker({ now: baseNow }));
    expect(result).toEqual({ expired: 0, recovered: 0, claimed: 2, processed: 2, failed: 0 });
    expect(await prisma.notificationOutbox.findMany({ where: { eventGroupId: group }, orderBy: { channel: "asc" }, select: { channel: true, status: true, attemptCount: true } })).toEqual([
      { channel: "WHATSAPP", status: "SUCCEEDED", attemptCount: 1 },
      { channel: "EMAIL", status: "SUCCEEDED", attemptCount: 1 },
    ]);
    await expect(prisma.notificationSimulationReceipt.count({ where: { restaurantId: restaurantA } })).resolves.toBe(2);
  });

  it("terminalizes expired pending legs without attempts, provider calls or fallback", async () => {
    const group = randomUUID();
    let providerCalls = 0;
    const provider: NotificationProvider = {
      send: async () => {
        providerCalls += 1;
        return {
          type: "SUCCESS",
          providerReference: "unexpected",
          deduplicated: false,
        };
      },
    };
    const row = await createOutbox({
      strategy: "WHATSAPP_WITH_EMAIL_FALLBACK",
      eventGroupId: group,
      scheduledAt: new Date(baseNow.getTime() - 2 * 60 * 60_000),
      availableAt: new Date(baseNow.getTime() - 2 * 60 * 60_000),
      expiresAt: baseNow,
    });

    await expect(
      processDueNotificationBatch(
        worker({ now: baseNow, whatsapp: provider, email: provider }),
      ),
    ).resolves.toEqual({
      expired: 1,
      recovered: 0,
      claimed: 0,
      processed: 0,
      failed: 0,
    });
    await expect(
      prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } }),
    ).resolves.toMatchObject({
      status: "DEAD",
      terminalAt: baseNow,
      terminalFailureCode: "EXPIRED",
      attemptCount: 0,
      claimedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(providerCalls).toBe(0);
    await expect(
      prisma.notificationAttempt.count({ where: { outboxId: row.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationOutbox.count({
        where: { eventGroupId: group, channel: "EMAIL" },
      }),
    ).resolves.toBe(0);
  });

  it("sweeps expired pending legs with a deterministic bounded concurrent claim", async () => {
    const repository = new PrismaNotificationWorkerRepository();
    const scheduledAt = new Date(baseNow.getTime() - 3 * 60 * 60_000);
    const earlierExpiry = new Date(baseNow.getTime() - 2 * 60 * 60_000);
    const laterExpiry = new Date(baseNow.getTime() - 60 * 60_000);
    for (let version = 1; version <= 105; version += 1) {
      await createOutbox({
        reservationVersion: version,
        eventType: "RESERVATION_UPDATED",
        strategy: "WHATSAPP_WITH_EMAIL_FALLBACK",
        scheduledAt,
        availableAt: scheduledAt,
        expiresAt: version <= 100 ? earlierExpiry : laterExpiry,
      });
    }

    await expect(
      repository.expirePending({ now: baseNow, limit: 1_000 }),
    ).resolves.toBe(100);
    const remaining = await prisma.notificationOutbox.findMany({
      where: { status: "PENDING" },
      select: { expiresAt: true },
    });
    expect(remaining).toHaveLength(5);
    expect(remaining.every((row) => row.expiresAt.getTime() === laterExpiry.getTime())).toBe(true);
    await expect(
      repository.expirePending({ now: baseNow, limit: 100 }),
    ).resolves.toBe(5);
    await expect(
      repository.expirePending({ now: baseNow, limit: 100 }),
    ).resolves.toBe(0);

    for (let version = 201; version <= 202; version += 1) {
      await createOutbox({
        reservationVersion: version,
        eventType: "RESERVATION_UPDATED",
        scheduledAt,
        availableAt: scheduledAt,
        expiresAt: laterExpiry,
      });
    }
    const swept = await Promise.all([
      repository.expirePending({ now: baseNow, limit: 100 }),
      repository.expirePending({ now: baseNow, limit: 100 }),
    ]);
    expect(swept.reduce((total, value) => total + value, 0)).toBe(2);
    await expect(
      prisma.notificationOutbox.count({ where: { status: "PENDING" } }),
    ).resolves.toBe(0);
    await expect(prisma.notificationAttempt.count()).resolves.toBe(0);
    await expect(
      prisma.notificationOutbox.count({ where: { channel: "EMAIL" } }),
    ).resolves.toBe(0);
  });

  it("rolls back primary terminalization when fallback insertion fails and recovers cleanly", async () => {
    const group = randomUUID();
    const suffix = randomUUID().replaceAll("-", "");
    const triggerName = `m12_fail_email_${suffix}`;
    const functionName = `m12_fail_email_fn_${suffix}`;
    const repository = new PrismaNotificationWorkerRepository();
    const reservationBefore = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservationA },
    });
    await createOutbox({
      strategy: "WHATSAPP_WITH_EMAIL_FALLBACK",
      eventGroupId: group,
    });
    const [claimed] = await repository.claimDue({
      now: baseNow,
      batchSize: 1,
      maxPerTenant: 5,
      leaseMilliseconds: 120_000,
    });
    const attempt = await repository.startAttempt({
      notification: claimed!,
      attemptCorrelationId: randomUUID(),
      now: baseNow,
    });
    await expect(
      repository.confirmProviderCall({ attempt: attempt!, now: baseNow }),
    ).resolves.toBe(true);
    const provider = new SimulatedWhatsAppProvider({ type: "PERMANENT" });
    const providerResult = await provider.send(
      {
        destination: claimed!.destination,
        message: toVersionedMessage(claimed!.payload),
        idempotencyKey: claimed!.idempotencyKey,
        correlationId: attempt!.attemptCorrelationId,
        context: {
          restaurantId: claimed!.restaurantId,
          outboxId: claimed!.id,
          providerKind: attempt!.providerKind,
        },
      },
      { signal: new AbortController().signal },
    );
    if (providerResult.type !== "PERMANENT_FAILURE") {
      throw new Error("The permanent provider fixture returned an invalid result.");
    }

    try {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_group_id = '${group}'::uuid AND NEW.channel = 'EMAIL' THEN
            RAISE EXCEPTION 'm12-test-fallback-insert-failure';
          END IF;
          RETURN NEW;
        END;
        $$
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}"
        BEFORE INSERT ON notification_outbox
        FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
      `);

      await expect(
        repository.finalizeAttempt({
          attempt: attempt!,
          result: providerResult,
          now: baseNow,
          nextAvailableAt: null,
          terminalFailureCode: providerResult.failureCode,
        }),
      ).rejects.toThrow();
      await expect(
        prisma.notificationOutbox.count({
          where: { eventGroupId: group, channel: "EMAIL" },
        }),
      ).resolves.toBe(0);
      await expect(
        prisma.notificationOutbox.findUniqueOrThrow({
          where: { id: claimed!.id },
        }),
      ).resolves.toMatchObject({
        status: "CLAIMED",
        terminalAt: null,
        terminalFailureCode: null,
        leaseToken: claimed!.leaseToken,
      });
      await expect(
        prisma.notificationAttempt.findFirstOrThrow({
          where: { outboxId: claimed!.id, attemptNumber: 1 },
        }),
      ).resolves.toMatchObject({ completedAt: null, outcome: null });
      expect(
        await prisma.reservation.findUniqueOrThrow({ where: { id: reservationA } }),
      ).toEqual(reservationBefore);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON notification_outbox`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "${functionName}"()`,
      );
    }

    const helpers = await prisma.$queryRaw<Array<{ helper_count: bigint }>>`
      SELECT (
        (SELECT COUNT(*) FROM pg_trigger WHERE tgname = ${triggerName})
        + (SELECT COUNT(*) FROM pg_proc WHERE proname = ${functionName})
      ) AS helper_count
    `;
    expect(helpers[0]?.helper_count).toBe(BigInt(0));

    const replayAt = new Date(baseNow.getTime() + 120_001);
    await expect(repository.recoverExpiredLeases(replayAt)).resolves.toBe(1);
    await expect(
      repository.finalizeAttempt({
        attempt: attempt!,
        result: {
          type: "SUCCESS",
          providerReference: "stale",
          deduplicated: false,
        },
        now: replayAt,
        nextAvailableAt: null,
        terminalFailureCode: null,
      }),
    ).resolves.toBe("STALE");
    const [reclaimed] = await repository.claimDue({
      now: replayAt,
      batchSize: 1,
      maxPerTenant: 5,
      leaseMilliseconds: 120_000,
    });
    await processClaimedNotification({
      dependencies: {
        repository,
        whatsappProvider: provider,
        emailProvider: new SimulatedEmailProvider(),
        clock: { now: () => replayAt },
        sleeper: testSleeper,
      },
      notification: reclaimed!,
      attemptCorrelationId: randomUUID(),
      signal: new AbortController().signal,
    });
    await processDueNotificationBatch(worker({ now: replayAt }));

    const legs = await prisma.notificationOutbox.findMany({
      where: { eventGroupId: group },
      orderBy: { channel: "desc" },
      select: { channel: true, status: true, attemptCount: true },
    });
    expect(legs).toEqual([
      { channel: "EMAIL", status: "SUCCEEDED", attemptCount: 1 },
      { channel: "WHATSAPP", status: "DEAD", attemptCount: 2 },
    ]);
    await expect(
      prisma.notificationOutbox.count({
        where: { eventGroupId: group, channel: "EMAIL" },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationAttempt.findMany({
        where: { outboxId: claimed!.id },
        orderBy: { attemptNumber: "asc" },
        select: { outcome: true },
      }),
    ).resolves.toEqual([
      { outcome: "ABANDONED" },
      { outcome: "PERMANENT_FAILURE" },
    ]);
    expect(
      await prisma.reservation.findUniqueOrThrow({ where: { id: reservationA } }),
    ).toEqual(reservationBefore);
  });

  it("cancels before a provider call and preserves success during a provider-call race", async () => {
    const repository = new PrismaNotificationWorkerRepository();
    const before = await createOutbox({});
    const [claimedBefore] = await repository.claimDue({ now: baseNow, batchSize: 1, maxPerTenant: 5, leaseMilliseconds: 120_000 });
    await prisma.notificationOutbox.update({ where: { id: before.id }, data: { cancelRequestedAt: baseNow, cancellationReason: "RESERVATION_CANCELLED" } });
    await expect(repository.startAttempt({ notification: claimedBefore!, attemptCorrelationId: randomUUID(), now: baseNow })).resolves.toBeNull();
    await expect(prisma.notificationOutbox.findUniqueOrThrow({ where: { id: before.id } })).resolves.toMatchObject({ status: "CANCELLED", attemptCount: 0 });

    const during = await createOutbox({ reservationVersion: 2, eventType: "RESERVATION_UPDATED" });
    const [claimedDuring] = await repository.claimDue({ now: baseNow, batchSize: 1, maxPerTenant: 5, leaseMilliseconds: 120_000 });
    const attempt = await repository.startAttempt({ notification: claimedDuring!, attemptCorrelationId: randomUUID(), now: baseNow });
    await expect(repository.confirmProviderCall({ attempt: attempt!, now: baseNow })).resolves.toBe(true);
    await prisma.notificationOutbox.update({ where: { id: during.id }, data: { cancelRequestedAt: baseNow, cancellationReason: "SUPERSEDED" } });
    await expect(repository.finalizeAttempt({ attempt: attempt!, result: { type: "SUCCESS", providerReference: "sim-race-success", deduplicated: false }, now: baseNow, nextAvailableAt: null, terminalFailureCode: null })).resolves.toBe("SUCCEEDED");
    await expect(prisma.notificationOutbox.findUniqueOrThrow({ where: { id: during.id } })).resolves.toMatchObject({ status: "SUCCEEDED", cancelRequestedAt: baseNow });
  });

  it("cancels without retry when a provider-call race ends in failure", async () => {
    const repository = new PrismaNotificationWorkerRepository();
    const row = await createOutbox({});
    const [claimed] = await repository.claimDue({ now: baseNow, batchSize: 1, maxPerTenant: 5, leaseMilliseconds: 120_000 });
    const attempt = await repository.startAttempt({ notification: claimed!, attemptCorrelationId: randomUUID(), now: baseNow });
    await repository.confirmProviderCall({ attempt: attempt!, now: baseNow });
    await prisma.notificationOutbox.update({ where: { id: row.id }, data: { cancelRequestedAt: baseNow, cancellationReason: "SUPERSEDED" } });
    await expect(repository.finalizeAttempt({ attempt: attempt!, result: { type: "TRANSIENT_FAILURE", failureCode: "SIMULATED_TIMEOUT" }, now: baseNow, nextAvailableAt: new Date(baseNow.getTime() + 60_000), terminalFailureCode: null })).resolves.toBe("CANCELLED");
    await expect(prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({ status: "CANCELLED", attemptCount: 1, availableAt: baseNow });
  });

  it("makes a missing fallback email terminal without a provider attempt", async () => {
    await prisma.reservation.update({ where: { id: reservationA }, data: { customerEmail: null } });
    try {
      const group = randomUUID();
      await createOutbox({ strategy: "WHATSAPP_WITH_EMAIL_FALLBACK", eventGroupId: group });
      await processDueNotificationBatch(worker({ now: baseNow, whatsapp: new SimulatedWhatsAppProvider({ type: "PERMANENT" }) }));
      await expect(prisma.notificationOutbox.findFirstOrThrow({ where: { eventGroupId: group, channel: "EMAIL" } })).resolves.toMatchObject({ status: "DEAD", destination: null, terminalFailureCode: "DESTINATION_UNAVAILABLE", attemptCount: 0 });
    } finally {
      await prisma.reservation.update({ where: { id: reservationA }, data: { customerEmail: "ada@example.test" } });
    }
  });

  it("keeps reservation state unchanged when the provider fails after commit", async () => {
    const before = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationA } });
    await createOutbox({});
    await processDueNotificationBatch(worker({ now: baseNow, whatsapp: new SimulatedWhatsAppProvider({ type: "PERMANENT" }) }));
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: reservationA } })).toEqual(before);
    await expect(prisma.notificationOutbox.findFirstOrThrow()).resolves.toMatchObject({ status: "DEAD", terminalFailureCode: "SIMULATED_PERMANENT_FAILURE" });
    await expect(prisma.notificationAttempt.findFirstOrThrow()).resolves.toMatchObject({ outcome: "PERMANENT_FAILURE" });
  });
});
