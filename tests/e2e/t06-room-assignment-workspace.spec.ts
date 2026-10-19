import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { Pool } from "pg";
import { e2eAdminUsername, e2eReservationFirstName, e2eRestaurantId, e2eRunId } from "./e2e-run";
const origin = "http://localhost:4000", date = "2099-10-19";
const target = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname)) throw new Error("T06C_TEMPORARY_DATABASE_REQUIRED");
const db = new Pool({ connectionString: target.href }), owned: string[] = [];
async function login(page: Page) {
  await page.goto("/login?returnTo=%2Fdashboard%2Fassign-room"); await page.getByLabel("Username").fill(e2eAdminUsername);
  await page.getByLabel("Password").fill(process.env.AUTH_DEMO_ADMIN_PASSWORD ?? ""); await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard\/assign-room$/u);
}
async function create(request: APIRequestContext, label: string) {
  const response = await request.post("/api/staff/reservations", { headers: { origin, "Idempotency-Key": crypto.randomUUID() }, data: {
    localDate: date, serviceType: "DINNER", arrivalTime: "19:00", partySize: 4, childrenCount: 1, gameRoomPreference: false,
    customerFirstName: e2eReservationFirstName, customerLastName: "T06C " + label + " " + e2eRunId, customerPhone: "+390000006060", customerEmail: null,
    highChair: false, stroller: false, accessibility: false, celiac: false, allergies: null, intolerances: null, celebration: null, animals: false,
    notes: "T06C_SHARED_MARKER", verbalConsentConfirmed: true, sendWhatsAppConfirmation: false, capacityOverride: false, capacityOverrideReason: null,
  } }); expect(response.status(), await response.text()).toBe(201);
  const r = (await response.json()).reservation as { id: string; version: number }; owned.push(r.id); return r;
}
async function stored(id: string) {
  const rows = await db.query("SELECT r.id,r.version,r.status,r.notes,r.private_notes,r.arrived_at,a.id AS assignment_id,a.room_id,a.internal_notes,a.cleared_at,(SELECT count(*)::int FROM reservation_assignment_tables t WHERE t.assignment_id=a.id) AS links,(SELECT count(*)::int FROM reservation_audit_events e WHERE e.reservation_id=r.id) AS audits,(SELECT count(*)::int FROM notification_outbox n WHERE n.reservation_id=r.id) AS outbox FROM reservations r LEFT JOIN reservation_assignments a ON a.reservation_id=r.id AND a.restaurant_id=r.restaurant_id WHERE r.id=$1 AND r.restaurant_id=$2", [id, e2eRestaurantId]); expect(rows.rowCount).toBe(1); return rows.rows[0];
}
async function context(request: APIRequestContext, id: string) { const response = await request.get(`/api/staff/reservations/${id}/assignment`); expect(response.status()).toBe(200); return response.json(); }
async function proof(request: APIRequestContext) { const response = await request.post("/api/auth/draft-context", { headers: { origin }, data: { challenge: crypto.randomUUID() } }); expect(response.status()).toBe(200); return response.json() as Promise<{ sessionBinding: string }>; }
async function roomPost(request: APIRequestContext, id: string, roomId: string, version: number, binding?: string) {
  return request.post(`/api/staff/reservations/${id}/room-assignment`, { headers: { origin, ...(binding === undefined ? {} : { "X-Piccadilly-Draft-Session-Binding": binding }) }, data: { version, roomId, expectedLocalDate: date, expectedServiceType: "DINNER" } });
}
async function workspace(page: Page) { await page.goto(`/dashboard/assign-room?date=${date}&service=DINNER`); await expect(page.getByRole("heading", { name: "Da assegnare", exact: false })).toBeVisible(); }
test.afterEach(async ({ page }) => { for (const id of owned.splice(0)) { const r = await stored(id); if (r.status === "CONFIRMED") expect((await page.request.delete(`/api/staff/reservations/${id}`, { headers: { origin }, data: { version: r.version } })).status()).toBe(200); } });
test.afterAll(async () => { await db.end(); });

test("T06-C select plus explicit confirmation updates room view and Agenda without exposing NI", async ({ page }) => {
  await login(page); const r = await create(page.request, "Select");
  expect((await page.request.put(`/api/staff/reservations/${r.id}/private-notes`, { headers: { origin }, data: { version: 1, privateNotes: "T06C_NI_PRIVATE_MARKER" } })).status()).toBe(200);
  await workspace(page); const row = page.locator(`[data-room-reservation="${r.id}"]`);
  await expect(row).toContainText("4 coperti"); await expect(row).toContainText("Bimbi (1)"); await expect(row).toContainText("NI autonoma presente"); await expect(row).not.toContainText("T06C_NI_PRIVATE_MARKER");
  await row.getByRole("radio").check(); await page.getByRole("button", { name: "Assegna selezionata a Sala 1", exact: true }).click();
  const dialog = page.getByTestId("assignment-dialog"); await expect(dialog.getByTestId("assignment-room-select")).not.toHaveValue("");
  expect((await stored(r.id)).assignment_id).toBeNull();
  const waiting = page.waitForResponse(resp => resp.request().method() === "POST" && resp.url().endsWith(`/${r.id}/room-assignment`));
  await dialog.getByTestId("assignment-save").click(); const response = await waiting; expect(response.status()).toBe(200);
  expect(response.request().headers()["x-piccadilly-draft-session-binding"]?.length).toBe(43);
  await expect(dialog).toBeHidden(); expect((await stored(r.id)).version).toBe(3);
  await page.getByRole("button", { name: "Sala 1", exact: true }).click(); await expect(page.locator(`[data-room-reservation="${r.id}"]`)).toBeVisible();
  await page.getByLabel("Ordina per").selectOption("ASSIGNMENT"); await expect(page.getByText("Ingresso nella sala:", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Torna Agenda" }).click(); await expect(page.locator(`article[data-reservation-id="${r.id}"]`).getByTestId("final-room-name")).toHaveText("Sala 1");
});

test("T06-C rejects missing malformed and mismatched binding without business writes", async ({ page }) => {
  await login(page); const r = await create(page.request, "Binding"), c = await context(page.request, r.id), roomId = c.rooms.find((v: { code: string }) => v.code === "sala-1").id;
  const before = await stored(r.id);
  for (const binding of [undefined, "", "invalid", "A".repeat(42), "A".repeat(43) + "," + "A".repeat(43)]) { const response = await roomPost(page.request, r.id, roomId, 1, binding); expect(response.status()).toBe(400); expect((await response.json()).code).toBe("DRAFT_SESSION_BINDING_INVALID"); }
  const response = await roomPost(page.request, r.id, roomId, 1, "A".repeat(43)); expect(response.status()).toBe(403); expect((await response.json()).code).toBe("DRAFT_SESSION_MISMATCH"); expect(await stored(r.id)).toEqual(before);
});

for (const switchAt of ["PROOF", "GET"] as const) test(`T06-C SERVER_REJECTED_BEFORE_WRITER cookie B after ${switchAt} A`, async ({ page }) => {
  await login(page); const r = await create(page.request, "Race " + switchAt); await workspace(page);
  await page.locator(`[data-room-reservation="${r.id}"]`).getByRole("radio").check(); await page.getByRole("button", { name: "Assegna selezionata a Sala 1", exact: true }).click();
  const dialog = page.getByTestId("assignment-dialog"); await expect(dialog.getByTestId("assignment-room-select")).not.toHaveValue("");
  const a = await proof(page.request), before = await stored(r.id);
  let release: () => void = () => undefined, reached: () => void = () => undefined;
  const wait = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { reached = resolve; });
  const pattern = switchAt === "PROOF" ? "**/api/auth/draft-context" : `**/api/staff/reservations/${r.id}/assignment`;
  await page.route(pattern, async route => { const response = await route.fetch(); reached(); await wait; await route.fulfill({ response }); });
  const responsePromise = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/${r.id}/room-assignment`));
  await dialog.getByTestId("assignment-save").click(); await held;
  const loginB = await page.context().request.post("/api/auth/login", { headers: { origin }, form: { username: e2eAdminUsername, password: process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "" }, maxRedirects: 0 }); expect(loginB.status()).toBe(303);
  const b = await proof(page.context().request); expect(a.sessionBinding === b.sessionBinding).toBe(false);
  release(); const response = await responsePromise; expect(response.status()).toBe(403); expect((await response.json()).code).toBe("DRAFT_SESSION_MISMATCH"); expect(await stored(r.id)).toEqual(before);
  await page.unroute(pattern); await expect(page.getByRole("status").filter({ hasText: "server ha rifiutato" })).toBeVisible();
});

test("T06-C preserves active and cleared legacy references and notes", async ({ page }) => {
  await login(page); const r = await create(page.request, "Legacy"), c = await context(page.request, r.id);
  const room = c.rooms.find((v: { code: string }) => v.code === "sala-1"), next = c.rooms.find((v: { code: string }) => v.code === "sala-2");
  expect(room.tables.length).toBeGreaterThan(0);
  expect((await page.request.put(`/api/staff/reservations/${r.id}/assignment`, { headers: { origin }, data: { version: 1, roomId: room.id, tableIds: [room.tables[0].id], internalNotes: "T06C_LEGACY_MARKER" } })).status()).toBe(200);
  const binding = (await proof(page.request)).sessionBinding, before = await stored(r.id);
  expect((await roomPost(page.request, r.id, room.id, 1, binding)).status()).toBe(200); expect(await stored(r.id)).toEqual(before);
  const changed = await roomPost(page.request, r.id, next.id, 2, binding); expect(changed.status()).toBe(409); expect((await changed.json()).code).toBe("LEGACY_TABLE_LINKS_PRESENT"); expect(await stored(r.id)).toEqual(before);
  expect((await page.request.delete(`/api/staff/reservations/${r.id}/assignment`, { headers: { origin }, data: { version: 2 } })).status()).toBe(200);
  const cleared = await stored(r.id); const blocked = await roomPost(page.request, r.id, room.id, 3, binding); expect(blocked.status()).toBe(409); expect(await stored(r.id)).toEqual(cleared);
});

test("T06-C responsive keyboard confirmation survives resize and cancel sends no mutation", async ({ page }, info) => {
  await login(page); const r = await create(page.request, "Responsive"); await workspace(page);
  await page.locator(`[data-room-reservation="${r.id}"]`).getByRole("radio").check(); await page.getByRole("button", { name: "Assegna selezionata a Sala 1", exact: true }).click();
  const dialog = page.getByTestId("assignment-dialog"); await expect(dialog.getByTestId("assignment-room-select")).not.toHaveValue("");
  for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1023, height: 900 }, { width: 1024, height: 900 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport); await expect(dialog).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`room-${viewport.width}.png`), fullPage: true });
  }
  const selected = await dialog.getByTestId("assignment-room-select").inputValue(); await dialog.getByTestId("assignment-save").focus(); await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "Chiudi gestione assegnazione" })).toBeFocused();
  await page.keyboard.press("Escape"); const guard = page.getByRole("dialog").filter({ hasText: "Esci conservando" }); await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Resta", exact: true }).click(); await expect(dialog.getByTestId("assignment-room-select")).toHaveValue(selected); expect((await stored(r.id)).assignment_id).toBeNull();
});

test("T06-C real server409 after GET retains choice until explicit reapply", async ({ page }) => {
  await login(page); const r = await create(page.request, "Server409"), c = await context(page.request, r.id), b = (await proof(page.request)).sessionBinding;
  const room1 = c.rooms.find((v: { code: string }) => v.code === "sala-1"), room2 = c.rooms.find((v: { code: string }) => v.code === "sala-2");
  await workspace(page); await page.locator(`[data-room-reservation="${r.id}"]`).getByRole("radio").check(); await page.getByRole("button", { name: "Assegna selezionata a Sala 1", exact: true }).click();
  const dialog = page.getByTestId("assignment-dialog"); await expect(dialog.getByTestId("assignment-room-select")).toHaveValue(room1.id);
  let release: () => void = () => undefined, reached: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { reached = resolve; });
  await page.route(`**/api/staff/reservations/${r.id}/assignment`, async route => { const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); });
  const responsePromise = page.waitForResponse(resp => resp.request().method() === "POST" && resp.url().endsWith(`/${r.id}/room-assignment`));
  await dialog.getByTestId("assignment-save").click(); await held;
  expect((await roomPost(page.request, r.id, room2.id, 1, b)).status()).toBe(200); release();
  const response = await responsePromise; expect(response.status()).toBe(409); expect((await response.json()).code).toBe("VERSION_CONFLICT");
  await expect(dialog.getByTestId("assignment-room-select")).toHaveValue(room1.id); expect((await stored(r.id)).room_id).toBe(room2.id);
  await page.unroute(`**/api/staff/reservations/${r.id}/assignment`); await dialog.getByTestId("assignment-reload-conflict").click();
  await dialog.getByRole("button", { name: "Riapplica scelta su versione riletta" }).click(); await dialog.getByTestId("assignment-save").click(); await expect(dialog).toBeHidden(); expect((await stored(r.id)).version).toBe(3); expect((await stored(r.id)).room_id).toBe(room1.id);
});

test("T06-C retained ROOM recovers through detail and warns on logout from Admin", async ({ page }) => {
  await login(page); const r = await create(page.request, "Retained"), c = await context(page.request, r.id), room = c.rooms.find((v: { code: string }) => v.code === "sala-1"); await workspace(page);
  await page.locator(`[data-room-reservation="${r.id}"]`).getByRole("radio").check(); await page.getByRole("button", { name: "Assegna selezionata a Sala 1", exact: true }).click();
  let dialog = page.getByTestId("assignment-dialog"); await expect(dialog.getByTestId("assignment-room-select")).toHaveValue(room.id); await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Esci conservando la bozza", exact: true }).click(); await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Torna al draft ROOM", exact: true }).click(); await expect(page).toHaveURL(new RegExp("/dashboard/reservations/" + r.id));
  await page.getByRole("button", { name: "Assegna sala", exact: true }).click(); dialog = page.getByTestId("assignment-dialog");
  await dialog.getByRole("button", { name: "Continua modifica sala", exact: true }).click(); await expect(dialog.getByTestId("assignment-room-select")).toHaveValue(room.id);
  await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Esci conservando la bozza", exact: true }).click();
  await page.getByRole("link", { name: "Admin", exact: true }).click(); await page.getByRole("button", { name: "Logout", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Modifiche non salvate" }); await expect(guard).toContainText("ROOM"); await guard.getByRole("button", { name: "Resta", exact: true }).click();
  await expect(page).toHaveURL(/\/admin$/u); expect((await stored(r.id)).assignment_id).toBeNull();
});

test("T06-C pending ROOM survives navigation and late ACK never redirects", async ({ page }) => {
  await login(page); const r = await create(page.request, "Pending"); await workspace(page); await page.locator(`[data-room-reservation="${r.id}"]`).getByRole("radio").check(); await page.getByRole("button", { name: "Assegna selezionata a Sala 1", exact: true }).click();
  const dialog = page.getByTestId("assignment-dialog"); await expect(dialog.getByTestId("assignment-room-select")).not.toHaveValue("");
  let release: () => void = () => undefined, reached: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { reached = resolve; });
  await page.route(`**/api/staff/reservations/${r.id}/room-assignment`, async route => { reached(); await gate; await route.continue(); });
  await dialog.getByTestId("assignment-save").click(); await held; await expect(dialog.getByTestId("assignment-room-select")).toBeDisabled();
  for (const width of [820, 1280]) { await page.setViewportSize({ width, height: 900 }); await expect(dialog).toHaveAttribute("aria-busy", "true"); }
  await page.keyboard.press("Escape"); const guard = page.getByRole("dialog", { name: "Modifiche non salvate" }); await expect(guard).toContainText("non annulla"); await guard.getByRole("button", { name: "Esci conservando la bozza", exact: true }).click();
  await page.getByRole("link", { name: "Admin", exact: true }).click(); release(); await expect.poll(async () => (await stored(r.id)).version).toBe(2);
  await expect(page).toHaveURL(/\/admin$/u); await expect(page.getByTestId("assignment-dialog")).toHaveCount(0); await expect(page.getByText("Salvataggio precedente confermato.", { exact: false })).toBeVisible();
});
