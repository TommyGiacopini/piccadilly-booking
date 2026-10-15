import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { Pool } from "pg";
import { e2eAdminUsername, e2eReservationFirstName, e2eRestaurantId, e2eRunId, e2eStaffUsername } from "./e2e-run";

const origin = "http://localhost:4000", date = "2099-12-10";
const target = new URL(process.env.DATABASE_URL ?? "");
if (!/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname) || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) throw new Error("T06_TEMPORARY_DATABASE_REQUIRED");
const database = new Pool({ connectionString: target.href });
const folder = resolve("test-results/t06-private-notes-evidence");
function record(name: string, value: unknown) { mkdirSync(folder, { recursive: true }); writeFileSync(resolve(folder, name + ".json"), JSON.stringify(value, null, 2)); }
async function shot(page: Page, name: string) { mkdirSync(folder, { recursive: true }); await page.screenshot({ path: resolve(folder, name + ".png"), fullPage: false }); }
async function login(page: Page, role: "STAFF" | "ADMIN" = "STAFF") {
  await page.goto("/login");
  await page.getByLabel("Username").fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page.getByLabel("Password").fill((role === "ADMIN" ? process.env.AUTH_DEMO_ADMIN_PASSWORD : process.env.AUTH_DEMO_STAFF_PASSWORD) ?? "");
  await page.getByRole("button", { name: "Accedi" }).click(); await expect(page).toHaveURL(/\/dashboard/u);
}
async function create(request: APIRequestContext, label: string) {
  const response = await request.post("/api/staff/reservations", { headers: { origin, "Idempotency-Key": crypto.randomUUID() }, data: {
    localDate: date, serviceType: "DINNER", arrivalTime: "19:00", partySize: 2, childrenCount: 0, gameRoomPreference: null,
    customerFirstName: e2eReservationFirstName, customerLastName: "T06 " + label + " " + e2eRunId, customerPhone: "+390000000606",
    customerEmail: null, highChair: false, stroller: false, accessibility: false, celiac: false, allergies: null, intolerances: null,
    celebration: null, animals: false, notes: "T06_SHARED_NC_UI", verbalConsentConfirmed: true, sendWhatsAppConfirmation: false,
    capacityOverride: false, capacityOverrideReason: null,
  } });
  expect(response.status(), await response.text()).toBe(201); return (await response.json()).reservation as { id: string; version: number };
}
async function context(request: APIRequestContext, id: string) {
  const response = await request.get(`/api/staff/reservations/${id}/private-notes`); expect(response.status()).toBe(200); return response.json();
}
async function stored(id: string) {
  const row = await database.query("SELECT id,status,version,private_notes,notes,updated_at,arrived_at FROM reservations WHERE id=$1 AND restaurant_id=$2", [id, e2eRestaurantId]);
  expect(row.rowCount).toBe(1); return row.rows[0];
}
async function cancel(request: APIRequestContext, id: string) {
  const current = await stored(id);
  if (current.status === "CANCELLED") return;
  const response = await request.delete(`/api/staff/reservations/${id}`, { headers: { origin }, data: { version: current.version } }); expect(response.status()).toBe(200);
}
function card(page: Page, id: string) { return page.locator(`article[data-reservation-id="${id}"]`); }
async function open(page: Page, id: string) {
  await card(page, id).getByRole("button", { name: "Apri note interne", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Note interne della prenotazione", exact: true });
  await expect(dialog.getByLabel("Nota interna autonoma (NI)", { exact: true })).toBeVisible(); return dialog;
}
test.afterAll(async () => { await database.end(); });

test("NI assente dal DTO Public, dal management DTO e dalla pagina personale", async ({ page }) => {
  await login(page);
  // Isolate this fixture from the preceding public rate-limit scenarios of this fake run.
  await database.query("DELETE FROM public_reservation_rate_limits WHERE restaurant_id=$1 AND action='CREATE'", [e2eRestaurantId]);
  const lastName = "T06 Public privacy " + e2eRunId;
  const created = await page.request.post("/api/public/reservations", {
    headers: { origin, "Idempotency-Key": crypto.randomUUID() }, data: {
      localDate: date, serviceType: "DINNER", arrivalTime: "19:00", partySize: 2,
      childrenCount: 0, gameRoomPreference: null,
      customerFirstName: e2eReservationFirstName, customerLastName: lastName, customerPhone: "+390000000606",
      customerEmail: null, highChair: false, stroller: false, accessibility: false, celiac: false,
      allergies: null, intolerances: null, celebration: null, animals: false, notes: "T06_PUBLIC_SHARED_NC",
      language: "it", privacyAccepted: true, termsAccepted: true,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = await created.json();
  const found = await database.query("SELECT id FROM reservations WHERE restaurant_id=$1 AND customer_last_name=$2", [e2eRestaurantId, lastName]);
  const id = found.rows[0].id as string;
  try {
    const marker = "T06_PUBLIC_PAGE_PRIVATE_MARKER";
    const note = await page.request.put(`/api/staff/reservations/${id}/private-notes`, {
      headers: { origin }, data: { version: 1, privateNotes: marker },
    }); expect(note.status()).toBe(200);
    expect(JSON.stringify(body)).not.toContain(marker);
    const token = body.managementPath.split("/").at(-1);
    const managed = await page.request.get(`/api/public/reservations/${token}`);
    expect(managed.status()).toBe(200); expect(await managed.text()).not.toContain(marker);
    await page.goto(body.managementPath);
    await expect(page.getByRole("main")).not.toContainText(marker);
    expect(await page.content()).not.toContain(marker);
    record("public-privacy", { publicDto: "PASS", managementDto: "PASS", renderedPage: "PASS" });
  } finally { await cancel(page.request, id); }
});

test("NI senza assegnazione: responsive, Unicode1000, tastiera e focus restituito", async ({ page }) => {
  await login(page); const item = await create(page.request, "Responsive");
  try {
    await page.goto(`/dashboard?date=${date}`);
    const trigger = card(page, item.id).getByRole("button", { name: "Apri note interne" });
    await trigger.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Note interne della prenotazione" });
    const text = dialog.getByLabel("Nota interna autonoma (NI)", { exact: true });
    await expect(text).toBeVisible(); await expect(dialog).toContainText("T06_SHARED_NC_UI");
    for (const width of [320, 390, 820, 1280, 1440]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      const overflow = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      expect(overflow.document).toBeLessThanOrEqual(width); expect(overflow.body).toBeLessThanOrEqual(width);
      await shot(page, "notes-responsive-" + width); record("overflow-" + width, overflow);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole("button", { name: "Chiudi note interne" }).focus(); await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Ricarica nota e sostituisci bozza" })).toBeFocused();
    await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "Chiudi note interne" })).toBeFocused();
    await text.fill("😀".repeat(1000)); await expect(dialog).toContainText("1000 / 1000");
    const response = page.waitForResponse((r) => r.url().endsWith("/private-notes") && r.request().method() === "PUT");
    await dialog.getByRole("button", { name: "Salva nota interna", exact: true }).click(); expect((await response).status()).toBe(200);
    await expect(dialog).toContainText("Nota interna salvata.");
    expect((await stored(item.id)).private_notes).toBe("😀".repeat(1000));
    expect((await database.query("SELECT count(*)::int AS count FROM reservation_assignments WHERE reservation_id=$1", [item.id])).rows[0].count).toBe(0);
    await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
    record("keyboard", { wrapForward: true, wrapBackward: true, escapeReturnFocus: true, unicode1000: true, noAssignment: true });
  } finally { await cancel(page.request, item.id); }
});

test("pending e doppio submit producono una sola write reale", async ({ page }) => {
  await login(page); const item = await create(page.request, "Pending");
  try {
    await page.goto(`/dashboard?date=${date}`); const dialog = await open(page, item.id);
    await dialog.getByLabel("Nota interna autonoma (NI)", { exact: true }).fill("T06_PENDING_PRIVATE_MARKER");
    let requests = 0; let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**/api/staff/reservations/${item.id}/private-notes`, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      requests += 1; await gate; await route.continue();
    });
    const result = page.waitForResponse((r) => r.url().endsWith("/private-notes") && r.request().method() === "PUT");
    await dialog.getByRole("button", { name: "Salva nota interna" }).click();
    await expect(dialog.getByRole("button", { name: "Salvataggio…" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Salvataggio…" }).dispatchEvent("click");
    await expect(dialog.getByLabel("Nota interna autonoma (NI)", { exact: true })).toBeDisabled();
    await shot(page, "notes-pending"); release(); expect((await result).status()).toBe(200);
    await expect(dialog).toContainText("Nota interna salvata."); expect(requests).toBe(1); expect((await stored(item.id)).version).toBe(2);
    record("double-submit", { requests, version: 2 }); await page.unrouteAll({ behavior: "ignoreErrors" });
  } finally { await cancel(page.request, item.id); }
});

test("409 reale conserva bozza, richiede reload esplicito e non forza la versione", async ({ page }) => {
  await login(page); const item = await create(page.request, "Conflict");
  try {
    await page.goto(`/dashboard?date=${date}`); const dialog = await open(page, item.id);
    const draft = dialog.getByLabel("Nota interna autonoma (NI)", { exact: true }); await draft.fill("T06_LOCAL_DRAFT");
    const winner = await page.request.put(`/api/staff/reservations/${item.id}/private-notes`, {
      headers: { origin }, data: { version: 1, privateNotes: "T06_OTHER_OPERATOR_WINNER" },
    }); expect(winner.status()).toBe(200);
    const response = page.waitForResponse((r) => r.url().endsWith("/private-notes") && r.request().method() === "PUT");
    await dialog.getByRole("button", { name: "Salva nota interna" }).click(); expect((await response).status()).toBe(409);
    await expect(draft).toHaveValue("T06_LOCAL_DRAFT");
    await expect(dialog.getByRole("alert")).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Salva nota interna" })).toBeDisabled();
    expect((await stored(item.id)).private_notes).toBe("T06_OTHER_OPERATOR_WINNER");
    await shot(page, "notes-real-409");
    await dialog.getByRole("button", { name: "Ricarica nota e sostituisci bozza" }).click();
    await expect(draft).toHaveValue("T06_OTHER_OPERATOR_WINNER");
    expect((await context(page.request, item.id)).reservation.version).toBe(2);
    record("real-409", { actualStatus: 409, draftRetained: true, errorFocus: true, noAutomaticRetry: true, explicitReload: true });
  } finally { await cancel(page.request, item.id); }
});

test("CANCELLED sola lettura distingue e conserva NI autonoma e legacy cleared", async ({ page }) => {
  await login(page, "ADMIN"); const item = await create(page.request, "ReadOnly");
  try {
    const response = await page.request.put(`/api/staff/reservations/${item.id}/private-notes`, {
      headers: { origin }, data: { version: 1, privateNotes: "T06_CANCELLED_PRIVATE_NOTE" },
    }); expect(response.status()).toBe(200);
    const assignment = await page.request.get(`/api/staff/reservations/${item.id}/assignment`); const ctx = await assignment.json();
    const room = ctx.rooms.find((r: { code: string }) => r.code === "sala-1");
    const legacy = await page.request.put(`/api/staff/reservations/${item.id}/assignment`, {
      headers: { origin }, data: { version: 2, roomId: room.id, tableIds: [], internalNotes: "T06_LEGACY_CLEARED_NOTE" },
    }); expect(legacy.status()).toBe(200);
    const cleared = await page.request.delete(`/api/staff/reservations/${item.id}/assignment`, { headers: { origin }, data: { version: 3 } }); expect(cleared.status()).toBe(200);
    await cancel(page.request, item.id); await page.goto(`/dashboard?date=${date}&status=CANCELLED`);
    const dialog = await open(page, item.id);
    await expect(dialog).toContainText("Prenotazione cancellata: sola lettura.");
    await expect(dialog.getByLabel("Nota interna autonoma (NI)", { exact: true })).toHaveAttribute("readonly", "");
    await expect(dialog.getByRole("button", { name: "Salva nota interna" })).toHaveCount(0);
    await expect(dialog).toContainText("T06_LEGACY_CLEARED_NOTE"); await expect(dialog).toContainText("Assegnazione rimossa");
    expect((await stored(item.id)).private_notes).toBe("T06_CANCELLED_PRIVATE_NOTE");
    await shot(page, "notes-cancelled-legacy");
  } finally { await cancel(page.request, item.id); }
});
