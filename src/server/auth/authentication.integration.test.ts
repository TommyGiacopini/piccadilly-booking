import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as loginPost } from "@/app/api/auth/login/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { UserRole } from "@/generated/prisma/client";
import { authenticateCredentials } from "@/server/auth/authentication";
import {
  processLoginWithAudit,
  revokeSessionWithAudit,
} from "@/server/auth/authentication-audit";
import {
  LOCAL_RATE_LIMIT_SECRET,
  resolveAuthConfig,
} from "@/server/auth/auth-config";
import { hashPassword } from "@/server/auth/password";
import {
  cleanupExpiredLoginRateLimits,
  getLoginRateLimitStatus,
  recordFailedLoginAttempt,
} from "@/server/auth/rate-limit";
import { createRateLimitKeyHash } from "@/server/auth/request-security";
import {
  createSessionForUser,
  revokeSessionToken,
  validateSessionToken,
} from "@/server/auth/session";
import { parseSessionToken } from "@/server/auth/session-token";
import { prisma } from "@/server/db/prisma";
import {
  DEMO_ADMIN_ID,
  DEMO_RESTAURANT_ID,
  DEMO_STAFF_ID,
  seedDemoData,
} from "../../../prisma/seed";

const restaurantId = randomUUID();
const adminId = randomUUID();
const staffId = randomUUID();
const disabledId = randomUUID();
const testPassword = "Integration-Password-2026";
const wrongPassword = "Incorrect-Password-2026";
const rateLimitKeys = new Set<string>();

function createFormRequest(
  path: string,
  data: Record<string, string>,
  cookie?: string,
): Request {
  const headers = new Headers({
    host: "localhost:4000",
    origin: "http://localhost:4000",
    "content-type": "application/x-www-form-urlencoded",
  });

  if (cookie) {
    headers.set("cookie", cookie);
  }

  return new Request(`http://localhost:4000${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(data),
  });
}

describe.sequential("authentication with real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.APP_ENV = "development";
    process.env.AUTH_RESTAURANT_ID = restaurantId;
    process.env.AUTH_RATE_LIMIT_SECRET = LOCAL_RATE_LIMIT_SECRET;
    process.env.AUTH_TRUST_PROXY = "false";

    const passwordHash = await hashPassword(testPassword);
    await prisma.restaurant.create({
      data: {
        id: restaurantId,
        name: "Authentication Integration Restaurant",
        timezone: "Europe/Rome",
        users: {
          create: [
            {
              id: adminId,
              username: "integration.admin",
              passwordHash,
              role: UserRole.ADMIN,
            },
            {
              id: staffId,
              username: "integration.staff",
              passwordHash,
              role: UserRole.STAFF,
            },
            {
              id: disabledId,
              username: "integration.disabled",
              passwordHash,
              role: UserRole.STAFF,
              isActive: false,
              disabledAt: new Date(),
            },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.loginRateLimit.deleteMany({
      where: { keyHash: { in: [...rateLimitKeys] } },
    });
    await prisma.auditEvent.deleteMany({ where: { restaurantId } });
    await prisma.user.deleteMany({ where: { restaurantId } });
    await prisma.restaurant.deleteMany({ where: { id: restaurantId } });
    await prisma.$disconnect();
  });

  it("persists the User-Restaurant relation and both initial roles", async () => {
    const users = await prisma.user.findMany({
      where: { restaurantId },
      include: { restaurant: true },
      orderBy: { username: "asc" },
    });

    expect(users).toHaveLength(3);
    expect(users.every((user) => user.restaurant.id === restaurantId)).toBe(true);
    expect(users.map((user) => user.role)).toEqual([
      UserRole.ADMIN,
      UserRole.STAFF,
      UserRole.STAFF,
    ]);
  });

  it("accepts a valid normalized username", async () => {
    await expect(
      authenticateCredentials(restaurantId, {
        username: "  Integration.Admin ",
        password: testPassword,
      }),
    ).resolves.toMatchObject({
      id: adminId,
      username: "integration.admin",
      role: UserRole.ADMIN,
    });
  });

  it("returns the same generic result for an unknown username or wrong password", async () => {
    const unknown = await authenticateCredentials(restaurantId, {
      username: "integration.unknown",
      password: testPassword,
    });
    const wrong = await authenticateCredentials(restaurantId, {
      username: "integration.admin",
      password: wrongPassword,
    });

    expect(unknown).toBeNull();
    expect(wrong).toBeNull();
  });

  it("rejects a disabled user even when the password is correct", async () => {
    await expect(
      authenticateCredentials(restaurantId, {
        username: "integration.disabled",
        password: testPassword,
      }),
    ).resolves.toBeNull();
  });

  it("audits invalid credentials without identity data or secrets", async () => {
    const keyHash = createRateLimitKeyHash(
      "integration.audit-failure",
      "direct-client",
      resolveAuthConfig(process.env).rateLimitSecret,
    );
    rateLimitKeys.add(keyHash);

    const response = await loginPost(
      createFormRequest("/api/auth/login", {
        username: "integration.audit-failure",
        password: wrongPassword,
      }),
    );
    expect(response.status).toBe(303);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        restaurantId,
        action: "LOGIN_FAILED",
        metadata: { path: ["credentialFingerprint"], equals: keyHash },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(event).toMatchObject({
      category: "AUTHENTICATION",
      outcome: "FAILURE",
      actorUserId: null,
      actorRole: null,
      metadata: { credentialFingerprint: keyHash },
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("integration.audit-failure");
    expect(serialized).not.toContain(wrongPassword);
    expect(serialized).not.toContain("direct-client");
  });

  it("creates, validates and revokes an opaque database session", async () => {
    const created = await createSessionForUser(staffId);
    const stored = await prisma.session.findUniqueOrThrow({
      where: { id: created.id },
    });
    const parsed = parseSessionToken(created.token);

    expect(parsed).not.toBeNull();
    expect(stored.secretHash).not.toBe(parsed?.secret);
    await expect(validateSessionToken(created.token)).resolves.toMatchObject({
      id: staffId,
      role: UserRole.STAFF,
    });
    await expect(revokeSessionToken(created.token)).resolves.toBe(true);
    await expect(validateSessionToken(created.token)).resolves.toBeNull();
  });

  it("rejects an expired session", async () => {
    const now = new Date("2026-08-02T10:00:00.000Z");
    const created = await createSessionForUser(staffId, { now, ttlMs: 1_000 });

    await expect(
      validateSessionToken(created.token, {
        now: new Date("2026-08-02T10:00:01.001Z"),
      }),
    ).resolves.toBeNull();
  });

  it("invalidates all sessions when a user is disabled", async () => {
    const created = await createSessionForUser(staffId);
    const disabledAt = new Date();
    await prisma.user.update({
      where: { id: staffId },
      data: { isActive: false, disabledAt },
    });

    await expect(validateSessionToken(created.token)).resolves.toBeNull();
    await expect(
      prisma.session.count({
        where: { userId: staffId, revokedAt: { not: null } },
      }),
    ).resolves.toBeGreaterThan(0);

    await prisma.user.update({
      where: { id: staffId },
      data: { isActive: true, disabledAt: null },
    });
  });

  it("persists and enforces the login rate limit", async () => {
    const config = resolveAuthConfig(process.env);
    const keyHash = createRateLimitKeyHash(
      "integration.rate-limited",
      "direct-client",
      config.rateLimitSecret,
    );
    rateLimitKeys.add(keyHash);

    for (let attempt = 1; attempt <= config.rateLimitMaxAttempts; attempt += 1) {
      await recordFailedLoginAttempt(keyHash, config);
    }

    await expect(getLoginRateLimitStatus(keyHash)).resolves.toMatchObject({
      allowed: false,
    });
    await expect(
      prisma.loginRateLimit.findUnique({ where: { keyHash } }),
    ).resolves.toMatchObject({ attempts: config.rateLimitMaxAttempts });
  });

  it("audits a request already blocked by the login rate limiter", async () => {
    const config = resolveAuthConfig(process.env);
    const username = "integration.route-rate-limit";
    const keyHash = createRateLimitKeyHash(
      username,
      "direct-client",
      config.rateLimitSecret,
    );
    rateLimitKeys.add(keyHash);

    for (let attempt = 0; attempt <= config.rateLimitMaxAttempts; attempt += 1) {
      const response = await loginPost(
        createFormRequest("/api/auth/login", {
          username,
          password: wrongPassword,
        }),
      );
      expect(response.status).toBe(303);
    }

    await expect(
      prisma.auditEvent.count({
        where: {
          restaurantId,
          action: "LOGIN_FAILED",
          metadata: { path: ["credentialFingerprint"], equals: keyHash },
        },
      }),
    ).resolves.toBe(config.rateLimitMaxAttempts);
    await expect(
      prisma.auditEvent.count({
        where: {
          restaurantId,
          action: "LOGIN_RATE_LIMITED",
          metadata: { path: ["credentialFingerprint"], equals: keyHash },
        },
      }),
    ).resolves.toBe(1);
  });

  it("cleans up expired login rate-limit entries", async () => {
    const keyHash = "a".repeat(64);
    rateLimitKeys.add(keyHash);
    await prisma.loginRateLimit.create({
      data: {
        keyHash,
        attempts: 1,
        windowStartedAt: new Date("2026-08-01T09:00:00.000Z"),
        expiresAt: new Date("2026-08-01T09:15:00.000Z"),
      },
    });

    await cleanupExpiredLoginRateLimits(new Date("2026-08-02T09:00:00.000Z"));
    await expect(
      prisma.loginRateLimit.findUnique({ where: { keyHash } }),
    ).resolves.toBeNull();
  });

  it("sets a hardened cookie on login and revokes it on logout", async () => {
    const loginResponse = await loginPost(
      createFormRequest("/api/auth/login", {
        username: "integration.admin",
        password: testPassword,
        returnTo: "/dashboard",
      }),
    );
    const setCookie = loginResponse.headers.get("set-cookie");
    const cookie = setCookie?.split(";", 1)[0];
    const rawToken = cookie?.slice("piccadilly_session=".length);

    expect(loginResponse.status).toBe(303);
    expect(loginResponse.headers.get("location")).toBe(
      "http://localhost:4000/dashboard",
    );
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("integration.admin");
    expect(setCookie).not.toContain(testPassword);
    expect(rawToken).toBeTruthy();
    await expect(validateSessionToken(rawToken)).resolves.toMatchObject({
      id: adminId,
    });

    const logoutResponse = await logoutPost(
      createFormRequest("/api/auth/logout", {}, cookie),
    );

    expect(logoutResponse.status).toBe(303);
    expect(logoutResponse.headers.get("location")).toBe(
      "http://localhost:4000/login",
    );
    expect(logoutResponse.headers.get("set-cookie")).toContain(
      "piccadilly_session=",
    );
    await expect(validateSessionToken(rawToken)).resolves.toBeNull();

    const events = await prisma.auditEvent.findMany({
      where: {
        restaurantId,
        action: { in: ["LOGIN_SUCCEEDED", "LOGOUT_SUCCEEDED"] },
        actorUserId: adminId,
      },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((event) => event.action)).toEqual([
      "LOGIN_SUCCEEDED",
      "LOGOUT_SUCCEEDED",
    ]);
    expect(events.every((event) => event.restaurantId === restaurantId)).toBe(
      true,
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("integration.admin");
    expect(serialized).not.toContain(testPassword);
    expect(serialized).not.toContain(rawToken!);
  });

  it("rolls session revocation back if the logout audit cannot be written", async () => {
    const created = await createSessionForUser(staffId);

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION m9a_test_reject_logout_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'LOGOUT_SUCCEEDED' THEN
          RAISE EXCEPTION 'synthetic M9-A logout audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER m9a_test_reject_logout_audit_trigger
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION m9a_test_reject_logout_audit();
    `);

    try {
      await expect(
        revokeSessionWithAudit({ restaurantId, rawToken: created.token }),
      ).rejects.toThrow("synthetic M9-A logout audit failure");
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS m9a_test_reject_logout_audit_trigger ON audit_events",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS m9a_test_reject_logout_audit()",
      );
    }

    await expect(
      prisma.session.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(revokeSessionToken(created.token)).resolves.toBe(true);
  });

  it("rolls session creation back if the successful-login audit fails", async () => {
    const config = resolveAuthConfig(process.env);
    const sessionsBefore = await prisma.session.count({ where: { userId: adminId } });

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION m9a_test_reject_login_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'LOGIN_SUCCEEDED' THEN
          RAISE EXCEPTION 'synthetic M9-A login audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER m9a_test_reject_login_audit_trigger
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION m9a_test_reject_login_audit();
    `);

    try {
      await expect(
        processLoginWithAudit({
          restaurantId,
          credentials: {
            username: "integration.admin",
            password: testPassword,
          },
          credentialFingerprint: "b".repeat(64),
          config,
        }),
      ).rejects.toThrow("synthetic M9-A login audit failure");
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS m9a_test_reject_login_audit_trigger ON audit_events",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS m9a_test_reject_login_audit()",
      );
    }

    await expect(
      prisma.session.count({ where: { userId: adminId } }),
    ).resolves.toBe(sessionsBefore);
  });

  it("does not revoke or audit a session through another restaurant", async () => {
    const created = await createSessionForUser(staffId);
    const auditCount = await prisma.auditEvent.count({ where: { restaurantId } });

    await expect(
      revokeSessionWithAudit({
        restaurantId: randomUUID(),
        rawToken: created.token,
      }),
    ).resolves.toBe(false);
    await expect(
      prisma.session.findUnique({ where: { id: created.id } }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(
      prisma.auditEvent.count({ where: { restaurantId } }),
    ).resolves.toBe(auditCount);
    await expect(revokeSessionToken(created.token)).resolves.toBe(true);
  });

  it("keeps the restaurant and both fake users idempotent", async () => {
    const passwords = {
      admin: "Seed-Admin-Password-2026",
      staff: "Seed-Staff-Password-2026",
    };

    await seedDemoData(prisma, passwords);
    await seedDemoData(prisma, passwords);

    await expect(
      prisma.restaurant.count({ where: { id: DEMO_RESTAURANT_ID } }),
    ).resolves.toBe(1);
    await expect(
      prisma.user.count({ where: { id: { in: [DEMO_ADMIN_ID, DEMO_STAFF_ID] } } }),
    ).resolves.toBe(2);
  });
});
