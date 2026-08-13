import "server-only";

import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import {
  localDateToDatabase,
  operationalTimeToDatabase,
} from "@/modules/configuration/domain/operational-time";
import type { OperationalChangeProposal } from "@/modules/configuration/domain/operational-change";
import { prisma } from "@/server/db/prisma";
import {
  isRetryableTransactionConflict,
  waitForTransactionRetry,
} from "@/server/db/transaction-retry";

const CONFIGURATION_LOCK_NAMESPACE = "operational-configuration-v1";

export type OperationalConfigurationClient = Prisma.TransactionClient;

function configurationLockKey(
  restaurantId: string,
): readonly [number, number] {
  const digest = createHash("sha256")
    .update(`${CONFIGURATION_LOCK_NAMESPACE}\u0000${restaurantId}`, "utf8")
    .digest();

  return [digest.readInt32BE(0), digest.readInt32BE(4)] as const;
}

export async function acquireOperationalConfigurationLock(
  client: OperationalConfigurationClient,
  restaurantId: string,
): Promise<void> {
  const [firstKey, secondKey] = configurationLockKey(restaurantId);
  const rows = await client.$queryRaw<Array<{ locked: number }>>(
    Prisma.sql`
      WITH lock_acquired AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(${firstKey}, ${secondKey}) AS ignored
      )
      SELECT 1::integer AS locked
      FROM lock_acquired
    `,
  );

  if (rows[0]?.locked !== 1) {
    throw new Error("PostgreSQL configuration lock was not acquired.");
  }
}

export async function runOperationalConfigurationTransaction<T>(
  callback: (client: OperationalConfigurationClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await prisma.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 20_000,
      });
    } catch (error) {
      const shouldRetry =
        isRetryableTransactionConflict(error) && attempt < 5;

      if (!shouldRetry) throw error;
      await waitForTransactionRetry(attempt);
    }
  }

  throw new Error("Operational configuration transaction retry exhausted.");
}

export async function readOperationalConfigurationContext(
  client: OperationalConfigurationClient,
  restaurantId: string,
  localToday: string,
) {
  const restaurant = await client.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      name: true,
      timezone: true,
      bookingSettings: true,
      weeklySchedules: {
        orderBy: [{ dayOfWeek: "asc" }, { serviceType: "asc" }],
      },
      bookingCutoffRules: {
        orderBy: [{ dayOfWeek: "asc" }, { serviceType: "asc" }],
      },
    },
  });

  if (!restaurant) return null;

  const [reservations, specialDateOverrides] = await Promise.all([
    client.reservation.findMany({
      where: {
        restaurantId,
        localDate: { gte: localDateToDatabase(localToday) },
        status: "CONFIRMED",
      },
      select: {
        id: true,
        localDate: true,
        serviceType: true,
        arrivalTime: true,
        partySize: true,
        origin: true,
        status: true,
        version: true,
        updatedAt: true,
      },
      orderBy: [
        { localDate: "asc" },
        { serviceType: "asc" },
        { arrivalTime: "asc" },
        { id: "asc" },
      ],
    }),
    client.specialDateOverride.findMany({
      where: {
        restaurantId,
        date: { gte: localDateToDatabase(localToday) },
        archivedAt: null,
      },
      select: {
        id: true,
        date: true,
        scope: true,
        isClosed: true,
        specialStartTime: true,
        specialEndTime: true,
        specialCapacityCovers: true,
        updatedAt: true,
      },
      orderBy: [{ date: "asc" }, { scope: "asc" }],
    }),
  ]);

  return { restaurant, reservations, specialDateOverrides };
}

export async function applyOperationalProposal(
  client: OperationalConfigurationClient,
  restaurantId: string,
  proposal: OperationalChangeProposal,
) {
  if (proposal.kind === "BOOKING_SETTINGS") {
    const result = await client.restaurantBookingSettings.updateMany({
      where: { restaurantId },
      data: {
        rollingCapacityCovers: proposal.rollingCapacityCovers,
        rollingWindowMinutes: 30,
        lunchModificationCutoff: operationalTimeToDatabase(
          proposal.lunchModificationCutoff,
        ),
        dinnerModificationCutoff: operationalTimeToDatabase(
          proposal.dinnerModificationCutoff,
        ),
      },
    });

    if (result.count !== 1) return null;
    return client.restaurantBookingSettings.findUnique({
      where: { restaurantId },
    });
  }

  if (proposal.kind === "WEEKLY_SCHEDULE") {
    const result = await client.weeklyServiceSchedule.updateMany({
      where: {
        id: proposal.id,
        restaurantId,
        dayOfWeek: proposal.dayOfWeek,
        serviceType: proposal.serviceType,
      },
      data: {
        isEnabled: proposal.isEnabled,
        startTime: operationalTimeToDatabase(proposal.startTime),
        endTime: operationalTimeToDatabase(proposal.endTime),
        slotIntervalMinutes: 15,
      },
    });

    if (result.count !== 1) return null;
    return client.weeklyServiceSchedule.findFirst({
      where: { id: proposal.id, restaurantId },
    });
  }

  return client.bookingCutoffRule.upsert({
    where: {
      restaurantId_dayOfWeek_serviceType: {
        restaurantId,
        dayOfWeek: proposal.dayOfWeek,
        serviceType: proposal.serviceType,
      },
    },
    update: {
      isEnabled: proposal.isEnabled,
      cutoffTime: operationalTimeToDatabase(proposal.cutoffTime),
    },
    create: {
      restaurantId,
      dayOfWeek: proposal.dayOfWeek,
      serviceType: proposal.serviceType,
      isEnabled: proposal.isEnabled,
      cutoffTime: operationalTimeToDatabase(proposal.cutoffTime),
    },
  });
}
