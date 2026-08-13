import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  contentsFromContext,
  getAdminPublicSettings,
  getPublicSettings,
  updatePublicContacts,
  updatePublicContents,
  updatePublicManagementLinkDuration,
} from "@/modules/configuration/application/public-settings-service";
import { PublicSettingsError } from "@/modules/configuration/application/public-settings-errors";
import {
  DEFAULT_BOOKING_CUTOFFS,
  FIXED_ROLLING_WINDOW_MINUTES,
} from "@/modules/configuration/domain/defaults";
import { operationalTimeToDatabase } from "@/modules/configuration/domain/operational-time";
import { prisma } from "@/server/db/prisma";
import { readPublicSettingsContext } from "@/modules/configuration/infrastructure/public-settings-repository";
import {
  DEMO_PUBLIC_CONTACTS,
  DEMO_PUBLIC_CONTENTS,
} from "../../../../prisma/seed";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const adminId = randomUUID();
const secondAdminId = randomUUID();
const staffId = randomUUID();
const passwordChangeId = randomUUID();

const admin = { id: adminId, restaurantId };

function bookingSettings(targetRestaurantId: string) {
  return {
    restaurantId: targetRestaurantId,
    rollingCapacityCovers: 80,
    rollingWindowMinutes: FIXED_ROLLING_WINDOW_MINUTES,
    lunchModificationCutoff: operationalTimeToDatabase(
      DEFAULT_BOOKING_CUTOFFS.lunchModificationCutoff,
    ),
    dinnerModificationCutoff: operationalTimeToDatabase(
      DEFAULT_BOOKING_CUTOFFS.dinnerModificationCutoff,
    ),
    managementLinkDurationHours: 24,
  };
}

function changedContents(marker: string) {
  return {
    IT: Object.fromEntries(
      Object.entries(DEMO_PUBLIC_CONTENTS.IT).map(([key, value]) => [
        key,
        `${value} ${marker}`,
      ]),
    ),
    EN: Object.fromEntries(
      Object.entries(DEMO_PUBLIC_CONTENTS.EN).map(([key, value]) => [
        key,
        `${value} ${marker}`,
      ]),
    ),
  };
}

async function installAuditFailure(action: string) {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION m9e_fail_audit_insert() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'M9-E forced audit failure';
    END;
    $$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER m9e_fail_audit_trigger
    BEFORE INSERT ON audit_events
    FOR EACH ROW WHEN (NEW.action = '${action}')
    EXECUTE FUNCTION m9e_fail_audit_insert()
  `);
}

async function removeAuditFailure() {
  await prisma.$executeRawUnsafe(
    "DROP TRIGGER IF EXISTS m9e_fail_audit_trigger ON audit_events",
  );
  await prisma.$executeRawUnsafe(
    "DROP FUNCTION IF EXISTS m9e_fail_audit_insert()",
  );
}

describe.sequential("M9-E public settings with real PostgreSQL", () => {
  beforeAll(async () => {
    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "M9-E Demo", timezone: "Europe/Rome" },
        {
          id: otherRestaurantId,
          name: "M9-E Isolated Demo",
          timezone: "Europe/Rome",
        },
      ],
    });
    await prisma.restaurantBookingSettings.createMany({
      data: [bookingSettings(restaurantId), bookingSettings(otherRestaurantId)],
    });
    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          restaurantId,
          username: `m9e-admin-${adminId}`,
          passwordHash: "M9-E-integration-hash",
          role: "ADMIN",
        },
        {
          id: secondAdminId,
          restaurantId,
          username: `m9e-admin-${secondAdminId}`,
          passwordHash: "M9-E-integration-hash",
          role: "ADMIN",
        },
        {
          id: staffId,
          restaurantId,
          username: `m9e-staff-${staffId}`,
          passwordHash: "M9-E-integration-hash",
          role: "STAFF",
        },
        {
          id: passwordChangeId,
          restaurantId,
          username: `m9e-change-${passwordChangeId}`,
          passwordHash: "M9-E-integration-hash",
          role: "ADMIN",
          mustChangePassword: true,
        },
      ],
    });
    await prisma.restaurantPublicSettings.createMany({
      data: [
        { restaurantId, ...DEMO_PUBLIC_CONTACTS },
        {
          restaurantId: otherRestaurantId,
          publicPhone: "+390000008888",
          publicBookingBaseUrl: "https://other.example.test/",
        },
      ],
    });
    await prisma.publicContent.createMany({
      data: [restaurantId, otherRestaurantId].flatMap((targetRestaurantId) =>
        Object.entries(DEMO_PUBLIC_CONTENTS).flatMap(([locale, contents]) =>
          Object.entries(contents).map(([contentKey, contentText]) => ({
            restaurantId: targetRestaurantId,
            locale: locale as "IT" | "EN",
            contentKey: contentKey as keyof typeof DEMO_PUBLIC_CONTENTS.IT,
            contentText:
              targetRestaurantId === restaurantId
                ? contentText
                : `${contentText} isolated`,
          })),
        ),
      ),
    });
  });

  afterAll(async () => {
    await removeAuditFailure();
    await prisma.auditEvent.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.publicContent.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurantPublicSettings.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.user.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurantBookingSettings.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurant.deleteMany({
      where: { id: { in: [restaurantId, otherRestaurantId] } },
    });
  });

  it("authorizes only a fresh active Admin in the same tenant", async () => {
    await expect(getAdminPublicSettings(admin)).resolves.toMatchObject({
      managementLinkDurationHours: 24,
    });
    await expect(
      getAdminPublicSettings({ id: staffId, restaurantId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      getAdminPublicSettings({ id: passwordChangeId, restaurantId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      getAdminPublicSettings({ id: adminId, restaurantId: otherRestaurantId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const original = await getAdminPublicSettings(admin);
    await prisma.user.update({ where: { id: adminId }, data: { role: "STAFF" } });
    await expect(
      updatePublicContacts(admin, {
        fingerprint: original.fingerprints.contacts,
        contacts: DEMO_PUBLIC_CONTACTS,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await prisma.user.update({ where: { id: adminId }, data: { role: "ADMIN" } });
  });

  it("updates contacts and records only presence and changed field names", async () => {
    const before = await getAdminPublicSettings(admin);
    const contacts = {
      ...DEMO_PUBLIC_CONTACTS,
      publicPhone: "+390000007777",
      publicEmail: null,
    };
    await expect(
      updatePublicContacts(admin, {
        fingerprint: before.fingerprints.contacts,
        contacts,
      }),
    ).resolves.toEqual({ changed: true });
    expect((await getPublicSettings(restaurantId))?.contacts).toEqual(contacts);

    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { restaurantId, action: "PUBLIC_CONTACTS_UPDATED" },
      orderBy: { createdAt: "desc" },
    });
    const serialized = JSON.stringify({
      previousState: audit.previousState,
      newState: audit.newState,
      metadata: audit.metadata,
    });
    expect(serialized).not.toContain("+390000");
    expect(serialized).not.toContain("example.test");
    expect(audit.metadata).toMatchObject({
      changedFields: expect.arrayContaining(["publicPhone", "publicEmail"]),
    });
  });

  it("updates the complete IT/EN set atomically without text in audit", async () => {
    const before = await getAdminPublicSettings(admin);
    const contents = changedContents("atomic");
    await expect(
      updatePublicContents(admin, {
        fingerprint: before.fingerprints.contents,
        contents,
      }),
    ).resolves.toEqual({ changed: true });
    expect((await getPublicSettings(restaurantId))?.contents).toEqual(contents);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { restaurantId, action: "PUBLIC_CONTENT_UPDATED" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(audit)).not.toContain("atomic");
    expect(audit.metadata).toMatchObject({
      changed: expect.arrayContaining([
        expect.objectContaining({ locale: "IT" }),
        expect.objectContaining({ locale: "EN" }),
      ]),
    });
    const rows = await prisma.publicContent.findMany({
      where: { restaurantId },
      select: { locale: true, contentKey: true },
    });
    expect(rows).toHaveLength(14);
    for (const locale of ["IT", "EN"] as const) {
      expect(
        rows
          .filter((row) => row.locale === locale)
          .map((row) => row.contentKey)
          .sort(),
      ).toEqual(Object.keys(DEMO_PUBLIC_CONTENTS[locale]).sort());
    }
  });

  it("rejects one invalid content key before writing any row", async () => {
    const before = await getAdminPublicSettings(admin);
    await expect(
      updatePublicContents(admin, {
        fingerprint: before.fingerprints.contents,
        contents: {
          ...before.contents,
          IT: { ...before.contents?.IT, ARBITRARY: "Non ammesso" },
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await getAdminPublicSettings(admin)).toEqual(before);
  });

  it("exposes a safe null state for an incomplete or invalid persisted set", async () => {
    const rollback = new Error("M9-E expected rollback");
    await expect(
      prisma.$transaction(async (client) => {
        await client.publicContent.update({
          where: {
            restaurantId_locale_contentKey: {
              restaurantId,
              locale: "IT",
              contentKey: "BOOKING_PAGE_INTRO",
            },
          },
          data: { contentText: "visita https://example.test" },
        });
        const context = await readPublicSettingsContext(client, restaurantId);
        expect(context).not.toBeNull();
        expect(contentsFromContext(context!)).toBeNull();
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await getPublicSettings(restaurantId))?.contents).not.toBeNull();
  });

  it("lets a concurrent reader observe only the old or new complete set", async () => {
    const before = await getAdminPublicSettings(admin);
    const next = changedContents(`concurrent-${randomUUID()}`);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION m9e_pause_content_update() RETURNS trigger AS $$
      BEGIN
        IF NEW.content_key = 'CONFIRMATION_MESSAGE' AND NEW.locale = 'IT' THEN
          PERFORM pg_sleep(0.35);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER m9e_pause_content_trigger
      BEFORE UPDATE ON public_contents
      FOR EACH ROW EXECUTE FUNCTION m9e_pause_content_update()
    `);
    try {
      const mutation = updatePublicContents(admin, {
        fingerprint: before.fingerprints.contents,
        contents: next,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const during = await getPublicSettings(restaurantId);
      expect([before.contents, next]).toContainEqual(during?.contents);
      expect(Object.values(during?.contents ?? {}).flatMap(Object.values)).toHaveLength(14);
      await expect(mutation).resolves.toEqual({ changed: true });
      expect((await getPublicSettings(restaurantId))?.contents).toEqual(next);
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS m9e_pause_content_trigger ON public_contents",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS m9e_pause_content_update()",
      );
    }
  });

  it("updates duration prospectively and treats an exact repeat as no-op", async () => {
    const before = await getAdminPublicSettings(admin);
    await expect(
      updatePublicManagementLinkDuration(admin, {
        fingerprint: before.fingerprints.duration,
        managementLinkDurationHours: 12,
      }),
    ).resolves.toEqual({ changed: true, existingTokensAffected: 0 });
    const after = await getAdminPublicSettings(admin);
    const auditCount = await prisma.auditEvent.count({
      where: { restaurantId, action: "MANAGEMENT_LINK_DURATION_UPDATED" },
    });
    await expect(
      updatePublicManagementLinkDuration(admin, {
        fingerprint: after.fingerprints.duration,
        managementLinkDurationHours: 12,
      }),
    ).resolves.toEqual({ changed: false, existingTokensAffected: 0 });
    expect(
      await prisma.auditEvent.count({
        where: { restaurantId, action: "MANAGEMENT_LINK_DURATION_UPDATED" },
      }),
    ).toBe(auditCount);
  });

  it("treats identical contacts and content as no-op without audit", async () => {
    const current = await getAdminPublicSettings(admin);
    const beforeAuditCount = await prisma.auditEvent.count({
      where: { restaurantId },
    });
    await expect(
      updatePublicContacts(admin, {
        fingerprint: current.fingerprints.contacts,
        contacts: current.contacts,
      }),
    ).resolves.toEqual({ changed: false });
    await expect(
      updatePublicContents(admin, {
        fingerprint: current.fingerprints.contents,
        contents: current.contents,
      }),
    ).resolves.toEqual({ changed: false });
    expect(await prisma.auditEvent.count({ where: { restaurantId } })).toBe(
      beforeAuditCount,
    );
  });

  it("rejects client-supplied tenant fields through strict DTO validation", async () => {
    const current = await getAdminPublicSettings(admin);
    await expect(
      updatePublicManagementLinkDuration(admin, {
        fingerprint: current.fingerprints.duration,
        managementLinkDurationHours: 8,
        restaurantId: otherRestaurantId,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(
      (await getAdminPublicSettings(admin)).managementLinkDurationHours,
    ).toBe(current.managementLinkDurationHours);
  });

  it.each([
    ["PUBLIC_CONTACTS_UPDATED", "contacts"],
    ["PUBLIC_CONTENT_UPDATED", "contents"],
    ["MANAGEMENT_LINK_DURATION_UPDATED", "duration"],
  ] as const)("rolls back %s when audit insertion fails", async (action, kind) => {
    const before = await getAdminPublicSettings(admin);
    await installAuditFailure(action);
    try {
      const mutation =
        kind === "contacts"
          ? updatePublicContacts(admin, {
              fingerprint: before.fingerprints.contacts,
              contacts: {
                ...before.contacts,
                publicPhone: "+390000006666",
              },
            })
          : kind === "contents"
            ? updatePublicContents(admin, {
                fingerprint: before.fingerprints.contents,
                contents: changedContents("rollback"),
              })
            : updatePublicManagementLinkDuration(admin, {
                fingerprint: before.fingerprints.duration,
                managementLinkDurationHours: 6,
              });
      await expect(mutation).rejects.toThrow("M9-E forced audit failure");
    } finally {
      await removeAuditFailure();
    }
    expect(await getAdminPublicSettings(admin)).toEqual(before);
  });

  it("prevents lost updates between two Admins sharing one fingerprint", async () => {
    const before = await getAdminPublicSettings(admin);
    const results = await Promise.allSettled([
      updatePublicContacts(admin, {
        fingerprint: before.fingerprints.contacts,
        contacts: { ...before.contacts, publicPhone: "+390000005551" },
      }),
      updatePublicContacts(
        { id: secondAdminId, restaurantId },
        {
          fingerprint: before.fingerprints.contacts,
          contacts: { ...before.contacts, publicPhone: "+390000005552" },
        },
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(PublicSettingsError);
      expect(rejected.reason).toMatchObject({ code: "STATE_CHANGED" });
    }
  });

  it("enforces database uniqueness, enum allow-lists and tenant isolation", async () => {
    await expect(
      prisma.restaurantPublicSettings.create({
        data: { restaurantId, ...DEMO_PUBLIC_CONTACTS },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.publicContent.create({
        data: {
          restaurantId,
          locale: "IT",
          contentKey: "BOOKING_PAGE_TITLE",
          contentText: "Duplicato",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO public_contents (id, restaurant_id, locale, content_key, content_text) VALUES ('${randomUUID()}', '${restaurantId}', 'FR', 'BOOKING_PAGE_TITLE', 'invalid')`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO public_contents (id, restaurant_id, locale, content_key, content_text) VALUES ('${randomUUID()}', '${restaurantId}', 'IT', 'ARBITRARY', 'invalid')`,
      ),
    ).rejects.toThrow();

    const other = await getPublicSettings(otherRestaurantId);
    expect(other?.contacts.publicPhone).toBe("+390000008888");
    expect(JSON.stringify(other)).not.toContain("+39000000555");
  });
});
