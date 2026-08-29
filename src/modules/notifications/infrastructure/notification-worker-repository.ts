import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import type {
  ClaimedNotification,
  NotificationProviderResult,
  NotificationWorkerRepository,
  StartedNotificationAttempt,
} from "@/modules/notifications/application/ports";
import { notificationIdempotencyKey } from "@/modules/notifications/domain/delivery-policy";
import { parseNotificationPayload } from "@/modules/notifications/domain/notification-rules";
import type {
  NotificationFailureCode,
  NotificationProviderKind,
} from "@/modules/notifications/domain/types";
import { prisma } from "@/server/db/prisma";

interface LockedIdRow {
  id: string;
}

const transactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 10_000,
  timeout: 20_000,
} as const;

function providerKind(channel: "WHATSAPP" | "EMAIL"): NotificationProviderKind {
  return channel === "WHATSAPP"
    ? "SIMULATED_WHATSAPP"
    : "SIMULATED_EMAIL";
}

async function lockClaimed(
  client: Prisma.TransactionClient,
  input: { id: string; restaurantId: string; leaseToken: string },
): Promise<boolean> {
  const rows = await client.$queryRaw<LockedIdRow[]>(Prisma.sql`
    SELECT id
    FROM notification_outbox
    WHERE id = ${input.id}::uuid
      AND restaurant_id = ${input.restaurantId}::uuid
      AND status = 'CLAIMED'
      AND lease_token = ${input.leaseToken}::uuid
    FOR UPDATE
  `);
  return rows.length === 1;
}

function toClaimedNotification(row: {
  id: string;
  restaurantId: string;
  reservationId: string;
  reservationVersion: number;
  eventGroupId: string;
  eventType: ClaimedNotification["eventType"];
  channel: ClaimedNotification["channel"];
  strategy: ClaimedNotification["strategy"];
  destination: string | null;
  payload: unknown;
  expiresAt: Date;
  attemptCount: number;
  maxAttempts: number;
  idempotencyKey: string;
  originCorrelationId: string;
  leaseToken: string | null;
}): ClaimedNotification {
  if (!row.destination || !row.leaseToken) {
    throw new Error("Claimed notification is missing required delivery fields.");
  }
  return {
    id: row.id,
    restaurantId: row.restaurantId,
    reservationId: row.reservationId,
    reservationVersion: row.reservationVersion,
    eventGroupId: row.eventGroupId,
    eventType: row.eventType,
    channel: row.channel,
    strategy: row.strategy,
    destination: row.destination,
    payload: parseNotificationPayload(row.payload),
    expiresAt: row.expiresAt,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    idempotencyKey: row.idempotencyKey,
    originCorrelationId: row.originCorrelationId,
    leaseToken: row.leaseToken,
  };
}

async function createFallbackEmail(
  client: Prisma.TransactionClient,
  input: {
    id: string;
    restaurantId: string;
    reservationId: string;
    eventGroupId: string;
    reservationVersion: number;
    eventType: ClaimedNotification["eventType"];
    source: "PUBLIC" | "PHONE" | "STAFF";
    actorUserId: string | null;
    strategy: ClaimedNotification["strategy"];
    payload: unknown;
    expiresAt: Date;
    originCorrelationId: string;
    reservation: { customerEmail: string | null };
  },
  now: Date,
): Promise<void> {
  if (
    input.strategy !== "WHATSAPP_WITH_EMAIL_FALLBACK" ||
    input.expiresAt.getTime() <= now.getTime()
  ) {
    return;
  }
  const unavailable = input.reservation.customerEmail === null;
  await client.notificationOutbox.create({
    data: {
      restaurantId: input.restaurantId,
      reservationId: input.reservationId,
      eventGroupId: input.eventGroupId,
      reservationVersion: input.reservationVersion,
      eventType: input.eventType,
      source: input.source,
      actorUserId: input.actorUserId,
      channel: "EMAIL",
      strategy: input.strategy,
      destination: input.reservation.customerEmail,
      payloadVersion: 1,
      payload: input.payload as Prisma.InputJsonValue,
      scheduledAt: now,
      availableAt: now,
      expiresAt: input.expiresAt,
      status: unavailable ? "DEAD" : "PENDING",
      attemptCount: 0,
      maxAttempts: 4,
      retryPolicyVersion: 1,
      idempotencyKey: notificationIdempotencyKey({
        restaurantId: input.restaurantId,
        reservationId: input.reservationId,
        reservationVersion: input.reservationVersion,
        eventType: input.eventType,
        channel: "EMAIL",
      }),
      originCorrelationId: input.originCorrelationId,
      terminalAt: unavailable ? now : null,
      terminalFailureCode: unavailable ? "DESTINATION_UNAVAILABLE" : null,
    },
  });
}

async function markTerminalAndFallback(
  client: Prisma.TransactionClient,
  current: NonNullable<
    Awaited<ReturnType<typeof readCurrentOutboxWithReservation>>
  >,
  failureCode: NotificationFailureCode,
  now: Date,
): Promise<void> {
  await client.notificationOutbox.update({
    where: { id: current.id },
    data: {
      status: "DEAD",
      terminalAt: now,
      terminalFailureCode: failureCode,
      claimedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  });
  if (current.channel === "WHATSAPP") {
    await createFallbackEmail(client, current, now);
  }
}

async function readCurrentOutboxWithReservation(
  client: Prisma.TransactionClient,
  id: string,
) {
  return client.notificationOutbox.findUnique({
    where: { id },
    include: { reservation: { select: { customerEmail: true } } },
  });
}

export class PrismaNotificationWorkerRepository
  implements NotificationWorkerRepository
{
  async expirePending(input: { now: Date; limit: number }): Promise<number> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 0), 100);
    if (limit === 0) return 0;
    return prisma.$transaction(async (client) => {
      const expired = await client.$queryRaw<LockedIdRow[]>(Prisma.sql`
        SELECT id
        FROM notification_outbox
        WHERE status = 'PENDING'
          AND expires_at <= ${input.now}
        ORDER BY expires_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      `);
      for (const { id } of expired) {
        await client.notificationOutbox.update({
          where: { id },
          data: {
            status: "DEAD",
            terminalAt: input.now,
            terminalFailureCode: "EXPIRED",
            claimedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
      }
      return expired.length;
    }, transactionOptions);
  }

  async recoverExpiredLeases(now: Date): Promise<number> {
    return prisma.$transaction(async (client) => {
      const expired = await client.$queryRaw<LockedIdRow[]>(Prisma.sql`
        SELECT id
        FROM notification_outbox
        WHERE status = 'CLAIMED'
          AND lease_expires_at <= ${now}
        ORDER BY lease_expires_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 100
      `);
      for (const { id } of expired) {
        const current = await readCurrentOutboxWithReservation(client, id);
        if (!current || current.status !== "CLAIMED") continue;
        const incomplete = await client.notificationAttempt.findFirst({
          where: { outboxId: id, restaurantId: current.restaurantId, outcome: null },
          orderBy: { attemptNumber: "desc" },
        });
        if (incomplete) {
          await client.notificationAttempt.update({
            where: { id: incomplete.id },
            data: {
              completedAt: now,
              outcome: "ABANDONED",
              failureCode: "WORKER_INTERRUPTED",
            },
          });
        }
        if (current.cancelRequestedAt) {
          await client.notificationOutbox.update({
            where: { id },
            data: {
              status: "CANCELLED",
              terminalAt: now,
              claimedAt: null,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
        } else if (current.expiresAt.getTime() <= now.getTime()) {
          await markTerminalAndFallback(client, current, "EXPIRED", now);
        } else {
          await client.notificationOutbox.update({
            where: { id },
            data: {
              status: "PENDING",
              availableAt: now,
              claimedAt: null,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
        }
      }
      return expired.length;
    }, transactionOptions);
  }

  async claimDue(input: {
    now: Date;
    batchSize: number;
    maxPerTenant: number;
    leaseMilliseconds: number;
  }): Promise<ClaimedNotification[]> {
    return prisma.$transaction(async (client) => {
      const selected = await client.$queryRaw<LockedIdRow[]>(Prisma.sql`
        WITH eligible AS MATERIALIZED (
          SELECT candidate.id,
                 candidate.restaurant_id,
                 candidate.available_at,
                 candidate.scheduled_at,
                 candidate.created_at,
                 row_number() OVER (
                   PARTITION BY candidate.restaurant_id
                   ORDER BY candidate.available_at, candidate.scheduled_at,
                            candidate.created_at, candidate.id
                 ) AS tenant_rank
          FROM notification_outbox AS candidate
          WHERE candidate.status = 'PENDING'
            AND candidate.available_at <= ${input.now}
            AND candidate.scheduled_at <= ${input.now}
            AND candidate.expires_at > ${input.now}
            AND NOT EXISTS (
              SELECT 1
              FROM notification_outbox AS earlier
              WHERE earlier.restaurant_id = candidate.restaurant_id
                AND earlier.reservation_id = candidate.reservation_id
                AND earlier.status = 'CLAIMED'
                AND earlier.event_type <> 'RESERVATION_REMINDER'
                AND candidate.event_type <> 'RESERVATION_REMINDER'
                AND earlier.reservation_version < candidate.reservation_version
            )
        )
        SELECT outbox.id
        FROM notification_outbox AS outbox
        INNER JOIN eligible ON eligible.id = outbox.id
        WHERE eligible.tenant_rank <= ${input.maxPerTenant}
        ORDER BY eligible.available_at, eligible.scheduled_at,
                 eligible.created_at, outbox.id
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT ${input.batchSize}
      `);
      const claimed: ClaimedNotification[] = [];
      for (const { id } of selected) {
        const leaseToken = randomUUID();
        const row = await client.notificationOutbox.update({
          where: { id },
          data: {
            status: "CLAIMED",
            claimedAt: input.now,
            leaseToken,
            leaseExpiresAt: new Date(
              input.now.getTime() + input.leaseMilliseconds,
            ),
          },
        });
        claimed.push(toClaimedNotification(row));
      }
      return claimed;
    }, transactionOptions);
  }

  async startAttempt(input: {
    notification: ClaimedNotification;
    attemptCorrelationId: string;
    now: Date;
  }): Promise<StartedNotificationAttempt | null> {
    return prisma.$transaction(async (client) => {
      if (!(await lockClaimed(client, {
        id: input.notification.id,
        restaurantId: input.notification.restaurantId,
        leaseToken: input.notification.leaseToken,
      }))) return null;
      const current = await readCurrentOutboxWithReservation(
        client,
        input.notification.id,
      );
      if (!current || current.status !== "CLAIMED") return null;
      if (current.cancelRequestedAt) {
        await client.notificationOutbox.update({
          where: { id: current.id },
          data: {
            status: "CANCELLED",
            terminalAt: input.now,
            claimedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return null;
      }
      if (current.expiresAt.getTime() <= input.now.getTime()) {
        await markTerminalAndFallback(client, current, "EXPIRED", input.now);
        return null;
      }
      if (current.attemptCount >= current.maxAttempts) {
        await markTerminalAndFallback(
          client,
          current,
          "RETRY_EXHAUSTED",
          input.now,
        );
        return null;
      }
      const attemptNumber = current.attemptCount + 1;
      const kind = providerKind(current.channel);
      await client.notificationAttempt.create({
        data: {
          restaurantId: current.restaurantId,
          outboxId: current.id,
          attemptNumber,
          providerKind: kind,
          attemptCorrelationId: input.attemptCorrelationId,
          startedAt: input.now,
        },
      });
      await client.notificationOutbox.update({
        where: { id: current.id },
        data: { attemptCount: attemptNumber },
      });
      return {
        notification: {
          ...input.notification,
          attemptCount: attemptNumber,
        },
        attemptNumber,
        attemptCorrelationId: input.attemptCorrelationId,
        providerKind: kind,
      };
    }, transactionOptions);
  }

  async confirmProviderCall(input: {
    attempt: StartedNotificationAttempt;
    now: Date;
  }): Promise<boolean> {
    return prisma.$transaction(async (client) => {
      if (!(await lockClaimed(client, {
        id: input.attempt.notification.id,
        restaurantId: input.attempt.notification.restaurantId,
        leaseToken: input.attempt.notification.leaseToken,
      }))) return false;
      const current = await client.notificationOutbox.findUnique({
        where: { id: input.attempt.notification.id },
      });
      if (!current || current.status !== "CLAIMED") return false;
      const attemptWhere = {
        restaurantId_outboxId_attemptNumber: {
          restaurantId: current.restaurantId,
          outboxId: current.id,
          attemptNumber: input.attempt.attemptNumber,
        },
      };
      if (current.expiresAt.getTime() <= input.now.getTime()) {
        await client.notificationAttempt.update({
          where: attemptWhere,
          data: {
            completedAt: input.now,
            outcome: "ABANDONED",
            failureCode: "EXPIRED",
          },
        });
        await client.notificationOutbox.update({
          where: { id: current.id },
          data: {
            status: "DEAD",
            terminalAt: input.now,
            terminalFailureCode: "EXPIRED",
            claimedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return false;
      }
      if (!current.cancelRequestedAt) return true;
      await client.notificationAttempt.update({
        where: attemptWhere,
        data: {
          completedAt: input.now,
          outcome: "ABANDONED",
          failureCode: "WORKER_INTERRUPTED",
        },
      });
      await client.notificationOutbox.update({
        where: { id: current.id },
        data: {
          status: "CANCELLED",
          terminalAt: input.now,
          claimedAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      return false;
    }, transactionOptions);
  }

  async finalizeAttempt(input: {
    attempt: StartedNotificationAttempt;
    result: NotificationProviderResult;
    now: Date;
    nextAvailableAt: Date | null;
    terminalFailureCode: NotificationFailureCode | null;
  }): Promise<"SUCCEEDED" | "PENDING" | "DEAD" | "CANCELLED" | "STALE"> {
    return prisma.$transaction(async (client) => {
      if (!(await lockClaimed(client, {
        id: input.attempt.notification.id,
        restaurantId: input.attempt.notification.restaurantId,
        leaseToken: input.attempt.notification.leaseToken,
      }))) return "STALE" as const;
      const current = await readCurrentOutboxWithReservation(
        client,
        input.attempt.notification.id,
      );
      if (!current || current.status !== "CLAIMED") return "STALE" as const;
      const attemptWhere = {
        restaurantId_outboxId_attemptNumber: {
          restaurantId: current.restaurantId,
          outboxId: current.id,
          attemptNumber: input.attempt.attemptNumber,
        },
      };
      const attempt = await client.notificationAttempt.findUnique({
        where: attemptWhere,
      });
      if (!attempt || attempt.outcome !== null) return "STALE" as const;

      if (input.result.type === "SUCCESS") {
        await client.notificationAttempt.update({
          where: attemptWhere,
          data: {
            completedAt: input.now,
            outcome: "SUCCESS",
            providerReference: input.result.providerReference,
            deduplicated: input.result.deduplicated,
          },
        });
        await client.notificationOutbox.update({
          where: { id: current.id },
          data: {
            status: "SUCCEEDED",
            terminalAt: input.now,
            claimedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return "SUCCEEDED" as const;
      }

      await client.notificationAttempt.update({
        where: attemptWhere,
        data: {
          completedAt: input.now,
          outcome:
            input.result.type === "TRANSIENT_FAILURE"
              ? "TRANSIENT_FAILURE"
              : "PERMANENT_FAILURE",
          failureCode: input.result.failureCode,
        },
      });

      if (current.cancelRequestedAt) {
        await client.notificationOutbox.update({
          where: { id: current.id },
          data: {
            status: "CANCELLED",
            terminalAt: input.now,
            claimedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return "CANCELLED" as const;
      }

      if (
        input.result.type === "TRANSIENT_FAILURE" &&
        input.terminalFailureCode === null &&
        input.nextAvailableAt
      ) {
        await client.notificationOutbox.update({
          where: { id: current.id },
          data: {
            status: "PENDING",
            availableAt: input.nextAvailableAt,
            claimedAt: null,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return "PENDING" as const;
      }

      await markTerminalAndFallback(
        client,
        current,
        input.terminalFailureCode ?? input.result.failureCode,
        input.now,
      );
      return "DEAD" as const;
    }, transactionOptions);
  }
}
