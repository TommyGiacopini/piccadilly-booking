import "dotenv/config";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { localReservationInstant } from "../../src/modules/reservations/domain/management-time";
import { e2eReservationFirstName } from "./e2e-run";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variabile E2E ${name} non configurata.`);
  return value;
}

const adminPassword = requiredEnvironment("AUTH_DEMO_ADMIN_PASSWORD");
const staffPassword = requiredEnvironment("AUTH_DEMO_STAFF_PASSWORD");
const origin = "http://localhost:4000";

interface AdminConfiguration {
  contacts: {
    publicPhone: string;
    publicBookingBaseUrl: string;
    publicEmail: string | null;
    whatsappNumber: string | null;
  };
  contents: Record<"IT" | "EN", Record<string, string>>;
  managementLinkDurationHours: number;
  fingerprints: { contacts: string; contents: string; duration: string };
}

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/);
}

async function readConfiguration(request: APIRequestContext) {
  const response = await request.get("/api/admin/public-settings");
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.headers()["cache-control"]).toContain("no-store");
  return (await response.json()).configuration as AdminConfiguration;
}

async function save(
  request: APIRequestContext,
  part: "contacts" | "content" | "link-duration",
  payload: unknown,
) {
  const response = await request.post(`/api/admin/public-settings/${part}`, {
    headers: { origin },
    data: payload,
  });
  expect(response.ok(), await response.text()).toBe(true);
}

function publicPayload(localDate: string, arrivalTime = "19:00") {
  return {
    localDate,
    serviceType: "DINNER",
    arrivalTime,
    partySize: 2,
    roomCode: "sala-1",
    customerFirstName: e2eReservationFirstName,
    customerLastName: "M9-E Fixture",
    customerPhone: "+390000000002",
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
    notes: "Fixture fittizia M9-E",
    language: "it",
    privacyAccepted: true,
    termsAccepted: true,
  };
}

async function createPublicReservation(
  request: APIRequestContext,
  localDate: string,
  arrivalTime = "19:00",
) {
  const response = await request.post("/api/public/reservations", {
    headers: { origin, "Idempotency-Key": crypto.randomUUID() },
    data: publicPayload(localDate, arrivalTime),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as {
    managementPath: string;
    reservation: { viewExpiresAt: string };
  };
}

function tokenFromPath(path: string): string {
  return path.slice("/p/".length);
}

test.describe.serial("M9-E configurazione pubblica", () => {
  test("Admin modifica contatti fittizi e il pubblico li visualizza", async ({
    page,
  }) => {
    await login(page, "e2e.admin", adminPassword);
    const original = await readConfiguration(page.request);
    try {
      await save(page.request, "contacts", {
        fingerprint: original.fingerprints.contacts,
        contacts: {
          publicPhone: "+390000000123",
          publicBookingBaseUrl: "https://e2e.example.test/",
          publicEmail: "e2e@example.test",
          whatsappNumber: "+390000000124",
        },
      });
      await page.goto("/prenota?lang=it");
      await expect(page.getByRole("link", { name: "Telefona" })).toHaveAttribute(
        "href",
        "tel:+390000000123",
      );
      await expect(page.getByRole("link", { name: "Email" })).toHaveAttribute(
        "href",
        "mailto:e2e@example.test",
      );
      await expect(page.getByRole("link", { name: "WhatsApp" })).toHaveAttribute(
        "href",
        "https://wa.me/390000000124",
      );
    } finally {
      const current = await readConfiguration(page.request);
      await save(page.request, "contacts", {
        fingerprint: current.fingerprints.contacts,
        contacts: original.contacts,
      });
    }
  });

  test("contenuti IT/EN seguono il selettore e preservano lang", async ({ page }) => {
    await login(page, "e2e.admin", adminPassword);
    const original = await readConfiguration(page.request);
    const changed = structuredClone(original.contents);
    changed.IT.BOOKING_PAGE_TITLE = "Titolo E2E italiano";
    changed.EN.BOOKING_PAGE_TITLE = "English E2E title";
    try {
      await save(page.request, "content", {
        fingerprint: original.fingerprints.contents,
        contents: changed,
      });
      await page.goto("/prenota");
      await expect(page.getByRole("heading", { name: "Titolo E2E italiano" })).toBeVisible();
      await page.getByRole("button", { name: "EN", exact: true }).click();
      await expect(page.getByRole("heading", { name: "English E2E title" })).toBeVisible();
      await expect(page).toHaveURL(/lang=en/);
      await page.reload();
      await expect(page.getByRole("heading", { name: "English E2E title" })).toBeVisible();
      await page.goto("/prenota?lang=unknown");
      await expect(page.getByRole("heading", { name: "Titolo E2E italiano" })).toBeVisible();
    } finally {
      const current = await readConfiguration(page.request);
      await save(page.request, "content", {
        fingerprint: current.fingerprints.contents,
        contents: original.contents,
      });
    }
  });

  test("durata prospettica e reschedule conservano il valore originario", async ({
    page,
  }) => {
    await login(page, "e2e.admin", adminPassword);
    const original = await readConfiguration(page.request);
    const changedDuration = original.managementLinkDurationHours === 6 ? 12 : 6;
    try {
      const before = await createPublicReservation(page.request, "2099-12-10");
      const oldToken = tokenFromPath(before.managementPath);
      const oldView = await page.request.get(`/api/public/reservations/${oldToken}`);
      const oldReservation = (await oldView.json()).reservation as {
        viewExpiresAt: string;
      };

      await save(page.request, "link-duration", {
        fingerprint: original.fingerprints.duration,
        managementLinkDurationHours: changedDuration,
      });
      const unchangedView = await page.request.get(
        `/api/public/reservations/${oldToken}`,
      );
      await expect(unchangedView.json()).resolves.toMatchObject({
        reservation: { viewExpiresAt: oldReservation.viewExpiresAt },
      });

      const after = await createPublicReservation(page.request, "2099-12-11");
      const expectedNewExpiry =
        localReservationInstant("2099-12-11", "19:00", "Europe/Rome").getTime() +
        changedDuration * 60 * 60 * 1_000;
      expect(new Date(after.reservation.viewExpiresAt).getTime()).toBe(
        expectedNewExpiry,
      );

      const update = await page.request.patch(
        `/api/public/reservations/${oldToken}`,
        {
          headers: { origin },
          data: {
            ...publicPayload("2099-12-12", "19:30"),
            customerFirstName: undefined,
            customerLastName: undefined,
            customerPhone: undefined,
            customerEmail: undefined,
            language: undefined,
            privacyAccepted: undefined,
            termsAccepted: undefined,
          },
        },
      );
      expect(update.ok(), await update.text()).toBe(true);
      const updated = (await update.json()).reservation as {
        viewExpiresAt: string;
      };
      const expectedOldDurationExpiry =
        localReservationInstant("2099-12-12", "19:30", "Europe/Rome").getTime() +
        original.managementLinkDurationHours * 60 * 60 * 1_000;
      expect(new Date(updated.viewExpiresAt).getTime()).toBe(
        expectedOldDurationExpiry,
      );
    } finally {
      const current = await readConfiguration(page.request);
      await save(page.request, "link-duration", {
        fingerprint: current.fingerprints.duration,
        managementLinkDurationHours: original.managementLinkDurationHours,
      });
    }
  });

  test("Staff e anonimo non accedono alla configurazione", async ({
    browser,
    page,
  }) => {
    await login(page, "e2e.staff", staffPassword);
    await page.goto("/admin/public-settings");
    await expect(page).toHaveURL(/\/dashboard\?access=denied/);
    const response = await page.request.get("/api/admin/public-settings");
    expect(response.status()).toBe(403);

    const anonymous = await browser.newPage();
    try {
      await anonymous.goto("/admin/public-settings");
      await expect(anonymous).toHaveURL(/\/login\?returnTo=/);
      expect(
        (await anonymous.request.get("/api/admin/public-settings")).status(),
      ).toBe(401);
    } finally {
      await anonymous.close();
    }
  });

  test("payload editoriale incompleto o arbitrario non viene salvato", async ({
    page,
  }) => {
    await login(page, "e2e.admin", adminPassword);
    const before = await readConfiguration(page.request);
    const response = await page.request.post(
      "/api/admin/public-settings/content",
      {
        headers: { origin },
        data: {
          fingerprint: before.fingerprints.contents,
          contents: {
            ...before.contents,
            IT: { ...before.contents.IT, ARBITRARY: "Non ammesso" },
          },
        },
      },
    );
    expect(response.status()).toBe(400);
    expect(await readConfiguration(page.request)).toEqual(before);
  });

  test("UI Admin e pubblica non hanno overflow a 390, 820 e 1440 px", async ({
    page,
  }) => {
    await login(page, "e2e.admin", adminPassword);
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 820, height: 1_180 },
      { width: 1_440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      for (const path of ["/admin/public-settings", "/prenota?lang=en"]) {
        await page.goto(path);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      }
    }
  });
});
