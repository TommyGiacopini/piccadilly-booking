import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GET as notificationSettingsGet,
  PATCH as notificationSettingsPatch,
} from "@/app/api/admin/notification-settings/route";
import { createSessionForUser } from "@/server/auth/session";
import { getSessionCookieName } from "@/server/auth/session-token";
import { prisma } from "@/server/db/prisma";
import { getAppEnvironment } from "@/shared/config/app-environment";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const adminId = randomUUID();
const staffId = randomUUID();
const disabledId = randomUUID();
const mustChangeId = randomUUID();
const otherAdminId = randomUUID();
const sessionNow = new Date("2028-01-01T00:00:00.000Z");
const sessionTtl = 100 * 365 * 24 * 60 * 60 * 1_000;
const originalAppEnvironment = process.env.APP_ENV;
const originalTrustProxy = process.env.AUTH_TRUST_PROXY;
const originalRateLimitSecret = process.env.AUTH_RATE_LIMIT_SECRET;
let cookies: Record<string, string>;

function request(input: {
  method?: "GET" | "PATCH";
  cookie?: string;
  origin?: string;
  body?: string;
  contentType?: string;
}) {
  const headers = new Headers();
  if (input.cookie) headers.set("cookie", input.cookie);
  if (input.origin) headers.set("origin", input.origin);
  if (input.contentType) headers.set("content-type", input.contentType);
  return new Request("http://localhost:3000/api/admin/notification-settings", {
    method: input.method ?? "GET",
    headers,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
}

describe.sequential("M12 Admin notification settings API with real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.APP_ENV = "development";
    process.env.AUTH_TRUST_PROXY = "false";
    process.env.AUTH_RATE_LIMIT_SECRET =
      "m12-notification-settings-test-rate-limit-secret";
    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "M12 Settings", timezone: "Europe/Rome" },
        { id: otherRestaurantId, name: "M12 Settings Other", timezone: "Europe/Rome" },
      ],
    });
    await prisma.restaurantNotificationSettings.createMany({
      data: [
        { restaurantId, strategy: "WHATSAPP_ONLY" },
        { restaurantId: otherRestaurantId, strategy: "WHATSAPP_ONLY" },
      ],
    });
    await prisma.user.createMany({
      data: [
        { id: adminId, restaurantId, username: `m12.settings.admin.${adminId}`, passwordHash: "fake", role: "ADMIN" },
        { id: staffId, restaurantId, username: `m12.settings.staff.${staffId}`, passwordHash: "fake", role: "STAFF" },
        { id: disabledId, restaurantId, username: `m12.settings.disabled.${disabledId}`, passwordHash: "fake", role: "ADMIN", isActive: false, disabledAt: sessionNow },
        { id: mustChangeId, restaurantId, username: `m12.settings.change.${mustChangeId}`, passwordHash: "fake", role: "ADMIN", mustChangePassword: true },
        { id: otherAdminId, restaurantId: otherRestaurantId, username: `m12.settings.other.${otherAdminId}`, passwordHash: "fake", role: "ADMIN" },
      ],
    });
    const entries = await Promise.all([
      ["admin", adminId],
      ["staff", staffId],
      ["disabled", disabledId],
      ["mustChange", mustChangeId],
      ["otherAdmin", otherAdminId],
    ].map(async ([name, id]) => [name, await createSessionForUser(id, { now: sessionNow, ttlMs: sessionTtl })] as const));
    const cookieName = getSessionCookieName(getAppEnvironment());
    cookies = Object.fromEntries(entries.map(([name, session]) => [name, `${cookieName}=${session.token}`]));
  });

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany({ where: { restaurantId: { in: [restaurantId, otherRestaurantId] }, action: "NOTIFICATION_STRATEGY_UPDATED" } });
    await prisma.restaurantNotificationSettings.updateMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
      data: { strategy: "WHATSAPP_ONLY" },
    });
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { restaurantId: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.session.deleteMany({ where: { userId: { in: [adminId, staffId, disabledId, mustChangeId, otherAdminId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, staffId, disabledId, mustChangeId, otherAdminId] } } });
    await prisma.restaurantNotificationSettings.deleteMany({ where: { restaurantId: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.restaurant.deleteMany({ where: { id: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.$disconnect();
    if (originalAppEnvironment === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalAppEnvironment;
    if (originalTrustProxy === undefined) delete process.env.AUTH_TRUST_PROXY;
    else process.env.AUTH_TRUST_PROXY = originalTrustProxy;
    if (originalRateLimitSecret === undefined) {
      delete process.env.AUTH_RATE_LIMIT_SECRET;
    } else {
      process.env.AUTH_RATE_LIMIT_SECRET = originalRateLimitSecret;
    }
  });

  it("returns the server-side tenant setting to an active Admin with no-store", async () => {
    const response = await notificationSettingsGet(request({ cookie: cookies.admin }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({ configuration: { strategy: "WHATSAPP_ONLY" } });
  });

  it.each([
    ["anonymous", undefined, 401],
    ["Staff", () => cookies.staff, 403],
    ["disabled", () => cookies.disabled, 401],
    ["must-change-password", () => cookies.mustChange, 403],
  ] as const)("rejects %s GET", async (_label, cookie, status) => {
    const response = await notificationSettingsGet(request({ cookie: typeof cookie === "function" ? cookie() : cookie }));
    expect(response.status).toBe(status);
  });

  it("persists an Admin PATCH in its own tenant and audits only strategy", async () => {
    const response = await notificationSettingsPatch(request({
      method: "PATCH",
      cookie: cookies.admin,
      origin: "http://localhost:3000",
      contentType: "application/json",
      body: JSON.stringify({ strategy: "WHATSAPP_AND_EMAIL_PARALLEL" }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ strategy: "WHATSAPP_AND_EMAIL_PARALLEL", changed: true });
    await expect(prisma.restaurantNotificationSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ strategy: "WHATSAPP_AND_EMAIL_PARALLEL" });
    await expect(prisma.restaurantNotificationSettings.findUniqueOrThrow({ where: { restaurantId: otherRestaurantId } })).resolves.toMatchObject({ strategy: "WHATSAPP_ONLY" });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { restaurantId, action: "NOTIFICATION_STRATEGY_UPDATED" } });
    expect(audit).toMatchObject({ category: "CONFIGURATION", outcome: "SUCCESS", actorUserId: adminId, entityId: restaurantId, previousState: { strategy: "WHATSAPP_ONLY" }, newState: { strategy: "WHATSAPP_AND_EMAIL_PARALLEL" }, metadata: null });
    expect(JSON.stringify(audit)).not.toMatch(/destination|provider|payload/iu);
  });

  it("does not audit or rewrite a no-op", async () => {
    const before = await prisma.restaurantNotificationSettings.findUniqueOrThrow({ where: { restaurantId } });
    const response = await notificationSettingsPatch(request({ method: "PATCH", cookie: cookies.admin, origin: "http://localhost:3000", contentType: "application/json", body: JSON.stringify({ strategy: "WHATSAPP_ONLY" }) }));
    await expect(response.json()).resolves.toEqual({ strategy: "WHATSAPP_ONLY", changed: false });
    expect(await prisma.restaurantNotificationSettings.findUniqueOrThrow({ where: { restaurantId } })).toEqual(before);
    await expect(prisma.auditEvent.count({ where: { restaurantId, action: "NOTIFICATION_STRATEGY_UPDATED" } })).resolves.toBe(0);
  });

  it.each([
    ["wrong origin", { origin: "https://evil.example", contentType: "application/json", body: JSON.stringify({ strategy: "WHATSAPP_ONLY" }) }, 403],
    ["malformed JSON", { origin: "http://localhost:3000", contentType: "application/json", body: "{" }, 400],
    ["extra field", { origin: "http://localhost:3000", contentType: "application/json", body: JSON.stringify({ strategy: "WHATSAPP_ONLY", restaurantId: otherRestaurantId }) }, 400],
    ["missing JSON content type", { origin: "http://localhost:3000", contentType: "text/plain", body: JSON.stringify({ strategy: "WHATSAPP_ONLY" }) }, 415],
  ] as const)("rejects %s PATCH", async (_label, values, status) => {
    const response = await notificationSettingsPatch(request({ method: "PATCH", cookie: cookies.admin, ...values }));
    expect(response.status).toBe(status);
    await expect(prisma.restaurantNotificationSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ strategy: "WHATSAPP_ONLY" });
    await expect(prisma.auditEvent.count({ where: { restaurantId, action: "NOTIFICATION_STRATEGY_UPDATED" } })).resolves.toBe(0);
  });

  it("uses the authenticated tenant even when another Admin exists", async () => {
    const response = await notificationSettingsPatch(request({ method: "PATCH", cookie: cookies.otherAdmin, origin: "http://localhost:3000", contentType: "application/json", body: JSON.stringify({ strategy: "WHATSAPP_WITH_EMAIL_FALLBACK" }) }));
    expect(response.status).toBe(200);
    await expect(prisma.restaurantNotificationSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ strategy: "WHATSAPP_ONLY" });
    await expect(prisma.restaurantNotificationSettings.findUniqueOrThrow({ where: { restaurantId: otherRestaurantId } })).resolves.toMatchObject({ strategy: "WHATSAPP_WITH_EMAIL_FALLBACK" });
  });

  it("rolls back the strategy when audit persistence fails", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION m12_test_reject_notification_settings_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'NOTIFICATION_STRATEGY_UPDATED' THEN
          RAISE EXCEPTION 'synthetic M12 settings audit failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER m12_test_reject_notification_settings_audit_trigger
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION m12_test_reject_notification_settings_audit()
    `);
    try {
      const response = await notificationSettingsPatch(request({ method: "PATCH", cookie: cookies.admin, origin: "http://localhost:3000", contentType: "application/json", body: JSON.stringify({ strategy: "WHATSAPP_AND_EMAIL_PARALLEL" }) }));
      expect(response.status).toBe(500);
      await expect(prisma.restaurantNotificationSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ strategy: "WHATSAPP_ONLY" });
      await expect(prisma.auditEvent.count({ where: { restaurantId, action: "NOTIFICATION_STRATEGY_UPDATED" } })).resolves.toBe(0);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS m12_test_reject_notification_settings_audit_trigger ON audit_events");
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS m12_test_reject_notification_settings_audit()");
    }
  });
});
