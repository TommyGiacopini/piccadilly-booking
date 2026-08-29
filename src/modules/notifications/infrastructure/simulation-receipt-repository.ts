import "server-only";

import { createHash } from "node:crypto";

import type { NotificationProviderKind } from "@/modules/notifications/domain/types";
import { prisma } from "@/server/db/prisma";

export type SimulationReceiptResult =
  | { type: "RECEIPT"; providerReference: string; deduplicated: boolean }
  | { type: "CONFLICT" };

function providerReference(input: {
  restaurantId: string;
  idempotencyKey: string;
  providerKind: NotificationProviderKind;
}): string {
  const suffix = createHash("sha256")
    .update(
      `${input.restaurantId}\u0000${input.idempotencyKey}\u0000${input.providerKind}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 48);
  return `sim-${input.providerKind === "SIMULATED_WHATSAPP" ? "wa" : "email"}-${suffix}`;
}

export async function createOrReadSimulationReceipt(input: {
  restaurantId: string;
  outboxId: string;
  providerKind: NotificationProviderKind;
  idempotencyKey: string;
  payloadHash: string;
}): Promise<SimulationReceiptResult> {
  const advisoryLockKey = JSON.stringify([
    input.restaurantId,
    input.idempotencyKey,
  ]);
  return prisma.$transaction(async (client) => {
    const lock = await client.$queryRaw<Array<{ locked: number }>>`
      WITH lock_acquired AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(
          hashtextextended(${advisoryLockKey}, 0)
        ) AS ignored
      )
      SELECT 1::integer AS locked
      FROM lock_acquired
    `;
    if (lock[0]?.locked !== 1) {
      throw new Error("PostgreSQL notification receipt lock was not acquired.");
    }
    const existing = await client.notificationSimulationReceipt.findUnique({
      where: {
        restaurantId_idempotencyKey: {
          restaurantId: input.restaurantId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      return existing.payloadHash === input.payloadHash &&
        existing.providerKind === input.providerKind
        ? {
            type: "RECEIPT" as const,
            providerReference: existing.providerReference,
            deduplicated: true,
          }
        : { type: "CONFLICT" as const };
    }
    const reference = providerReference(input);
    await client.notificationSimulationReceipt.create({
      data: {
        restaurantId: input.restaurantId,
        outboxId: input.outboxId,
        providerKind: input.providerKind,
        idempotencyKey: input.idempotencyKey,
        payloadHash: input.payloadHash,
        providerReference: reference,
      },
    });
    return {
      type: "RECEIPT" as const,
      providerReference: reference,
      deduplicated: false,
    };
  });
}
