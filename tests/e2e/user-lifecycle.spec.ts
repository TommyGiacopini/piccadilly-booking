import "dotenv/config";

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variabile E2E ${name} non configurata.`);
  return value;
}

const adminPassword = requiredEnvironment("AUTH_DEMO_ADMIN_PASSWORD");
const staffPassword = requiredEnvironment("AUTH_DEMO_STAFF_PASSWORD");
const e2eAdminId = "00000000-0000-4000-8000-000000000901";

async function loginAs(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Accedi" }).click();
}

async function loginAsDemoAdmin(page: Page) {
  await loginAs(page, "e2e.admin", adminPassword);
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 20_000 });
}

async function createUserAndReadTemporaryPassword(
  page: Page,
  username: string,
  role: "ADMIN" | "STAFF" = "STAFF",
): Promise<string> {
  await page.goto("/admin/users");
  const createSection = page
    .getByRole("heading", { name: "Crea account individuale" })
    .locator("..");
  await createSection.getByLabel("Username").fill(username);
  await createSection.getByLabel("Ruolo").selectOption(role);
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/admin/users") &&
      response.request().method() === "POST",
  );
  await createSection.getByRole("button", { name: "Crea utente" }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.headers()["cache-control"]).toContain("no-store");
  const output = page.locator("output");
  await expect(output).toBeVisible();
  const password = (await output.textContent())?.trim() ?? "";
  expect(password).toHaveLength(24);
  await page.getByRole("button", { name: "Ho salvato, chiudi" }).click();
  await expect(output).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => ({
        local: Object.values(localStorage),
        session: Object.values(sessionStorage),
        url: window.location.href,
        text: document.body.textContent ?? "",
      })),
    )
    .not.toEqual(
      expect.objectContaining({ text: expect.stringContaining(password) }),
    );
  const clientState = await page.evaluate(() => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
    url: window.location.href,
  }));
  expect(JSON.stringify(clientState)).not.toContain(password);
  await page.reload();
  await expect(page.locator("output")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(password);
  return password;
}

async function changePassword(page: Page, current: string, selected: string) {
  await expect(page).toHaveURL(/\/cambia-password$/);
  await page.getByLabel("Password attuale").fill(current);
  await page.getByLabel("Nuova password", { exact: true }).fill(selected);
  await page.getByLabel("Conferma nuova password").fill(selected);
  await page.getByRole("button", { name: "Cambia password" }).click();
  await expect(page).toHaveURL(/\/login\?passwordChanged=1$/, {
    timeout: 20_000,
  });
}

async function newStaffPage(browser: Browser): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test.describe.serial("M9-B gestione utenti e password", () => {
  test("Admin crea Staff, mostra la temporanea una volta e impone cambio e nuovo login", async ({
    page,
  }) => {
    const suffix = Date.now();
    const username = `e2e.staff.create.${suffix}`;
    const selectedPassword = `E2E scelta personale ${suffix} 😀`;

    await loginAsDemoAdmin(page);
    const temporaryPassword = await createUserAndReadTemporaryPassword(
      page,
      username,
    );
    const retry = await page.request.post("/api/admin/users", {
      headers: { origin: "http://localhost:4000" },
      data: { username, role: "STAFF" },
    });
    expect(retry.status()).toBe(409);
    expect(await retry.text()).not.toContain(temporaryPassword);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Logout" }).click();

    await loginAs(page, username, temporaryPassword);
    await expect(page).toHaveURL(/\/cambia-password$/);
    const blocked = await page.request.get(
      "/api/staff/availability?date=2099-11-18&service=DINNER&partySize=2",
    );
    expect(blocked.status()).toBe(403);
    await expect(blocked.json()).resolves.toEqual({
      error: "PASSWORD_CHANGE_REQUIRED",
    });
    await changePassword(page, temporaryPassword, selectedPassword);
    await loginAs(page, username, selectedPassword);
    await expect(page).toHaveURL(/\/dashboard(?:\?|$)/, { timeout: 20_000 });
  });

  test("reset Admin revoca la sessione Staff e richiede un nuovo cambio", async ({
    page,
    browser,
  }) => {
    const suffix = Date.now();
    const username = `e2e.staff.reset.${suffix}`;
    const selectedPassword = `E2E prima scelta ${suffix} !`;
    await loginAsDemoAdmin(page);
    const temporaryPassword = await createUserAndReadTemporaryPassword(
      page,
      username,
    );
    const staff = await newStaffPage(browser);

    try {
      await loginAs(staff.page, username, temporaryPassword);
      await changePassword(staff.page, temporaryPassword, selectedPassword);
      await loginAs(staff.page, username, selectedPassword);
      await expect(staff.page).toHaveURL(/\/dashboard(?:\?|$)/);

      await page.goto("/admin/users");
      const card = page.locator("article").filter({ hasText: username });
      page.once("dialog", (dialog) => dialog.accept());
      await card.getByRole("button", { name: "Reset password" }).click();
      const resetPassword = (await page.locator("output").textContent())?.trim() ?? "";
      expect(resetPassword).toHaveLength(24);
      await page.getByRole("button", { name: "Ho salvato, chiudi" }).click();

      const rejectedSession = await staff.page.request.get(
        "/api/staff/availability?date=2099-11-18&service=DINNER&partySize=2",
      );
      expect(rejectedSession.status()).toBe(401);
      await staff.page.goto("/dashboard");
      await expect(staff.page).toHaveURL(/\/login/);
      await loginAs(staff.page, username, resetPassword);
      await expect(staff.page).toHaveURL(/\/cambia-password$/);
    } finally {
      await staff.context.close();
    }
  });

  test("Admin non può disabilitare o retrocedere sé stesso né rimuovere l'ultimo Admin", async ({
    page,
  }) => {
    await loginAsDemoAdmin(page);
    await page.goto("/admin/users");
    const selfCard = page.locator("article").filter({ hasText: "e2e.admin" });
    await expect(selfCard.getByLabel("Ruolo")).toBeDisabled();
    await expect(selfCard.getByRole("button", { name: "Disattiva" })).toBeDisabled();

    const roleResponse = await page.request.patch(
      `/api/admin/users/${e2eAdminId}/role`,
      {
        headers: { origin: "http://localhost:4000" },
        data: { role: "STAFF" },
      },
    );
    expect(roleResponse.status()).toBe(409);
    expect((await roleResponse.json()).code).toBe("SELF_PROTECTED");

    const statusResponse = await page.request.patch(
      `/api/admin/users/${e2eAdminId}/status`,
      {
        headers: { origin: "http://localhost:4000" },
        data: { isActive: false },
      },
    );
    expect(statusResponse.status()).toBe(409);
    expect((await statusResponse.json()).code).toBe("SELF_PROTECTED");
  });

  test("Staff e anonimo non accedono alla gestione utenti o alle API", async ({
    browser,
  }) => {
    const anonymous = await newStaffPage(browser);
    const staff = await newStaffPage(browser);

    try {
      await anonymous.page.goto("/admin/users");
      await expect(anonymous.page).toHaveURL(/\/login/);
      const anonymousApi = await anonymous.page.request.post("/api/admin/users", {
        headers: { origin: "http://localhost:4000" },
        data: { username: `e2e.denied.${Date.now()}`, role: "STAFF" },
      });
      expect(anonymousApi.status()).toBe(401);

      await loginAs(staff.page, "e2e.staff", staffPassword);
      await expect(staff.page).toHaveURL(/\/dashboard(?:\?|$)/);
      await staff.page.goto("/admin/users");
      await expect(staff.page).toHaveURL(/\/dashboard\?access=denied/);
      const staffApi = await staff.page.request.post("/api/admin/users", {
        headers: { origin: "http://localhost:4000" },
        data: { username: `e2e.denied.staff.${Date.now()}`, role: "STAFF" },
      });
      expect(staffApi.status()).toBe(403);
    } finally {
      await anonymous.context.close();
      await staff.context.close();
    }
  });
});
