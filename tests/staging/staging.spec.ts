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

async function selectFirstRealOption(page: Page, label: string) {
  const option = page
    .getByLabel(label)
    .locator("option:not([value=''])")
    .first();
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute("value");
  expect(value).toBeTruthy();
  await page.getByLabel(label).selectOption(value!);
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
    let publicCreatePostCount = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/public/reservations"
      ) {
        publicCreatePostCount += 1;
      }
    });
    await page.goto("/prenota?lang=it");
    await page.getByLabel("Data").fill(localDate);
    await page.getByLabel("Servizio").selectOption("DINNER");
    await selectFirstRealOption(page, "Orario disponibile");
    await selectFirstRealOption(page, "Sala preferita");
    await page.getByLabel("Nome", { exact: true }).fill(`${prefix}PUBLIC-FIRST`);
    await page.getByLabel("Cognome", { exact: true }).fill(`${prefix}PUBLIC-LAST`);
    await page.getByLabel("Telefono").fill("+390000001301");
    await page
      .getByLabel("Email (facoltativa)")
      .fill(`${staging.runId.toLowerCase()}-public@example.test`);
    await page.getByLabel("Note (facoltative)").fill(`${prefix}PUBLIC-NOTES`);
    await page.getByLabel(/Accetto l.informativa privacy/).check();
    await page.getByLabel(/Accetto le condizioni di prenotazione/).check();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/public/reservations",
    );
    await page
      .getByRole("button", { name: "Conferma prenotazione" })
      .click();
    const createdResponse = await responsePromise;
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    expect(publicCreatePostCount).toBe(1);
    const created = (await createdResponse.json()) as { managementPath: string };
    expect(created.managementPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/);
    await expect(
      page.getByRole("link", { name: "Apri il tuo link personale" }),
    ).toHaveAttribute("href", `${created.managementPath}?lang=it`);

    const managementPage = await page.goto(created.managementPath);
    expect(managementPage?.status()).toBe(200);
    expect(managementPage?.headers()["x-robots-tag"]).toContain("noindex");

    const token = created.managementPath.slice(3);
    const updateResponse = await page.request.patch(
      `/api/public/reservations/${token}`,
      {
        headers: { origin },
        data: {
          localDate,
          serviceType: "DINNER",
          arrivalTime: "19:15",
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

    let phoneCreatePostCount = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/staff/reservations"
      ) {
        phoneCreatePostCount += 1;
      }
    });
    await page.goto(`/dashboard/reservations/new?date=${localDate}`);
    await page.getByLabel("Data").fill(localDate);
    await page.getByLabel("Servizio").selectOption("DINNER");
    await page.getByLabel("Persone").fill("2");
    await selectFirstRealOption(page, "Slot configurato");
    await selectFirstRealOption(page, "Sala preferita (non garantita)");
    await page.getByLabel("Nome", { exact: true }).fill(`${prefix}STAFF-FIRST`);
    await page.getByLabel("Cognome", { exact: true }).fill(`${prefix}STAFF-LAST`);
    await page.getByLabel("Telefono").fill("+390000001302");
    await page
      .getByLabel("Email (facoltativa)")
      .fill(`${staging.runId.toLowerCase()}-staff@example.test`);
    await page.getByLabel("Note").fill(`${prefix}STAFF-NOTES`);
    await page.getByLabel("Invia conferma WhatsApp").uncheck();
    await page.getByLabel(/Confermo di avere acquisito verbalmente/).check();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/staff/reservations",
    );
    await page
      .getByRole("button", { name: "Salva prenotazione telefonica" })
      .click();
    const createdResponse = await responsePromise;
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    expect(phoneCreatePostCount).toBe(1);
    await expect(
      page.getByText("Prenotazione telefonica salvata e capacità aggiornata."),
    ).toBeVisible();
    const created = (await createdResponse.json()) as {
      reservation: { id: string; version: number };
    };

    await page.goto(`/dashboard?date=${localDate}`);
    await expect(
      page.locator("article").filter({ hasText: `${prefix}STAFF-FIRST` }),
    ).toHaveCount(1);

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
