import "dotenv/config";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { operationalTimeToDatabase } from "@/modules/configuration/domain/operational-time";
import { prisma } from "@/server/db/prisma";
import { DEMO_RESTAURANT_ID } from "../../../../prisma/seed";

describe.sequential("M9-C generic cutoff migration", () => {
  it("removed both legacy columns and retained verified Friday/Saturday rules", async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'restaurant_booking_settings'
        AND column_name IN (
          'friday_dinner_booking_cutoff',
          'saturday_dinner_booking_cutoff'
        )
    `;
    const rules = await prisma.bookingCutoffRule.findMany({
      where: {
        restaurantId: DEMO_RESTAURANT_ID,
        serviceType: "DINNER",
        dayOfWeek: { in: ["FRIDAY", "SATURDAY"] },
      },
      orderBy: { dayOfWeek: "asc" },
    });

    expect(columns).toEqual([]);
    expect(rules).toHaveLength(2);
    expect(rules.every((rule) => rule.isEnabled)).toBe(true);
    expect(rules.every((rule) => rule.cutoffTime.getTime() === operationalTimeToDatabase("17:30").getTime())).toBe(true);
  });

  it("enforces tenant/day/service uniqueness", async () => {
    await expect(
      prisma.bookingCutoffRule.create({
        data: {
          restaurantId: DEMO_RESTAURANT_ID,
          dayOfWeek: "FRIDAY",
          serviceType: "DINNER",
          isEnabled: true,
          cutoffTime: operationalTimeToDatabase("18:00"),
        },
      }),
    ).rejects.toMatchObject({
      code: "P2002",
    } satisfies Partial<Prisma.PrismaClientKnownRequestError>);
  });

  it("contains a guarded backfill and no reservation mutation", () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260812160000_add_generic_booking_cutoff_rules/migration.sql",
      ),
      "utf8",
    );

    expect(sql).toContain("M9-C public booking cutoff backfill verification failed");
    expect(sql).toContain('DROP COLUMN "friday_dinner_booking_cutoff"');
    expect(sql).toContain('DROP COLUMN "saturday_dinner_booking_cutoff"');
    expect(sql).not.toMatch(/(?:UPDATE|DELETE FROM)\s+"reservations"/i);
  });
});
