import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import {
  DEMO_PUBLIC_CONTACTS,
  seedDemoOperationalConfiguration,
  seedDemoPublicConfiguration,
  seedDemoUsers,
} from "../../../prisma/seed";

describe("M9-B demo user seed", () => {
  it("creates first-time users without mandatory change and never overwrites lifecycle data", async () => {
    const upsert = vi
      .fn()
      .mockImplementation(async ({ create }: { create: Record<string, unknown> }) => create);
    const client = { user: { upsert } };

    await seedDemoUsers(client as never, {
      admin: "Seed-Admin-Password-2026",
      staff: "Seed-Staff-Password-2026",
    });

    expect(upsert).toHaveBeenCalledTimes(2);
    for (const call of upsert.mock.calls) {
      const argument = call[0] as {
        update: Record<string, unknown>;
        create: { mustChangePassword: boolean };
      };
      expect(argument.update).toEqual({});
      expect(argument.create.mustChangePassword).toBe(false);
    }
  });
});

describe("M9-C operational seed", () => {
  it("creates missing demo configuration without overwriting Admin values", async () => {
    const settingsUpsert = vi.fn(async ({ create }) => create);
    const scheduleUpsert = vi.fn(async ({ create }) => create);
    const cutoffCreateMany = vi.fn(async () => ({ count: 14 }));
    const client = {
      restaurantBookingSettings: { upsert: settingsUpsert },
      bookingCutoffRule: {
        createMany: cutoffCreateMany,
        findMany: vi.fn(async () => []),
      },
      room: {
        upsert: vi.fn(async ({ create }) => ({ id: randomUUID(), ...create })),
      },
      diningTable: { upsert: vi.fn(async ({ create }) => create) },
      weeklyServiceSchedule: { upsert: scheduleUpsert },
    };

    await seedDemoOperationalConfiguration(client as never);

    expect(settingsUpsert.mock.calls[0]?.[0].update).toEqual({});
    expect(scheduleUpsert).toHaveBeenCalledTimes(14);
    expect(
      scheduleUpsert.mock.calls.every((call) =>
        JSON.stringify(call[0].update) === "{}",
      ),
    ).toBe(true);
    expect(cutoffCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });
});

describe("M9-E public configuration seed", () => {
  it("only creates missing fake fixtures and never overwrites existing values", async () => {
    const settingsCreateMany = vi.fn(async () => ({ count: 0 }));
    const contentCreateMany = vi.fn(
      async (input: { data: unknown[]; skipDuplicates: boolean }) => {
        void input;
        return { count: 0 };
      },
    );
    const client = {
      restaurantPublicSettings: {
        createMany: settingsCreateMany,
        findUnique: vi.fn(async () => ({
          restaurantId: randomUUID(),
          publicPhone: "+390000009999",
        })),
      },
      publicContent: {
        createMany: contentCreateMany,
        findMany: vi.fn(async () => []),
      },
    };

    await seedDemoPublicConfiguration(client as never);

    expect(settingsCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining(DEMO_PUBLIC_CONTACTS)],
      skipDuplicates: true,
    });
    expect(contentCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(contentCreateMany.mock.calls[0]?.[0].data).toHaveLength(14);
  });
});
