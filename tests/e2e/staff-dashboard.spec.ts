import "dotenv/config";

import { expect, test, type Page } from "@playwright/test";

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

const staffPassword = requiredEnvironment("AUTH_DEMO_STAFF_PASSWORD");
const adminPassword = requiredEnvironment("AUTH_DEMO_ADMIN_PASSWORD");

async function login(page: Page, role: "STAFF" | "ADMIN") {
  await page.goto("/login");
  const username = role === "STAFF" ? e2eStaffUsername : e2eAdminUsername;
  await page.getByLabel("Username").fill(username);
  await page
    .getByLabel("Password")
    .fill(role === "STAFF" ? staffPassword : adminPassword);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: /agosto|settembre|ottobre|novembre|dicembre|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio/i })).toBeVisible();
  await expect(
    page.getByText(
      `sessione ${username} (${role})`,
      { exact: false },
    ),
  ).toBeVisible();
}

async function openPhoneForm(page: Page, date: string) {
  await page.goto(`/dashboard/reservations/new?date=${date}`);
  await expect(
    page.getByRole("heading", { name: "Prenotazione telefonica rapida" }),
  ).toBeVisible();
  await page.getByLabel("Data").fill(date);
  await page.getByLabel("Servizio").selectOption("DINNER");
}

async function fillPhoneReservation(
  page: Page,
  input: {
    firstName: string;
    lastName: string;
    partySize: number;
    overrideReason?: string;
  },
) {
  await page.getByLabel("Persone").fill(String(input.partySize));
  await expect(page.getByLabel("Slot configurato").locator("option[value='19:00']")).toHaveCount(1);
  await page.getByLabel("Slot configurato").selectOption("19:00");
  await page.getByLabel("Nome", { exact: true }).fill(input.firstName);
  await page.getByLabel("Cognome", { exact: true }).fill(input.lastName);
  await page.getByLabel("Telefono").fill("+39 000 000 0900");
  await page.getByLabel("Sala preferita (non garantita)").selectOption({ index: 1 });
  await page.getByLabel(/Confermo di avere acquisito verbalmente/).check();

  if (input.overrideReason) {
    await page.getByLabel(/Override esplicito della sola capacità/).check();
    await page.getByLabel("Motivo dell'override").fill(input.overrideReason);
  }

  await page
    .getByRole("button", { name: "Salva prenotazione telefonica" })
    .click();
  await expect(
    page.getByText("Prenotazione telefonica salvata e capacità aggiornata."),
  ).toBeVisible();
}

async function cancelCreatedReservation(
  page: Page,
  fullName: string,
  overrideReason?: string,
) {
  await page.getByRole("link", { name: "Torna alla dashboard" }).click();
  const card = page.locator("article").filter({ hasText: fullName }).last();
  await expect(card).toBeVisible();
  if (overrideReason) await expect(card).toContainText(overrideReason);
  await card.getByRole("button", { name: "Cancella" }).click();
  const cancellationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      /\/api\/staff\/reservations\/[0-9a-f-]+$/u.test(
        new URL(response.url()).pathname,
      ),
  );
  await card.getByRole("button", { name: "Sì, cancella" }).click();
  expect((await cancellationResponse).status()).toBe(200);
  await expect(card).toContainText("Cancellata");
}

test.describe("M8 dashboard Staff/Admin", () => {
  test("nega l'accesso anonimo, applica i filtri e resta usabile sui viewport essenziali", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    const anonymousAvailability = await page.request.get(
      "/api/staff/availability?date=2099-11-18&service=DINNER&partySize=2",
    );
    expect(anonymousAvailability.status()).toBe(401);
    expect(anonymousAvailability.headers()["cache-control"]).toContain("no-store");
    await login(page, "STAFF");

    const dashboardResponse = await page.goto("/dashboard");
    expect(dashboardResponse?.status()).toBe(200);
    expect(dashboardResponse?.headers()["cache-control"]).toContain("no-store");

    await page.getByLabel("Servizio").selectOption("DINNER");
    await page.getByLabel("Stato").selectOption("CONFIRMED");
    await page.getByLabel("Origine").selectOption("PHONE");
    await page.getByRole("button", { name: "Applica filtri" }).click();
    await expect(page).toHaveURL(/service=DINNER.*status=CONFIRMED.*origin=PHONE/);

    for (const viewport of [
      { width: 390, height: 844 },
      { width: 820, height: 1180 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(page.getByText("Dashboard operativa", { exact: false })).toBeVisible();
      await expect(page.getByRole("link", { name: "+ Telefonica" })).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
    }
  });

  test("lo Staff inserisce, modifica e cancella logicamente una telefonica", async ({
    page,
  }) => {
    const suffix = String(Date.now());
    const firstName = e2eReservationFirstName;
    const lastName = `Staff ${suffix}`;
    const date = "2099-11-18";

    await login(page, "STAFF");
    await openPhoneForm(page, date);
    await fillPhoneReservation(page, { firstName, lastName, partySize: 2 });
    await page
      .getByRole("button", { name: "Salva prenotazione telefonica" })
      .click();
    await expect(
      page.getByText(
        "Questa richiesta era già stata registrata: nessun duplicato creato.",
      ),
    ).toBeVisible();
    await page.getByRole("link", { name: "Torna alla dashboard" }).click();

    const matchingCards = page
      .locator("article")
      .filter({ hasText: `${firstName} ${lastName}` });
    await expect(matchingCards).toHaveCount(1);
    const card = matchingCards.last();
    await expect(card).toContainText("Telefonica");
    await page.getByLabel("Origine").selectOption("PUBLIC");
    await page.getByRole("button", { name: "Applica filtri" }).click();
    await expect(
      page.locator("article").filter({ hasText: `${firstName} ${lastName}` }),
    ).toHaveCount(0);
    await page.getByLabel("Origine").selectOption("PHONE");
    await page.getByRole("button", { name: "Applica filtri" }).click();

    const filteredCard = page
      .locator("article")
      .filter({ hasText: `${firstName} ${lastName}` })
      .last();
    await expect(filteredCard).toContainText("Telefonica");
    await filteredCard.getByRole("link", { name: "Modifica" }).click();
    await page.getByLabel("Telefono").fill("+39 000 000 0999");
    await page.getByLabel("Note").fill("Aggiornamento E2E fittizio");
    await page.getByRole("button", { name: "Salva modifiche" }).click();
    await expect(page.getByText("Prenotazione aggiornata.", { exact: false })).toBeVisible();
    await page.getByRole("link", { name: "Torna alla dashboard" }).click();

    const updatedCard = page.locator("article").filter({ hasText: `${firstName} ${lastName}` }).last();
    await expect(updatedCard).toContainText("+39 000 000 0999");
    await expect(updatedCard).toContainText("Ultimo aggiornamento");
    await updatedCard.getByRole("button", { name: "Cancella" }).click();
    const cancellationResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        /\/api\/staff\/reservations\/[0-9a-f-]+$/u.test(
          new URL(response.url()).pathname,
        ),
    );
    await updatedCard.getByRole("button", { name: "Sì, cancella" }).click();
    expect((await cancellationResponse).status()).toBe(200);
    await expect(updatedCard).toContainText("Cancellata");
    await page.getByLabel("Stato").selectOption("CANCELLED");
    await page.getByRole("button", { name: "Applica filtri" }).click();
    await expect(
      page.locator("article").filter({ hasText: `${firstName} ${lastName}` }).last(),
    ).toContainText("Cancellata");
  });

  test("lo Staff applica un override esplicito con motivazione", async ({ page }) => {
    const lastName = `Override Staff ${Date.now()}`;
    await login(page, "STAFF");
    await openPhoneForm(page, "2099-11-19");
    await fillPhoneReservation(page, {
      firstName: e2eReservationFirstName,
      lastName,
      partySize: 31,
      overrideReason: "Override E2E Staff fittizio",
    });
    await cancelCreatedReservation(
      page,
      `${e2eReservationFirstName} ${lastName}`,
      "Override E2E Staff fittizio",
    );
  });

  test("l'Admin accede e applica lo stesso override autorizzato", async ({ page }) => {
    const lastName = `Override Admin ${Date.now()}`;
    await login(page, "ADMIN");
    await openPhoneForm(page, "2099-11-20");
    await fillPhoneReservation(page, {
      firstName: e2eReservationFirstName,
      lastName,
      partySize: 31,
      overrideReason: "Override E2E Admin fittizio",
    });
    await cancelCreatedReservation(
      page,
      `${e2eReservationFirstName} ${lastName}`,
      "Override E2E Admin fittizio",
    );
  });
});
