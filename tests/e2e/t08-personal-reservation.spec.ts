import "dotenv/config";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { Pool } from "pg";
import { e2eReservationFirstName, e2eRunId, e2eRestaurantId } from "./e2e-run";

const target = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname)) throw new Error("T08_TEMPORARY_DATABASE_REQUIRED");
const database = new Pool({ connectionString: process.env.DATABASE_URL });
test.afterAll(async () => database.end());
// Quota isolation is fixture setup only; server limits are never changed.
test.beforeEach(async () => { await database.query("DELETE FROM public_reservation_rate_limits WHERE restaurant_id=$1", [e2eRestaurantId]); });
async function create(request: APIRequestContext, suffix: string) {
  const response = await request.post("/api/public/reservations", {
    headers: { origin: "http://localhost:4000", "Idempotency-Key": crypto.randomUUID() },
    data: {
      localDate: "2099-10-29", serviceType: "DINNER", arrivalTime: "20:00", partySize: 2,
      childrenCount: 1, gameRoomPreference: true, customerFirstName: e2eReservationFirstName,
      customerLastName: "T08 OBS " + suffix + " " + e2eRunId, customerPhone: "+390000000808", customerEmail: null,
      highChair: false, stroller: false, accessibility: false, celiac: false, animals: false,
      allergies: null, intolerances: null, celebration: null, notes: "T08_SERVER_BASELINE",
      language: "it", privacyAccepted: true, termsAccepted: true,
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).managementPath as string;
}
async function cancel(request: APIRequestContext, path: string) {
  const response = await request.delete("/api/public/reservations/" + path.split("/").at(-1), { headers: { origin: "http://localhost:4000" }, data: {} });
  expect(response.ok()).toBe(true);
}
test("E05 DIRTY IT EN IT never reloads business data or resets composition", async ({ page }) => {
  const path = await create(page.request, "language");
  let gets = 0;
  page.on("request", request => { if (request.method() === "GET" && new URL(request.url()).pathname === "/api/public/reservations/" + path.split("/").at(-1)) ++gets; });
  await page.goto(path);
  await page.getByRole("textbox", { name: "Note", exact: true }).fill("T08_DIRTY_OBS01");
  await page.getByRole("textbox", { name: "Allergie", exact: true }).fill("T08_UNSENT_ALLERGY");
  await page.getByLabel("Quanti bambini ci sono?", { exact: true }).fill("2");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("T08_DIRTY_OBS01");
  await expect(page.getByLabel("How many children are there?", { exact: true })).toHaveValue("2");
  await page.getByRole("button", { name: "IT", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Note", exact: true })).toHaveValue("T08_DIRTY_OBS01");
  await expect(page.getByRole("textbox", { name: "Allergie", exact: true })).toHaveValue("T08_UNSENT_ALLERGY");
  expect(gets).toBe(1);
  const current = await page.request.get("/api/public/reservations/" + path.split("/").at(-1));
  expect((await current.json()).reservation.notes).toBe("T08_SERVER_BASELINE");
  await cancel(page.request, path);
});
test("E05 delayed initial GET gates editing; later language changes retain the draft", async ({ page }) => {
  const path = await create(page.request, "delayed");
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  let gets = 0;
  await page.route("**/api/public/reservations/*", async route => {
    if (route.request().method() !== "GET") return route.continue();
    ++gets; const response = await route.fetch(); await held; await route.fulfill({ response });
  });
  await page.goto(path);
  await expect(page.getByRole("textbox", { name: "Note", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Salva modifiche", exact: true })).toHaveCount(0);
  release(); await page.getByRole("textbox", { name: "Note", exact: true }).fill("T08_AFTER_INITIAL_GET");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("T08_AFTER_INITIAL_GET");
  expect(gets).toBe(1);
  await cancel(page.request, path);
});
test("E05 failed GET does not authorize display or mutations", async ({ page }) => {
  const path = await create(page.request, "failed");
  await page.route("**/api/public/reservations/*", route => route.fulfill({ status: 500, json: { error: "Synthetic" } }));
  await page.goto(path + "?lang=en");
  await expect(page.getByText("The link is invalid or no longer available.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);
  await expect(page.getByText("T08_SERVER_BASELINE")).toHaveCount(0);
  await page.unrouteAll(); await cancel(page.request, path);
});
test("E05 language switch during a delayed successful PATCH cannot reinitialize the saved draft", async ({ page }) => {
  const path = await create(page.request, "save");
  let gets = 0; let patches = 0;
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/public/reservations/*", async route => {
    if (route.request().method() === "GET") { ++gets; return route.continue(); }
    if (route.request().method() !== "PATCH") return route.continue();
    ++patches; const response = await route.fetch(); await held; await route.fulfill({ response });
  });
  await page.goto(path); await page.getByRole("textbox", { name: "Note", exact: true }).fill("T08_SAVED_DURING_LANGUAGE");
  await page.getByRole("button", { name: "Salva modifiche", exact: true }).click();
  await expect.poll(() => patches).toBe(1);
  await expect(page.getByRole("textbox", { name: "Note", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  expect(gets).toBe(1);
  release(); await expect(page.locator('p[role="status"]').filter({ hasText: "Booking updated." })).toBeVisible();
  await page.getByRole("textbox", { name: "Notes", exact: true }).fill("T08_NEW_UNSENT_AFTER_ACK");
  await page.getByRole("button", { name: "IT", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Note", exact: true })).toHaveValue("T08_NEW_UNSENT_AFTER_ACK");
  expect(gets).toBe(1);
  const saved = await page.request.get("/api/public/reservations/" + path.split("/").at(-1));
  expect((await saved.json()).reservation.notes).toBe("T08_SAVED_DURING_LANGUAGE");
  await cancel(page.request, path);
});
test("E05 navigation to a different token ignores the previous document's delayed GET", async ({ page }) => {
  const first = await create(page.request, "first");
  const second = await create(page.request, "second");
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/public/reservations/" + first.split("/").at(-1), async route => {
    const response = await route.fetch(); await held; await route.fulfill({ response }).catch(() => undefined);
  });
  await page.goto(first);
  await page.goto(second);
  await page.getByRole("textbox", { name: "Note", exact: true }).fill("T08_SECOND_TOKEN_DIRTY");
  release();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("T08_SECOND_TOKEN_DIRTY");
  await expect(page.getByText("T08 OBS second " + e2eRunId)).toBeVisible();
  await page.unrouteAll(); await cancel(page.request, first); await cancel(page.request, second);
});

test("E05 failed PATCH preserves the dirty draft and localizes errors without GET reload", async ({ page }) => {
  const path = await create(page.request, "failed-save");
  let gets = 0;
  await page.route("**/api/public/reservations/*", route => {
    if (route.request().method() === "PATCH") return route.abort("failed");
    if (route.request().method() === "GET") ++gets;
    return route.continue();
  });
  await page.goto(path);
  await page.getByRole("textbox", { name: "Note", exact: true }).fill("T08_UNSENT_FAILED_SAVE");
  await page.getByRole("button", { name: "Salva modifiche", exact: true }).click();
  await expect(page.locator('p[role="alert"]')).toBeVisible();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue("T08_UNSENT_FAILED_SAVE");
  await expect(page.locator('p[role="alert"]')).toHaveText("The request could not be completed.");
  expect(gets).toBe(1);
  await cancel(page.request, path);
});
