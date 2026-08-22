import "dotenv/config";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  e2eAdminUsername,
  e2eReservationFirstName,
  e2eStaffUsername,
} from "./e2e-run";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variabile E2E ${name} non configurata.`);
  return value;
}

const adminPassword = requiredEnvironment("AUTH_DEMO_ADMIN_PASSWORD");
const staffPassword = requiredEnvironment("AUTH_DEMO_STAFF_PASSWORD");
const origin = "http://localhost:4000";

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/);
}

async function preview(request: APIRequestContext, proposal: unknown) {
  const response = await request.post(
    "/api/admin/operational-configuration/preview",
    { headers: { origin }, data: proposal },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).preview as {
    proposal: unknown;
    fingerprint: string;
    changed: boolean;
    confirmationRequired: boolean;
  };
}

async function apply(request: APIRequestContext, proposal: unknown) {
  const current = await preview(request, proposal);
  if (!current.changed) return current;
  const response = await request.post(
    "/api/admin/operational-configuration/apply",
    {
      headers: { origin },
      data: { proposal, fingerprint: current.fingerprint },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return current;
}

async function readOperationalConfiguration(request: APIRequestContext) {
  const response = await request.get("/api/admin/operational-configuration");
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).configuration as {
    bookingCutoffRules: Array<{
      dayOfWeek: string;
      serviceType: string;
      isEnabled: boolean;
      cutoffTime: string;
    }>;
  };
}

function settingsProposal(capacity: number) {
  return {
    kind: "BOOKING_SETTINGS",
    rollingCapacityCovers: capacity,
    lunchModificationCutoff: "10:30",
    dinnerModificationCutoff: "17:30",
  };
}

function romeDateAndWeekday() {
  const now = new Date();
  const dateFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateParts = new Map(
    dateFormatter
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const date = `${dateParts.get("year")}-${dateParts.get("month")}-${dateParts.get("day")}`;
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Rome",
    weekday: "long",
  })
    .format(now)
    .toUpperCase();
  return { date, weekday };
}

async function createPhoneFixture(
  request: APIRequestContext,
  localDate = "2099-11-18",
  arrivalTime = "19:00",
) {
  const response = await request.post("/api/staff/reservations", {
    headers: {
      origin,
      "Idempotency-Key": crypto.randomUUID(),
    },
    data: {
      localDate,
      serviceType: "DINNER",
      arrivalTime,
      partySize: 2,
      roomCode: "sala-1",
      customerFirstName: e2eReservationFirstName,
      customerLastName: "Fixture",
      customerPhone: "+39000000000",
      customerEmail: null,
      highChair: false,
      stroller: false,
      accessibility: false,
      children: false,
      celiac: false,
      allergies: null,
      intolerances: null,
      celebration: null,
      animals: false,
      notes: null,
      verbalConsentConfirmed: true,
      capacityOverride: false,
      capacityOverrideReason: null,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).reservation as {
    id: string;
    localDate: string;
    partySize: number;
    version: number;
  };
}

test.describe.serial("M9-C configurazione con impatto", () => {
  test("Admin salva senza impatto e le pagine restano responsive", async ({
    page,
  }) => {
    await login(page, e2eAdminUsername, adminPassword);
    await apply(page.request, settingsProposal(30));
    await page.goto("/admin/configuration");
    await page.getByLabel("Capacità massima nella finestra").fill("31");
    await page.getByRole("button", { name: "Verifica e salva impostazioni" }).click();
    await expect(page.getByRole("status")).toContainText("Configurazione salvata");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 820, height: 1_180 },
      { width: 1_440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      for (const path of ["/admin/configuration", "/admin/schedules"]) {
        await page.goto(path);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      }
    }
  });

  test("riduzione con impatto richiede conferma e preserva la prenotazione", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    await apply(page.request, settingsProposal(30));
    const reservation = await createPhoneFixture(page.request);
    try {
      await page.goto("/admin/configuration");
      await page.getByLabel("Capacità massima nella finestra").fill("1");
      await page.getByRole("button", { name: "Verifica e salva impostazioni" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("Prenotazioni future coinvolte");
      await dialog.getByRole("button", { name: "Conferma e applica" }).click();
      await expect(dialog).toHaveCount(0);
      const persisted = await page.request.get(`/api/staff/reservations/${reservation.id}`);
      expect(persisted.ok()).toBe(true);
      await expect(persisted.json()).resolves.toMatchObject({
        reservation: {
          id: reservation.id,
          localDate: reservation.localDate,
          partySize: reservation.partySize,
          version: reservation.version,
          status: "CONFIRMED",
        },
      });
    } finally {
      await apply(page.request, settingsProposal(30));
    }
  });

  test("un cambiamento concorrente rende obsoleta l'anteprima", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    await apply(page.request, settingsProposal(30));
    await createPhoneFixture(page.request);
    await page.goto("/admin/configuration");
    await page.getByLabel("Capacità massima nella finestra").fill("1");
    await page.getByRole("button", { name: "Verifica e salva impostazioni" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    try {
      await apply(page.request, settingsProposal(29));
      await page.getByRole("dialog").getByRole("button", { name: "Conferma e applica" }).click();
      await expect(page.getByRole("status")).toContainText("sono cambiate");
      await expect(page.getByRole("dialog")).toBeVisible();
    } finally {
      await apply(page.request, settingsProposal(30));
    }
  });

  test("cutoff generico blocca il pubblico ma non il canale Staff", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    await apply(page.request, settingsProposal(30));
    const { date, weekday } = romeDateAndWeekday();
    const originalRule = (
      await readOperationalConfiguration(page.request)
    ).bookingCutoffRules.find(
      (rule) =>
        rule.dayOfWeek === weekday && rule.serviceType === "DINNER",
    );
    expect(originalRule).toBeTruthy();
    await apply(page.request, {
      kind: "BOOKING_CUTOFF_RULE",
      dayOfWeek: weekday,
      serviceType: "DINNER",
      isEnabled: true,
      cutoffTime: "00:00",
    });
    let scenarioError: unknown;
    let cleanupError: unknown;
    try {
      const query = `date=${date}&service=DINNER&partySize=1`;
      const [publicResponse, staffResponse] = await Promise.all([
        page.request.get(`/api/public/availability?${query}`),
        page.request.get(`/api/staff/availability?${query}`),
      ]);
      const publicBody = await publicResponse.json();
      const staffBody = await staffResponse.json();

      expect(publicResponse.ok()).toBe(true);
      expect(
        publicBody.slots.some(
          (slot: { reason?: string }) =>
            slot.reason === "ONLINE_CUTOFF_REACHED",
        ),
      ).toBe(true);
      expect(staffResponse.ok()).toBe(true);
      expect(
        staffBody.slots.some((slot: { available: boolean }) => slot.available),
      ).toBe(true);
      const staffSlot = staffBody.slots.find(
        (slot: { available: boolean; time: string }) => slot.available,
      );
      expect(staffSlot).toBeTruthy();
      await createPhoneFixture(page.request, date, staffSlot.time);
    } catch (error) {
      scenarioError = error;
    } finally {
      try {
        await apply(page.request, {
          kind: "BOOKING_CUTOFF_RULE",
          dayOfWeek: weekday,
          serviceType: "DINNER",
          isEnabled: originalRule!.isEnabled,
          cutoffTime: originalRule!.cutoffTime,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (scenarioError) {
      if (cleanupError) console.error("Operational cutoff cleanup also failed.", cleanupError);
      throw scenarioError;
    }
    if (cleanupError) throw cleanupError;
  });

  test("Staff e anonimo non accedono a pagina o API", async ({ browser }) => {
    const anonymousContext = await browser.newContext();
    const staffContext = await browser.newContext();
    const anonymous = await anonymousContext.newPage();
    const staff = await staffContext.newPage();
    try {
      await anonymous.goto("/admin/configuration");
      await expect(anonymous).toHaveURL(/\/login/);
      const anonymousApi = await anonymous.request.post(
        "/api/admin/operational-configuration/preview",
        { headers: { origin }, data: settingsProposal(30) },
      );
      expect(anonymousApi.status()).toBe(401);

      await login(staff, e2eStaffUsername, staffPassword);
      await staff.goto("/admin/configuration");
      await expect(staff).toHaveURL(/\/dashboard\?access=denied/);
      const staffApi = await staff.request.post(
        "/api/admin/operational-configuration/preview",
        { headers: { origin }, data: settingsProposal(30) },
      );
      expect(staffApi.status()).toBe(403);
    } finally {
      await anonymousContext.close();
      await staffContext.close();
    }
  });
});
