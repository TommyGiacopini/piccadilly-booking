import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { PrismaClient } from "../src/generated/prisma/client";
import {
  cleanupE2eReservations,
  e2eReservationFirstName,
} from "./cleanup-e2e-reservations";

const restaurantId = "00000000-0000-4000-8000-000000000001";

describe("E2E reservation cleanup boundary", () => {
  it("logically cancels only the exact current run and preserves sentinels", async () => {
    const currentRunId = randomUUID();
    const otherRunId = randomUUID();
    const reservations = [
      {
        id: randomUUID(),
        restaurantId,
        customerFirstName: e2eReservationFirstName(currentRunId),
        status: "CONFIRMED",
        version: 1,
      },
      {
        id: randomUUID(),
        restaurantId,
        customerFirstName: e2eReservationFirstName(otherRunId),
        status: "CONFIRMED",
        version: 1,
      },
      {
        id: randomUUID(),
        restaurantId,
        customerFirstName: "Cliente fittizio sentinella",
        status: "CONFIRMED",
        version: 1,
      },
    ];
    const relatedTechnicalData = {
      audits: [randomUUID()],
      tokens: [randomUUID()],
      consents: [randomUUID()],
      idempotencyKeys: [randomUUID()],
    };
    const technicalSnapshot = structuredClone(relatedTechnicalData);
    let receivedWhere: unknown;
    const client = {
      restaurant: {
        findUnique: async (args: { where: { id: string } }) =>
          args.where.id === restaurantId ? { id: restaurantId } : null,
      },
      reservation: {
        findMany: async (args: {
          where: {
            restaurantId: string;
            customerFirstName: string;
            status: string;
          };
        }) => {
          receivedWhere = args.where;
          return reservations
            .filter(
              (reservation) =>
                reservation.restaurantId === args.where.restaurantId &&
                reservation.customerFirstName === args.where.customerFirstName &&
                reservation.status === args.where.status,
            )
            .map(({ id, version }) => ({ id, version }));
        },
      },
    } as unknown as Pick<PrismaClient, "restaurant" | "reservation">;

    const cancel = async (fixture: { id: string; version: number }) => {
      const reservation = reservations.find(
        (candidate) => candidate.id === fixture.id,
      );
      if (!reservation || reservation.version !== fixture.version) {
        throw new Error("Unexpected cleanup fixture.");
      }
      reservation.status = "CANCELLED";
      reservation.version += 1;
    };

    await expect(
      cleanupE2eReservations(client, currentRunId, cancel),
    ).resolves.toBe(1);
    expect(receivedWhere).toEqual({
      restaurantId,
      customerFirstName: e2eReservationFirstName(currentRunId),
      status: "CONFIRMED",
    });
    expect(reservations.map(({ status }) => status)).toEqual([
      "CANCELLED",
      "CONFIRMED",
      "CONFIRMED",
    ]);
    expect(relatedTechnicalData).toEqual(technicalSnapshot);
    await expect(
      cleanupE2eReservations(client, currentRunId, cancel),
    ).resolves.toBe(0);
  });
});
