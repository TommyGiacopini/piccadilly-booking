import { expect, request, test, type Page } from "@playwright/test";
import { assignmentAndExports, phoneBooking, publicBookingAndManagement, sessionProof, type BookingFixture } from "./m13-booking-scenarios";

import {
  futureRestaurantDate,
  resolveStagingPlaywrightEnvironment,
} from "./environment";

const staging = resolveStagingPlaywrightEnvironment(process.env);
const origin = new URL(staging.baseURL).origin;
const localDate = futureRestaurantDate(new Date(), 7);
const prefix = `M13-${staging.runId}-`;

async function login(page: Page, role: "admin" | "staff") {
  const credentials = staging[role];
  await page.goto("/login");
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/login") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Accedi" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(303);
  expect(response.headers()["set-cookie"]).toMatch(/;\s*Secure(?:;|$)/i);
  await expect(page).toHaveURL(/\/dashboard/);
  const cookie = (await page.context().cookies()).find(value => value.name === "piccadilly_session");
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax", path: "/" });
  expect(response.headers()["set-cookie"]).not.toMatch(/;\s*Domain=/i);
  await sessionProof(page, role === "admin" ? "ADMIN" : "STAFF");
}

async function logout(page: Page) {
  const response = await page.request.post("/api/auth/logout", {
    headers: { origin },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

test.describe.serial("M13 personal staging acceptance", () => {
  test("Basic gate, banner, noindex, robots, health and responsive surfaces", async ({
    page,
  }) => {
    const anonymous = await request.newContext({ baseURL: staging.baseURL });
    try {
      const denied = await anonymous.get("/");
      expect(denied.status()).toBe(401);
      expect(denied.headers()["www-authenticate"]).toContain("Basic");
      expect(denied.headers()["cache-control"]).toBe("no-store");

      const health = await anonymous.get("/api/health");
      expect(health.status()).toBe(200);
      expect(await health.json()).toEqual({
        status: "ok",
        service: "piccadilly-booking",
        environment: "staging",
        database: "ok",
      });
      expect(health.headers()["cache-control"]).toBe("no-store");
      expect(health.headers()["x-content-type-options"]).toBe("nosniff");

      const robots = await anonymous.get("/robots.txt");
      expect(robots.status()).toBe(200);
      expect(await robots.text()).toContain("Disallow: /");
    } finally {
      await anonymous.dispose();
    }

    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto("/prenota?lang=it");
      expect(response?.headers()["x-robots-tag"]).toBe(
        "noindex, nofollow, noarchive",
      );
      await expect(
        page.getByText(
          "AMBIENTE DEMO/STAGING — DATI FITTIZI — NESSUN MESSAGGIO REALE",
        ),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
  });

  test("public booking and management update/cancel", async ({ page, browser }) => {
    const staffContext = await browser.newContext({ baseURL: staging.baseURL, httpCredentials: staging.basicAuth });
    const staff = await staffContext.newPage();
    await login(staff, "staff");
    try {
      await publicBookingAndManagement(page, staff, fixture("PUBLIC", 1, true));
    } finally {
      await logout(staff); await staffContext.close();
    }
  });

  test("Staff phone opt-out, assignment, PDF/Excel and Origin security", async ({ page }) => {
    await login(page, "staff");
    try {
      const input = fixture("STAFF", null, null);
      const created = await phoneBooking(page, input);
      await assignmentAndExports(page, input, created);
    } finally { await logout(page); }
  });

  test("Admin configuration and notification settings smoke", async ({ page }) => {
    await login(page, "admin");
    try {
      const configuration = await page.goto("/admin/configuration");
      expect(configuration?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: "Impostazioni operative", level: 1, exact: true })).toBeVisible();
      await page.goto("/admin/notification-settings");
      await expect(page.getByRole("heading", { name: "Strategia notifiche", exact: true })).toBeVisible();
      const settings = await page.request.get("/api/admin/notification-settings");
      expect(settings.status()).toBe(200);
      expect(await settings.json()).toMatchObject({ configuration: { strategy: "WHATSAPP_ONLY" } });
    } finally { await logout(page); }
  });
});

function fixture(kind: string, childrenCount: number | null, gameRoomPreference: boolean | null): BookingFixture {
  return {
    localDate, firstName: prefix + kind + "-FIRST", lastName: prefix + kind + "-LAST",
    email: staging.runId.toLowerCase() + "-" + kind.toLowerCase() + "@example.test",
    phone: kind === "PUBLIC" ? "+390000001301" : "+390000001302",
    notes: prefix + kind + "-NOTES", childrenCount, gameRoomPreference,
  };
}
