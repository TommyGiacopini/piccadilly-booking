import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  IdentityError,
} from "@/modules/identity/application/identity-errors";
import {
  changeManagedUserRole,
  changeManagedUserStatus,
  changePersonalPassword,
  createManagedUser,
  listManagedUsers,
  resetManagedUserPassword,
} from "@/modules/identity/application/identity-service";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSessionForUser } from "@/server/auth/session";
import { prisma } from "@/server/db/prisma";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const concurrencyRestaurantId = randomUUID();
const adminId = randomUUID();
const secondAdminId = randomUUID();
const staffId = randomUUID();
const personalUserId = randomUUID();
const otherAdminId = randomUUID();
const otherUserId = randomUUID();
const concurrentAdminAId = randomUUID();
const concurrentAdminBId = randomUUID();
const adminActor = { id: adminId, restaurantId };

describe.sequential("M9-B identity lifecycle with real PostgreSQL", () => {
  beforeAll(async () => {
    const passwordHash = await hashPassword("Existing-Password-2026");

    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "M9-B Identity Demo", timezone: "Europe/Rome" },
        { id: otherRestaurantId, name: "M9-B Other Demo", timezone: "Europe/Rome" },
        {
          id: concurrencyRestaurantId,
          name: "M9-B Concurrency Demo",
          timezone: "Europe/Rome",
        },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          restaurantId,
          username: `m9b.admin.${adminId.slice(0, 8)}`,
          passwordHash,
          role: "ADMIN",
        },
        {
          id: secondAdminId,
          restaurantId,
          username: `m9b.admin2.${secondAdminId.slice(0, 8)}`,
          passwordHash,
          role: "ADMIN",
        },
        {
          id: staffId,
          restaurantId,
          username: `m9b.staff.${staffId.slice(0, 8)}`,
          passwordHash,
          role: "STAFF",
        },
        {
          id: personalUserId,
          restaurantId,
          username: `m9b.personal.${personalUserId.slice(0, 8)}`,
          passwordHash,
          role: "STAFF",
          mustChangePassword: true,
        },
        {
          id: otherAdminId,
          restaurantId: otherRestaurantId,
          username: `m9b.other.admin.${otherAdminId.slice(0, 8)}`,
          passwordHash,
          role: "ADMIN",
        },
        {
          id: otherUserId,
          restaurantId: otherRestaurantId,
          username: `m9b.other.staff.${otherUserId.slice(0, 8)}`,
          passwordHash,
          role: "STAFF",
        },
        {
          id: concurrentAdminAId,
          restaurantId: concurrencyRestaurantId,
          username: `m9b.concurrent.a.${concurrentAdminAId.slice(0, 8)}`,
          passwordHash,
          role: "ADMIN",
        },
        {
          id: concurrentAdminBId,
          restaurantId: concurrencyRestaurantId,
          username: `m9b.concurrent.b.${concurrentAdminBId.slice(0, 8)}`,
          passwordHash,
          role: "ADMIN",
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({
      where: {
        restaurantId: {
          in: [restaurantId, otherRestaurantId, concurrencyRestaurantId],
        },
      },
    });
    await prisma.user.deleteMany({
      where: {
        restaurantId: {
          in: [restaurantId, otherRestaurantId, concurrencyRestaurantId],
        },
      },
    });
    await prisma.restaurant.deleteMany({
      where: {
        id: { in: [restaurantId, otherRestaurantId, concurrencyRestaurantId] },
      },
    });
    await prisma.$disconnect();
  });

  it("creates a tenant-scoped user and returns a one-shot temporary secret only", async () => {
    const username = `m9b.created.${randomUUID().slice(0, 8)}`;
    const result = await createManagedUser(adminActor, {
      username: `  ${username.toUpperCase()}  `,
      role: "STAFF",
    });
    const persisted = await prisma.user.findUniqueOrThrow({
      where: { id: result.user.id },
    });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "USER_CREATED", entityId: result.user.id },
    });

    expect(result.temporaryPassword).toHaveLength(24);
    expect(result.user.username).toBe(username);
    expect(persisted.mustChangePassword).toBe(true);
    expect(persisted.passwordHash).not.toContain(result.temporaryPassword);
    await expect(
      verifyPassword(persisted.passwordHash, result.temporaryPassword),
    ).resolves.toBe(true);
    expect(audit.previousState).toBeNull();
    expect(audit.newState).toEqual({
      role: "STAFF",
      isActive: true,
      disabledAtPresent: false,
      mustChangePassword: true,
    });
    expect(audit.metadata).toEqual({
      revokedSessionCount: 0,
      flowType: "ADMIN_CREATE",
    });
    expect(JSON.stringify(audit)).not.toContain(result.temporaryPassword);
  });

  it("re-verifies the actor and prevents cross-tenant targets", async () => {
    await expect(
      resetManagedUserPassword(adminActor, otherUserId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<IdentityError>);

    await prisma.user.update({
      where: { id: otherAdminId },
      data: { isActive: false, disabledAt: new Date() },
    });
    await expect(
      listManagedUsers({ id: otherAdminId, restaurantId: otherRestaurantId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<IdentityError>);
  });

  it("treats no-ops as no audit and revokes sessions on role and state changes", async () => {
    const initialSession = await createSessionForUser(staffId);
    const initialAuditCount = await prisma.auditEvent.count({
      where: { restaurantId, entityId: staffId },
    });
    const noOp = await changeManagedUserRole(adminActor, staffId, {
      role: "STAFF",
    });
    expect(noOp.changed).toBe(false);
    await expect(
      prisma.session.findUniqueOrThrow({ where: { id: initialSession.id } }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(
      prisma.auditEvent.count({ where: { restaurantId, entityId: staffId } }),
    ).resolves.toBe(initialAuditCount);

    const promoted = await changeManagedUserRole(adminActor, staffId, {
      role: "ADMIN",
    });
    expect(promoted.changed).toBe(true);
    await expect(
      prisma.session.findUniqueOrThrow({ where: { id: initialSession.id } }),
    ).resolves.not.toMatchObject({ revokedAt: null });

    await changeManagedUserRole(adminActor, staffId, { role: "STAFF" });
    const stateSession = await createSessionForUser(staffId);
    await changeManagedUserStatus(adminActor, staffId, { isActive: false });
    await expect(
      prisma.session.findUniqueOrThrow({ where: { id: stateSession.id } }),
    ).resolves.not.toMatchObject({ revokedAt: null });
    await expect(prisma.user.findUniqueOrThrow({ where: { id: staffId } })).resolves.toMatchObject({
      isActive: false,
      disabledAt: expect.any(Date),
    });
    await changeManagedUserStatus(adminActor, staffId, { isActive: true });
  });

  it("preserves one active admin under concurrent conflicting disables", async () => {
    const outcomes = await Promise.allSettled([
      changeManagedUserStatus(
        { id: concurrentAdminAId, restaurantId: concurrencyRestaurantId },
        concurrentAdminBId,
        { isActive: false },
      ),
      changeManagedUserStatus(
        { id: concurrentAdminBId, restaurantId: concurrencyRestaurantId },
        concurrentAdminAId,
        { isActive: false },
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await expect(
      prisma.user.count({
        where: {
          restaurantId: concurrencyRestaurantId,
          role: "ADMIN",
          isActive: true,
          disabledAt: null,
        },
      }),
    ).resolves.toBe(1);
  });

  it("changes a personal password atomically and revokes the current session", async () => {
    const session = await createSessionForUser(personalUserId);
    const newPassword = "Nuova password personale 2026 😀";

    await changePersonalPassword(
      { id: personalUserId, restaurantId },
      {
        currentPassword: "Existing-Password-2026",
        newPassword,
        confirmPassword: newPassword,
      },
    );

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: personalUserId },
    });
    expect(user.mustChangePassword).toBe(false);
    await expect(verifyPassword(user.passwordHash, newPassword)).resolves.toBe(true);
    await expect(
      prisma.session.findUniqueOrThrow({ where: { id: session.id } }),
    ).resolves.not.toMatchObject({ revokedAt: null });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "PASSWORD_CHANGED", entityId: personalUserId },
    });
    expect(audit.metadata).toMatchObject({
      flowType: "PERSONAL_PASSWORD_CHANGE",
      revokedSessionCount: 1,
    });
    expect(JSON.stringify(audit)).not.toContain(newPassword);
    expect(JSON.stringify(audit)).not.toContain("passwordHash");
  });

  it("resets another user to a one-shot temporary password and revokes sessions", async () => {
    const session = await createSessionForUser(staffId);
    const result = await resetManagedUserPassword(adminActor, staffId);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: staffId } });

    expect(result.temporaryPassword).toHaveLength(24);
    expect(user.mustChangePassword).toBe(true);
    await expect(
      verifyPassword(user.passwordHash, result.temporaryPassword),
    ).resolves.toBe(true);
    await expect(
      prisma.session.findUniqueOrThrow({ where: { id: session.id } }),
    ).resolves.not.toMatchObject({ revokedAt: null });
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "USER_PASSWORD_RESET", entityId: staffId },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.stringify(audit)).not.toContain(result.temporaryPassword);
  });

  it("rolls back lifecycle state and revocation when audit persistence fails", async () => {
    const session = await createSessionForUser(staffId);
    const auditCount = await prisma.auditEvent.count({
      where: { action: "USER_DISABLED", entityId: staffId },
    });
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION m9b_test_reject_identity_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'USER_DISABLED' AND NEW.entity_id = '${staffId}'::uuid THEN
          RAISE EXCEPTION 'synthetic M9-B audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER m9b_test_reject_identity_audit_trigger
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION m9b_test_reject_identity_audit();
    `);

    try {
      await expect(
        changeManagedUserStatus(adminActor, staffId, { isActive: false }),
      ).rejects.toThrow("synthetic M9-B audit failure");
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS m9b_test_reject_identity_audit_trigger ON audit_events",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS m9b_test_reject_identity_audit()",
      );
    }

    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: staffId } }),
    ).resolves.toMatchObject({ isActive: true, disabledAt: null });
    await expect(
      prisma.session.findUniqueOrThrow({ where: { id: session.id } }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(
      prisma.auditEvent.count({
        where: { action: "USER_DISABLED", entityId: staffId },
      }),
    ).resolves.toBe(auditCount);
  });
});
