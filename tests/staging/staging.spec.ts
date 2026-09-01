import { randomUUID } from "node:crypto";

import { expect, request, test, type Page } from "@playwright/test";

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
}

async function logout(page: Page) {
  const response = await page.request.post("/api/auth/logout", {
    headers: { origin },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

function publicPayload(arrivalTime = "19:00") {
  return {
    localDate,
    serviceType: "DINNER",
    arrivalTime,
    partySize: 2,
    roomCode: "sala-1",
    highChair: false,
    stroller: false,
    accessibility: false,
    children: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: `${prefix}PUBLIC-NOTES`,
    customerFirstName: `${prefix}PUBLIC-FIRST`,
    customerLastName: `${prefix}PUBLIC-LAST`,
    customerPhone: "+390000001301",
    customerEmail: `${staging.runId.toLowerCase()}-public@example.test`,
    language: "it",
    privacyAccepted: true,
    termsAccepted: true,
  };
}

function staffPayload() {
  return {
    localDate,
    serviceType: "DINNER",
    arrivalTime: "19:30",
    partySize: 2,
    roomCode: "sala-1",
    customerFirstName: `${prefix}STAFF-FIRST`,
    customerLastName: `${prefix}STAFF-LAST`,
    customerPhone: "+390000001302",
    customerEmail: `${staging.runId.toLowerCase()}-staff@example.test`,
    highChair: false,
    stroller: false,
    accessibility: false,
    children: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: `${prefix}STAFF-NOTES`,
    verbalConsentConfirmed: true,
    sendWhatsAppConfirmation: false,
    capacityOverride: false,
    capacityOverrideReason: null,
  };
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

  test("public booking and management update/cancel", async ({ page }) => {
    const createdResponse = await page.request.post("/api/public/reservations", {
      headers: { origin, "Idempotency-Key": randomUUID() },
      data: publicPayload(),
    });
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    const created = (await createdResponse.json()) as { managementPath: string };
    expect(created.managementPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/);

    const managementPage = await page.goto(created.managementPath);
    expect(managementPage?.status()).toBe(200);
    expect(managementPage?.headers()["x-robots-tag"]).toContain("noindex");

    const token = created.managementPath.slice(3);
    const changed = publicPayload("19:15");
    const updateResponse = await page.request.patch(
      `/api/public/reservations/${token}`,
      {
        headers: { origin },
        data: {
          localDate: changed.localDate,
          serviceType: changed.serviceType,
          arrivalTime: changed.arrivalTime,
          partySize: changed.partySize,
          roomCode: changed.roomCode,
          highChair: changed.highChair,
          stroller: changed.stroller,
          accessibility: changed.accessibility,
          children: changed.children,
          celiac: changed.celiac,
          allergies: changed.allergies,
          intolerances: changed.intolerances,
          celebration: changed.celebration,
          animals: changed.animals,
          notes: changed.notes,
        },
      },
    );
    expect(updateResponse.ok(), await updateResponse.text()).toBe(true);

    const cancelResponse = await page.request.delete(
      `/api/public/reservations/${token}`,
      { headers: { origin }, data: {} },
    );
    expect(cancelResponse.ok(), await cancelResponse.text()).toBe(true);
  });

  test("Staff phone opt-out, assignment, PDF/Excel and Origin security", async ({
    page,
  }) => {
    await login(page, "staff");
    try {
      await page.goto(`/dashboard?date=${localDate}`);
      await expect(page.getByText(/sessione .* \(STAFF\)/i)).toBeVisible();

    const createdResponse = await page.request.post("/api/staff/reservations", {
      headers: { origin, "Idempotency-Key": randomUUID() },
      data: staffPayload(),
    });
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    const created = (await createdResponse.json()) as {
      reservation: { id: string; version: number };
    };

    const contextResponse = await page.request.get(
      `/api/staff/reservations/${created.reservation.id}/assignment`,
    );
    expect(contextResponse.ok(), await contextResponse.text()).toBe(true);
    const assignmentContext = (await contextResponse.json()) as {
      reservation: { version: number };
      rooms: Array<{
        id: string;
        code: string;
        isActive: boolean;
        isAvailableForService: boolean | null;
        tables: Array<{ id: string; isActive: boolean }>;
      }>;
    };
    const room = assignmentContext.rooms.find(
      (candidate) =>
        candidate.code === "sala-1" &&
        candidate.isActive &&
        candidate.isAvailableForService !== false,
    );
    const table = room?.tables.find((candidate) => candidate.isActive);
    expect(room).toBeTruthy();
    expect(table).toBeTruthy();
    const assigned = await page.request.put(
      `/api/staff/reservations/${created.reservation.id}/assignment`,
      {
        headers: { origin },
        data: {
          version: assignmentContext.reservation.version,
          roomId: room?.id,
          tableIds: [table?.id],
          internalNotes: `${prefix}ASSIGNMENT`,
        },
      },
    );
    expect(assigned.ok(), await assigned.text()).toBe(true);

    const pdf = await page.request.post("/api/staff/exports/pdf", {
      headers: { origin },
      data: { date: localDate },
    });
    expect(pdf.status(), await pdf.text()).toBe(200);
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

    const excel = await page.request.post("/api/staff/exports/excel", {
      headers: { origin },
      data: { mode: "DAY", date: localDate },
    });
    expect(excel.status(), await excel.text()).toBe(200);
    expect((await excel.body()).subarray(0, 2).toString()).toBe("PK");

    const wrongOrigin = await page.request.post("/api/staff/exports/pdf", {
      headers: { origin: "https://evil.example" },
      data: { date: localDate },
    });
      expect(wrongOrigin.status()).toBe(403);
    } finally {
      await logout(page);
    }
  });

  test("Admin configuration and notification settings smoke", async ({ page }) => {
    await login(page, "admin");
    try {
      const configuration = await page.goto("/admin/configuration");
      expect(configuration?.status()).toBe(200);
      await expect(
        page.getByRole("heading", { name: /Configurazione|Impostazioni/i }),
      ).toBeVisible();
      await page.goto("/admin/notification-settings");
      await expect(
        page.getByRole("heading", { name: "Strategia notifiche" }),
      ).toBeVisible();
      const settings = await page.request.get("/api/admin/notification-settings");
      expect(settings.ok(), await settings.text()).toBe(true);
      expect(await settings.json()).toMatchObject({
        configuration: { strategy: "WHATSAPP_ONLY" },
      });
    } finally {
      await logout(page);
    }
  });
});
