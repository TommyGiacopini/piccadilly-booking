import "dotenv/config";

import { expect, test, type Page } from "@playwright/test";

import { e2eAdminUsername, e2eStaffUsername } from "./e2e-run";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variabile E2E ${name} non configurata.`);
  return value;
}

const staffPassword = requiredEnvironment("AUTH_DEMO_STAFF_PASSWORD");
const adminPassword = requiredEnvironment("AUTH_DEMO_ADMIN_PASSWORD");

async function expectExactLoginReturnTo(page: Page, returnTo: string) {
  await expect(page).toHaveURL((url) => {
    const parameters = [...url.searchParams.entries()];
    return (
      url.pathname === "/login" &&
      parameters.length === 1 &&
      parameters[0]?.[0] === "returnTo" &&
      parameters[0]?.[1] === returnTo
    );
  });
  await expect(page.locator('input[name="returnTo"]')).toHaveValue(returnTo);
}

async function submitLogin(page: Page, role: "ADMIN" | "STAFF") {
  await page
    .getByLabel("Username")
    .fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page
    .getByLabel("Password")
    .fill(role === "ADMIN" ? adminPassword : staffPassword);
  await page.getByRole("button", { name: "Accedi" }).click();
}

test.describe("T01 route-specific auth returnTo", () => {
  test("Staff child preserves exact returnTo and completes the login flow", async ({
    page,
  }) => {
    const destination = "/dashboard/reservations/new";

    await page.goto(destination);
    await expectExactLoginReturnTo(page, destination);
    await submitLogin(page, "STAFF");

    await expect(page).toHaveURL(`http://localhost:4000${destination}`);
    await expect(page.locator("[data-staff-shell]")).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Navigazione area Staff" })
        .getByRole("link", { name: "Nuova prenotazione" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: "Prenotazione telefonica rapida" }),
    ).toBeVisible();
  });

  test("Admin configuration preserves exact returnTo and completes the login flow", async ({
    page,
  }) => {
    const destination = "/admin/configuration";

    await page.goto(destination);
    await expectExactLoginReturnTo(page, destination);
    await submitLogin(page, "ADMIN");

    await expect(page).toHaveURL(`http://localhost:4000${destination}`);
    await expect(page.locator("[data-staff-shell]")).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Navigazione area Staff" })
        .getByRole("link", { name: "Configurazioni" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("heading", { name: "Impostazioni operative" }),
    ).toBeVisible();
  });

  test("second Admin route preserves exact returnTo and remains Admin-only", async ({
    page,
  }) => {
    const destination = "/admin/users";

    await page.goto(destination);
    await expectExactLoginReturnTo(page, destination);
    await submitLogin(page, "ADMIN");

    await expect(page).toHaveURL(`http://localhost:4000${destination}`);
    await expect(page.locator("[data-staff-shell]")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Utenti e accessi" }),
    ).toBeVisible();
  });

  test("authenticated Staff keeps the existing exact Admin denial behavior", async ({
    page,
  }) => {
    await page.goto("/login");
    await submitLogin(page, "STAFF");
    await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);

    await page.goto("/admin/configuration");
    await expect(page).toHaveURL(
      "http://localhost:4000/dashboard?access=denied",
    );
    await expect(page.locator("[data-staff-shell]")).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Navigazione area Staff" })
        .getByRole("link", { name: "Admin" }),
    ).toHaveCount(0);
  });

  test("dynamic Staff edit route preserves its exact UUID returnTo", async ({
    page,
  }) => {
    const destination =
      "/dashboard/reservations/123e4567-e89b-42d3-a456-426614174000/edit";

    await page.goto(destination);
    await expectExactLoginReturnTo(page, destination);
  });
});
