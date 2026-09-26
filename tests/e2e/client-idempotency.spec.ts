import "dotenv/config";

import { expect, test, type Page, type Request } from "@playwright/test";

import { e2eStaffUsername } from "./e2e-run";

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variabile E2E ${name} non configurata.`);
  return value;
}

const staffPassword = requiredEnvironment("AUTH_DEMO_STAFF_PASSWORD");

async function emulateLanCrypto(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });
}

async function emulateMissingCrypto(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(Crypto.prototype, "getRandomValues", {
      configurable: true,
      value: undefined,
    });
  });
}

function idempotencyKey(request: Request): string {
  return request.headers()["idempotency-key"] ?? "";
}

function formAlert(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

async function fillPublicReservation(page: Page): Promise<void> {
  await page.goto("/prenota");
  await page.getByLabel("Data").fill("2099-11-18");
  await expect(
    page.getByLabel("Orario disponibile").locator("option[value='19:00']"),
  ).toHaveCount(1);
  await page.getByLabel("Orario disponibile").selectOption("19:00");
  await page.getByLabel("Sala preferita").selectOption({ index: 1 });
  await page.getByLabel("Nome", { exact: true }).fill("E2E-UAT-Client");
  await page.getByLabel("Cognome", { exact: true }).fill("Public");
  await page.getByLabel("Telefono").fill("+39 000 000 0801");
  await page.getByLabel(/Accetto l.informativa privacy/).check();
  await page.getByLabel(/Accetto le condizioni di prenotazione/).check();
}

async function loginStaff(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Username").fill(e2eStaffUsername);
  await page.getByLabel("Password").fill(staffPassword);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u, { timeout: 20_000 });
}

async function fillPhoneReservation(page: Page): Promise<void> {
  await page.goto("/dashboard/reservations/new?date=2099-11-18");
  await page.getByLabel("Data").fill("2099-11-18");
  await page.getByLabel("Servizio").selectOption("DINNER");
  await page.getByLabel("Persone").fill("2");
  await expect(
    page.getByLabel("Slot configurato").locator("option[value='19:00']"),
  ).toHaveCount(1);
  await page.getByLabel("Slot configurato").selectOption("19:00");
  await page.getByLabel("Nome", { exact: true }).fill("E2E-UAT-Client");
  await page.getByLabel("Cognome", { exact: true }).fill("Phone");
  await page.getByLabel("Telefono").fill("+39 000 000 0802");
  await page
    .getByLabel("Sala preferita (non garantita)")
    .selectOption({ index: 1 });
  await page.getByLabel(/Confermo di avere acquisito verbalmente/).check();
}

test.describe("UAT client idempotency - public form", () => {
  test("submits once through the LAN-compatible fallback and reaches management state", async ({
    page,
  }) => {
    await emulateLanCrypto(page);
    const keys: string[] = [];
    await page.route("**/api/public/reservations", async (route) => {
      keys.push(idempotencyKey(route.request()));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ managementPath: "/p/e2e-management-token" }),
      });
    });

    await fillPublicReservation(page);
    await expect
      .poll(() =>
        page.evaluate(() => ({
          randomUUID: typeof crypto.randomUUID,
          getRandomValues: typeof crypto.getRandomValues,
        })),
      )
      .toEqual({ randomUUID: "undefined", getRandomValues: "function" });
    await page
      .getByRole("button", { name: "Conferma prenotazione" })
      .click();

    await expect(
      page.getByRole("link", { name: "Apri il tuo link personale" }),
    ).toBeVisible();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(uuidV4Pattern);
  });

  test("catches a synchronous secure-random failure without issuing a POST", async ({
    page,
  }) => {
    await emulateMissingCrypto(page);
    let postCount = 0;
    await page.route("**/api/public/reservations", async (route) => {
      postCount += 1;
      await route.abort();
    });

    await fillPublicReservation(page);
    await page
      .getByRole("button", { name: "Conferma prenotazione" })
      .click();

    await expect(formAlert(page)).toContainText(
      "Non è stato possibile completare la richiesta.",
    );
    await expect(
      page.getByRole("button", { name: "Conferma prenotazione" }),
    ).toBeEnabled();
    expect(postCount).toBe(0);
  });

  test("preserves the key across a network retry and exits submitting", async ({
    page,
  }) => {
    await emulateLanCrypto(page);
    const keys: string[] = [];
    await page.route("**/api/public/reservations", async (route) => {
      keys.push(idempotencyKey(route.request()));
      if (keys.length === 1) {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ managementPath: "/p/e2e-management-token" }),
      });
    });

    await fillPublicReservation(page);
    await page
      .getByRole("button", { name: "Conferma prenotazione" })
      .click();
    await expect(formAlert(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Conferma prenotazione" }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Conferma prenotazione" })
      .click();

    await expect(
      page.getByRole("link", { name: "Apri il tuo link personale" }),
    ).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test("shows an HTTP error and exits submitting", async ({ page }) => {
    await emulateLanCrypto(page);
    await page.route("**/api/public/reservations", async (route) => {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: "Errore HTTP simulato." }),
      });
    });

    await fillPublicReservation(page);
    await page
      .getByRole("button", { name: "Conferma prenotazione" })
      .click();

    await expect(formAlert(page)).toContainText(
      "Errore HTTP simulato.",
    );
    await expect(
      page.getByRole("button", { name: "Conferma prenotazione" }),
    ).toBeEnabled();
  });

  test("handles a malformed response without leaving submitting active", async ({
    page,
  }) => {
    await emulateLanCrypto(page);
    await page.route("**/api/public/reservations", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/plain", body: "invalid" });
    });

    await fillPublicReservation(page);
    await page
      .getByRole("button", { name: "Conferma prenotazione" })
      .click();

    await expect(formAlert(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Conferma prenotazione" }),
    ).toBeEnabled();
  });
});

test.describe("UAT client idempotency - phone form", () => {
  test("submits once through the LAN-compatible fallback and exits submitting", async ({
    page,
  }) => {
    await emulateLanCrypto(page);
    const keys: string[] = [];
    let releaseResponse: () => void = () => undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route("**/api/staff/reservations", async (route) => {
      keys.push(idempotencyKey(route.request()));
      await responseGate;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          replayed: false,
          reservation: { id: "11111111-1111-4111-8111-111111111111" },
        }),
      });
    });

    await loginStaff(page);
    await fillPhoneReservation(page);
    const submit = page.getByRole("button", {
      name: /Salva prenotazione telefonica|Salvataggio…/,
    });
    await submit.click();

    await expect.poll(() => keys.length).toBe(1);
    await expect(submit).toBeDisabled();
    await page.waitForTimeout(100);
    expect(keys).toHaveLength(1);
    releaseResponse();

    await expect(
      page.getByText("Prenotazione telefonica salvata e capacità aggiornata."),
    ).toBeVisible();
    await expect(submit).toBeEnabled();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(uuidV4Pattern);
  });

  test("catches a synchronous secure-random failure without issuing a POST", async ({
    page,
  }) => {
    await emulateMissingCrypto(page);
    let postCount = 0;
    await page.route("**/api/staff/reservations", async (route) => {
      postCount += 1;
      await route.abort();
    });

    await loginStaff(page);
    await fillPhoneReservation(page);
    await page
      .getByRole("button", { name: "Salva prenotazione telefonica" })
      .click();

    await expect(formAlert(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Salva prenotazione telefonica" }),
    ).toBeEnabled();
    expect(postCount).toBe(0);
  });

  test("reuses the key after network failure and replaces it for changed payload", async ({
    page,
  }) => {
    await emulateLanCrypto(page);
    const keys: string[] = [];
    await page.route("**/api/staff/reservations", async (route) => {
      keys.push(idempotencyKey(route.request()));
      if (keys.length === 1) {
        await route.abort("failed");
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          replayed: false,
          reservation: { id: "22222222-2222-4222-8222-222222222222" },
        }),
      });
    });

    await loginStaff(page);
    await fillPhoneReservation(page);
    const submit = page.getByRole("button", {
      name: "Salva prenotazione telefonica",
    });
    await submit.click();
    await expect(formAlert(page)).toBeVisible();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(
      page.getByText("Prenotazione telefonica salvata e capacità aggiornata."),
    ).toBeVisible();
    await page.getByLabel("Note").fill("Payload modificato");
    await submit.click();
    await expect.poll(() => keys.length).toBe(3);

    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(keys.every((key) => uuidV4Pattern.test(key))).toBe(true);
    await expect(submit).toBeEnabled();
  });

  test("uses a new key for an identical operation after a successful submit", async ({
    page,
  }) => {
    await emulateLanCrypto(page);
    const keys: string[] = [];
    await page.route("**/api/staff/reservations", async (route) => {
      keys.push(idempotencyKey(route.request()));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          replayed: false,
          reservation: {
            id:
              keys.length === 1
                ? "33333333-3333-4333-8333-333333333333"
                : "44444444-4444-4444-8444-444444444444",
          },
        }),
      });
    });

    await loginStaff(page);
    await fillPhoneReservation(page);
    const submit = page.getByRole("button", {
      name: "Salva prenotazione telefonica",
    });

    await submit.click();
    await expect.poll(() => keys.length).toBe(1);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => keys.length).toBe(2);
    await expect(submit).toBeEnabled();

    expect(keys[0]).toMatch(uuidV4Pattern);
    expect(keys[1]).toMatch(uuidV4Pattern);
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("preserves the key across malformed and incomplete responses", async ({
    page,
  }) => {
    await emulateLanCrypto(page);
    const keys: string[] = [];
    await page.route("**/api/staff/reservations", async (route) => {
      keys.push(idempotencyKey(route.request()));
      if (keys.length === 1) {
        await route.fulfill({
          status: 200,
          contentType: "text/plain",
          body: "invalid",
        });
        return;
      }
      if (keys.length === 2) {
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ replayed: false }),
        });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          replayed: false,
          reservation: { id: "55555555-5555-4555-8555-555555555555" },
        }),
      });
    });

    await loginStaff(page);
    await fillPhoneReservation(page);
    const submit = page.getByRole("button", {
      name: "Salva prenotazione telefonica",
    });

    await submit.click();
    await expect(formAlert(page)).toBeVisible();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(formAlert(page)).toBeVisible();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(
      page.getByText("Prenotazione telefonica salvata e capacità aggiornata."),
    ).toBeVisible();

    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(uuidV4Pattern);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    await expect(submit).toBeEnabled();
  });

  test("treats an empty reservation as recoverable failure and reuses the key", async ({
    page,
  }) => {
    await emulateLanCrypto(page);
    const keys: string[] = [];
    await page.route("**/api/staff/reservations", async (route) => {
      keys.push(idempotencyKey(route.request()));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(
          keys.length === 1
            ? { reservation: {} }
            : {
                replayed: false,
                reservation: {
                  id: "66666666-6666-4666-8666-666666666666",
                },
              },
        ),
      });
    });

    await loginStaff(page);
    await fillPhoneReservation(page);
    const submit = page.getByRole("button", {
      name: "Salva prenotazione telefonica",
    });

    await submit.click();
    await expect(formAlert(page)).toContainText(
      "Non è stato possibile creare la prenotazione.",
    );
    await expect(
      page.getByText("Prenotazione telefonica salvata e capacità aggiornata."),
    ).toHaveCount(0);
    await expect(submit).toBeEnabled();
    expect(keys).toHaveLength(1);

    await submit.click();
    await expect(
      page.getByText("Prenotazione telefonica salvata e capacità aggiornata."),
    ).toBeVisible();
    await expect(submit).toBeEnabled();

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(uuidV4Pattern);
    expect(keys[1]).toBe(keys[0]);
  });

  test("rejects empty, whitespace, and non-string reservation IDs without rotating the retry key", async ({
    page,
  }) => {
    await emulateLanCrypto(page);
    const invalidIds: unknown[] = ["", "   ", 123];
    const keys: string[] = [];
    let operation = 0;
    await page.route("**/api/staff/reservations", async (route) => {
      keys.push(idempotencyKey(route.request()));
      const isInvalidAttempt = keys.length % 2 === 1;
      const invalidId = invalidIds[operation];
      if (!isInvalidAttempt) operation += 1;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(
          isInvalidAttempt
            ? { reservation: { id: invalidId } }
            : {
                replayed: false,
                reservation: {
                  id: `${operation}`.repeat(8) + "-7777-4777-8777-777777777777",
                },
              },
        ),
      });
    });

    await loginStaff(page);
    await fillPhoneReservation(page);
    const submit = page.getByRole("button", {
      name: "Salva prenotazione telefonica",
    });

    for (let index = 0; index < invalidIds.length; index += 1) {
      await submit.click();
      await expect(formAlert(page)).toContainText(
        "Non è stato possibile creare la prenotazione.",
      );
      await expect(submit).toBeEnabled();
      await expect.poll(() => keys.length).toBe(index * 2 + 1);

      await submit.click();
      await expect(
        page.getByText("Prenotazione telefonica salvata e capacità aggiornata."),
      ).toBeVisible();
      await expect(submit).toBeEnabled();
      await expect.poll(() => keys.length).toBe(index * 2 + 2);

      expect(keys[index * 2]).toMatch(uuidV4Pattern);
      expect(keys[index * 2 + 1]).toBe(keys[index * 2]);
      if (index > 0) {
        expect(keys[index * 2]).not.toBe(keys[index * 2 - 1]);
      }
    }
  });

  test("keeps the key after an invalid body, retires it after valid success, and rotates for the next identical operation", async ({
    page,
  }) => {
    await emulateLanCrypto(page);
    const keys: string[] = [];
    await page.route("**/api/staff/reservations", async (route) => {
      keys.push(idempotencyKey(route.request()));
      const body =
        keys.length === 1
          ? { reservation: {} }
          : {
              replayed: false,
              reservation: {
                id:
                  keys.length === 2
                    ? "88888888-8888-4888-8888-888888888888"
                    : "99999999-9999-4999-8999-999999999999",
              },
            };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    });

    await loginStaff(page);
    await fillPhoneReservation(page);
    const submit = page.getByRole("button", {
      name: "Salva prenotazione telefonica",
    });
    const initialUrl = page.url();

    await submit.click();
    await expect(formAlert(page)).toContainText(
      "Non è stato possibile creare la prenotazione.",
    );
    await expect(submit).toBeEnabled();
    await expect.poll(() => keys.length).toBe(1);
    await expect(page).toHaveURL(initialUrl);

    await submit.click();
    await expect(
      page.getByText("Prenotazione telefonica salvata e capacità aggiornata."),
    ).toBeVisible();
    await expect(submit).toBeEnabled();
    await expect.poll(() => keys.length).toBe(2);
    await expect(page).toHaveURL(initialUrl);

    await submit.click();
    await expect.poll(() => keys.length).toBe(3);
    await expect(submit).toBeEnabled();
    await expect(page).toHaveURL(initialUrl);

    expect(keys[0]).toMatch(uuidV4Pattern);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toMatch(uuidV4Pattern);
    expect(keys[2]).not.toBe(keys[1]);
  });

  test("shows an HTTP error and exits submitting", async ({ page }) => {
    await emulateLanCrypto(page);
    await page.route("**/api/staff/reservations", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fallimento HTTP simulato." }),
      });
    });

    await loginStaff(page);
    await fillPhoneReservation(page);
    await page
      .getByRole("button", { name: "Salva prenotazione telefonica" })
      .click();

    await expect(formAlert(page)).toContainText(
      "Fallimento HTTP simulato.",
    );
    await expect(
      page.getByRole("button", { name: "Salva prenotazione telefonica" }),
    ).toBeEnabled();
  });
});
