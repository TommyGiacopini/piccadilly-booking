import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { createHealthResponse } from "@/app/api/health/route";
import { prisma } from "@/server/db/prisma";
import {
  DEMO_RESTAURANT_ID,
  seedDemoRestaurant,
} from "../../../prisma/seed";

const integrationRestaurantId = randomUUID();

describe("PostgreSQL and Prisma integration", () => {
  afterAll(async () => {
    try {
      await prisma.restaurant.deleteMany({
        where: { id: integrationRestaurantId },
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("connects to a real PostgreSQL database", async () => {
    const result = await prisma.$queryRaw<Array<{ connected: number }>>`
      SELECT 1 AS connected
    `;

    expect(result).toEqual([{ connected: 1 }]);
  });

  it("persists the minimal Restaurant model", async () => {
    const restaurant = await prisma.restaurant.create({
      data: {
        id: integrationRestaurantId,
        name: "Integration Test Restaurant",
        timezone: "Europe/Rome",
      },
    });

    expect(restaurant).toMatchObject({
      id: integrationRestaurantId,
      name: "Integration Test Restaurant",
      timezone: "Europe/Rome",
    });
    expect(restaurant.createdAt).toBeInstanceOf(Date);
    expect(restaurant.updatedAt).toBeInstanceOf(Date);
  });

  it("keeps the demo seed idempotent", async () => {
    await seedDemoRestaurant(prisma);
    await seedDemoRestaurant(prisma);

    await expect(
      prisma.restaurant.count({ where: { id: DEMO_RESTAURANT_ID } }),
    ).resolves.toBe(1);
  });

  it("reports database ok through the health check", async () => {
    const response = await createHealthResponse(
      () => prisma.$queryRaw`SELECT 1`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      database: "ok",
    });
  });
});
