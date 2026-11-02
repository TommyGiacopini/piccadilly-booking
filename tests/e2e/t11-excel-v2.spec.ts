import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import ExcelJS from "exceljs";
import { expect, test, type Download, type Page } from "@playwright/test";
import { e2eAdminUsername, e2eStaffUsername, e2eRestaurantId, e2eReservationFirstName, e2eRunId } from "./e2e-run";

const target = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname)) throw new Error("T11_TEMPORARY_DATABASE_REQUIRED");
const database = new Pool({ connectionString: process.env.DATABASE_URL });
const day = "2099-12-16", origin = "http://localhost:4000", prefix = "T11 " + e2eRunId.slice(0, 8) + " ";
const excelPath = "/api/staff/exports/excel-v2", marker = "T11_NC_" + e2eRunId.slice(0, 8);
let ids: string[] = [], tableId = "";
const button = (page: Page) => page.getByRole("button", { name: "Scarica Excel operativo", exact: true });
async function login(page: Page, role: "STAFF" | "ADMIN" = "STAFF") {
  await page.goto("/login"); await page.getByLabel("Username").fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page.getByLabel("Password").fill(process.env[role === "ADMIN" ? "AUTH_DEMO_ADMIN_PASSWORD" : "AUTH_DEMO_STAFF_PASSWORD"] ?? "");
  await page.getByRole("button", { name: "Accedi", exact: true }).click(); await expect(page).toHaveURL(/\/dashboard/u);
  await page.goto("/dashboard?date=" + day);
}
async function setup() {
  const actor = await database.query("SELECT id FROM users WHERE restaurant_id=$1 AND username=$2", [e2eRestaurantId, e2eStaffUsername]);
  const rooms = await database.query("SELECT id,code FROM rooms WHERE restaurant_id=$1", [e2eRestaurantId]);
  const roomIds = new Map<string, string>(rooms.rows.map(row => [row.code, row.id]));
  tableId = randomUUID();
  await database.query("INSERT INTO dining_tables (id,room_id,name,minimum_seats,maximum_seats,is_active,display_order,created_at,updated_at) VALUES ($1,$2,$3,1,4,false,1,now(),now())", [tableId, roomIds.get("sala-1"), "T11_DIGITAL_FORBIDDEN_" + e2eRunId.slice(0, 8)]);
  const cases = [
    { name: "Beta", room: "sala-1", time: "20:00", children: 1, games: true, service: "DINNER", cancelled: false },
    { name: "Alpha", room: "sala-1", time: "19:00", children: 0, games: null, service: "DINNER", cancelled: false },
    { name: "Unknown", room: null, time: "19:15", children: null, games: null, service: "DINNER", cancelled: false },
    { name: "Lunch", room: "sala-2", time: "12:30", children: 0, games: null, service: "LUNCH", cancelled: false },
    { name: "Cancelled", room: null, time: "19:00", children: 0, games: null, service: "DINNER", cancelled: true },
  ];
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index], id = randomUUID(); ids.push(id);
    await database.query("INSERT INTO reservations (id,restaurant_id,local_date,service_type,arrival_time,party_size,children_count,game_room_preference,status,origin,customer_first_name,customer_last_name,customer_phone,customer_email,preferences,allergies,notes,private_notes,privacy_policy_version,privacy_consent_at,privacy_consent_method,created_by_user_id,created_at,updated_at,cancelled_at) VALUES ($1,$2,$3,$4,$5,4,$6,$7,$8,'PHONE',$9,$10,'+390000000910','t11@example.test',$11,'{}',$12,'T11_PRIVATE_FORBIDDEN','test-only',now(),'VERBAL',$13,$14,$14,$15)",
      [id, e2eRestaurantId, day, item.service, item.time, item.children, item.games, item.cancelled ? "CANCELLED" : "CONFIRMED", e2eReservationFirstName, prefix + item.name,
        JSON.stringify({ roomCode: "", highChair: false, stroller: false, accessibility: false, children: item.children === null, celebration: null, animals: false }), marker, actor.rows[0].id, new Date(Date.UTC(2099, 11, 1, 10, index)), item.cancelled ? new Date() : null]);
    if (item.room) {
      const assignmentId = randomUUID();
      await database.query("INSERT INTO reservation_assignments (id,restaurant_id,reservation_id,room_id,internal_notes,assigned_by_user_id,updated_by_user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,'T11_LEGACY_FORBIDDEN',$5,$5,now(),now())", [assignmentId, e2eRestaurantId, id, roomIds.get(item.room), actor.rows[0].id]);
      if (item.name === "Beta") await database.query("INSERT INTO reservation_assignment_tables (restaurant_id,assignment_id,room_id,dining_table_id) VALUES ($1,$2,$3,$4)", [e2eRestaurantId, assignmentId, roomIds.get(item.room), tableId]);
    }
  }
}
async function cleanup() {
  if (!ids.length) return;
  await database.query("DELETE FROM reservation_assignment_tables WHERE restaurant_id=$1 AND assignment_id IN (SELECT id FROM reservation_assignments WHERE restaurant_id=$1 AND reservation_id=ANY($2::uuid[]))", [e2eRestaurantId, ids]);
  await database.query("DELETE FROM reservation_assignments WHERE restaurant_id=$1 AND reservation_id=ANY($2::uuid[])", [e2eRestaurantId, ids]);
  await database.query("DELETE FROM reservations WHERE restaurant_id=$1 AND id=ANY($2::uuid[])", [e2eRestaurantId, ids]);
  await database.query("DELETE FROM dining_tables WHERE id=$1", [tableId]); ids = []; tableId = "";
}
async function fingerprint() {
  const rows = await database.query("SELECT id,version,notes,private_notes,updated_at FROM reservations WHERE restaurant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id", [e2eRestaurantId, ids]);
  const audit = await database.query("SELECT count(*)::int AS n FROM audit_events WHERE restaurant_id=$1 AND category='EXPORT'", [e2eRestaurantId]);
  return { business: createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex"), audit: audit.rows[0].n };
}
async function excelText(download: Download) {
  const path = await download.path(); expect(path).not.toBeNull();
  const book = new ExcelJS.Workbook(); await book.xlsx.load(readFileSync(path!) as unknown as ExcelJS.Buffer);
  expect(book.worksheets).toHaveLength(1); expect(book.worksheets[0].name).toBe("Agenda");
  return JSON.stringify(book.worksheets[0].getSheetValues());
}
async function select(page: Page, service = "DINNER") { await page.getByLabel("Pranzo o cena per l’anteprima").selectOption(service); await page.getByLabel("Soglia della selezione").selectOption("EXCEL"); }
async function download(page: Page) {
  const pending = page.waitForEvent("download"); await button(page).click(); return pending;
}
test.beforeEach(async ({ page }) => { await setup(); await login(page); });
test.afterEach(async () => { await cleanup(); });
test.afterAll(async () => { await cleanup(); await database.end(); });

test("requires the Excel profile and an explicit service before dispatch", async ({ page }) => {
  let calls = 0; page.on("request", request => { if (new URL(request.url()).pathname === excelPath) calls++; });
  await expect(button(page)).toBeDisabled();
  await page.getByLabel("Soglia della selezione").selectOption("EXCEL");
  await button(page).click(); await expect(page.locator("#preview-error-summary")).toBeFocused(); expect(calls).toBe(0);
  await page.getByLabel("Soglia della selezione").selectOption("PDF"); await expect(button(page)).toBeDisabled();
});
for (const role of ["STAFF", "ADMIN"] as const) test(`${role} downloads a real selected Excel with NC and no digital tables or private fields`, async ({ page }) => {
  if (role === "ADMIN") {
    await page.getByRole("button", { name: "Logout", exact: true }).click();
    await expect(page).toHaveURL(/\/login/u); await login(page, role);
  }
  await select(page); const before = await fingerprint();
  const file = await download(page); expect(file.suggestedFilename()).toBe(`piccadilly-operativo-v2-${day}-dinner-all-created-asc.xlsx`);
  const text = await excelText(file); expect(text).toContain("Prenotazioni: 3"); expect(text).toContain(marker);
  expect(text).toContain(prefix + "Beta"); expect(text).not.toContain(prefix + "Lunch"); expect(text).not.toContain(prefix + "Cancelled");
  for (const forbidden of ["T11_DIGITAL_FORBIDDEN", "T11_PRIVATE_FORBIDDEN", "T11_LEGACY_FORBIDDEN", "+390000000910", "t11@example.test"]) expect(text).not.toContain(forbidden);
  await expect.poll(async () => (await fingerprint()).audit).toBe(before.audit + 1);
  expect((await fingerprint()).business).toBe(before.business);
});
test("keeps preview independent and reads updated NC and current room/order for download", async ({ page }) => {
  await select(page); await page.getByRole("button", { name: "Mostra anteprima", exact: true }).click();
  await expect(page.getByTestId("export-preview-results")).toContainText(marker);
  const before = await fingerprint();
  await database.query("UPDATE reservations SET notes=$2 WHERE id=$1", [ids[0], "T11_FRESH_DATABASE_NC"]);
  await page.getByLabel("Sala effettiva").selectOption("SALA_1"); await page.getByLabel("Ordina dentro ogni sala").selectOption("NAME_ASC");
  const file = await download(page), text = await excelText(file);
  expect(file.suggestedFilename()).toContain("sala-1-name-asc.xlsx"); expect(text).toContain("Prenotazioni: 2"); expect(text.replace(/\s/gu, "")).toContain("T11_FRESH_DATABASE_NC");
  expect(text.indexOf(prefix + "Alpha")).toBeLessThan(text.indexOf(prefix + "Beta"));
  await expect.poll(async () => (await fingerprint()).audit).toBe(before.audit + 1);
});
test("serializes double submit while loading and unlocks after completion", async ({ page }) => {
  await select(page); let release!: () => void, entered!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  await page.route("**/api/staff/exports/excel-v2", async route => { calls++; const response = await route.fetch(); entered(); await held; await route.fulfill({ response }); });
  try {
    await button(page).evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); }); await ready;
    await expect(page.getByRole("button", { name: "Generazione Excel operativo…", exact: true })).toBeDisabled(); expect(calls).toBe(1);
    const pending = page.waitForEvent("download"); release(); await pending; await expect(button(page)).toBeEnabled(); expect(calls).toBe(1);
  } finally { release(); }
});
for (const kind of ["same-user", "admin"] as const) test(`real cookie switch after initial proof is rejected before export: ${kind}`, async ({ page }, info) => {
  await select(page); let release!: () => void, entered!: () => void, owner = "", serverCode = "", downloads = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  page.on("download", () => downloads++);
  // The client aborts on quarantine; collect the real server body before fulfillment.
  await page.route("**/api/staff/exports/excel-v2", async route => {
    const response = await route.fetch(); serverCode = (await response.json()).code;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.route("**/api/auth/draft-context", async route => { const response = await route.fetch(); owner = (await response.json()).sessionBinding; entered(); await held; await route.fulfill({ response }).catch(() => undefined); });
  const before = await fingerprint();
  try {
    await button(page).click(); await ready;
    expect((await page.request.post("/api/auth/login", { headers: { origin }, form: { username: kind === "admin" ? e2eAdminUsername : e2eStaffUsername, password: process.env[kind === "admin" ? "AUTH_DEMO_ADMIN_PASSWORD" : "AUTH_DEMO_STAFF_PASSWORD"] ?? "", returnTo: "/dashboard" }, maxRedirects: 0 })).status()).toBe(303);
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === excelPath); release();
    const response = await pending; expect(response.status()).toBe(403); expect(serverCode).toBe("DRAFT_SESSION_MISMATCH");
    expect(response.request().headers()["x-piccadilly-draft-session-binding"] === owner).toBe(true);
    await expect(page.locator("#preview-error-summary")).toBeVisible(); expect(downloads).toBe(0); expect(await fingerprint()).toEqual(before);
    writeFileSync(info.outputPath("session-evidence.json"), JSON.stringify({ kind, classification: "SERVER_REJECTED_BEFORE_EXPORT_READ", downloads, noBusinessOrExportAuditWrite: true }, null, 2));
  } finally { release(); }
});
test("final proof blocks a silent cookie switch after an already authorized Excel was generated", async ({ page }) => {
  await select(page); let release!: () => void, entered!: () => void, downloads = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  page.on("download", () => downloads++);
  await page.route("**/api/staff/exports/excel-v2", async route => { const response = await route.fetch(); expect(response.status()).toBe(200); entered(); await held; await route.fulfill({ response }).catch(() => undefined); });
  try {
    await button(page).click(); await ready;
    expect((await page.request.post("/api/auth/login", { headers: { origin }, form: { username: e2eStaffUsername, password: process.env.AUTH_DEMO_STAFF_PASSWORD ?? "", returnTo: "/dashboard" }, maxRedirects: 0 })).status()).toBe(303);
    release(); await expect(page.locator("#preview-error-summary")).toContainText("Sessione cambiata"); expect(downloads).toBe(0);
  } finally { release(); }
});
test("changing selection drops an obsolete delayed Excel without starting a download", async ({ page }) => {
  await select(page); let release!: () => void, entered!: () => void, downloads = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  page.on("download", () => downloads++);
  await page.route("**/api/staff/exports/excel-v2", async route => { const response = await route.fetch(); entered(); await held; await route.fulfill({ response }).catch(() => undefined); });
  try {
    await button(page).click(); await ready; await page.getByLabel("Ordina dentro ogni sala").selectOption("NAME_ASC");
    release(); await expect(button(page)).toBeEnabled(); expect(downloads).toBe(0);
  } finally { release(); }
});
for (const kind of ["http", "network", "malformed", "proof"] as const) test(`sanitized error and explicit recovery after ${kind}`, async ({ page }) => {
  await select(page);
  if (kind === "proof") await page.route("**/api/auth/draft-context", route => route.fulfill({ status: 500, json: { code: "INTERNAL_ERROR" } }));
  else await page.route("**/api/staff/exports/excel-v2", route => kind === "network" ? route.abort("failed") : route.fulfill({ status: kind === "http" ? 500 : 200, contentType: "application/json", body: '{"error":"PRIVATE_RAW_MUST_NOT_SHOW"}' }));
  await button(page).click(); await expect(page.locator("#preview-error-summary")).toBeVisible();
  await expect(page.locator("#preview-error-summary")).not.toContainText("PRIVATE_RAW_MUST_NOT_SHOW"); await expect(button(page)).toBeEnabled();
  await page.unroute(kind === "proof" ? "**/api/auth/draft-context" : "**/api/staff/exports/excel-v2");
  expect((await download(page)).suggestedFilename()).toContain("operativo-v2");
});
test("keyboard, responsive controls, T09 preview and M11 remain usable", async ({ page }, info) => {
  await select(page);
  for (const width of [320, 390, 820, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(button(page)).toBeVisible(); await button(page).focus(); await expect(button(page)).toBeFocused();
    await page.screenshot({ path: info.outputPath(`t11-${width}.png`), fullPage: true });
  }
  const pending = page.waitForEvent("download"); await page.keyboard.press("Enter"); await pending;
  await page.getByRole("button", { name: "Mostra anteprima", exact: true }).click(); await expect(page.getByTestId("export-preview-results")).toContainText(marker);
  const legacy = page.waitForEvent("download"); await page.getByTestId("legacy-export-downloads").getByRole("button", { name: "PDF giornata completa", exact: true }).click();
  expect((await legacy).suggestedFilename()).toBe(`piccadilly-prenotazioni-${day}.pdf`);
});

for (const kind of ["zip", "oversize"] as const) test(`rejects invalid Excel response ${kind} without a download`, async ({ page }) => {
  await select(page); let downloads = 0; page.on("download", () => downloads++);
  await page.route("**/api/staff/exports/excel-v2", route => route.fulfill({
    status: 200, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: kind === "zip" ? Buffer.from("INVALID ZIP") : Buffer.alloc(26_214_401, 32),
  }));
  await button(page).click(); await expect(page.locator("#preview-error-summary")).toContainText("Risposta Excel non valida");
  expect(downloads).toBe(0); await expect(button(page)).toBeEnabled();
});
test("revokes the Excel Object URL after download", async ({ page }) => {
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    const state = { created: 0, revoked: 0 };
    Object.assign(window, { t11Urls: state });
    URL.createObjectURL = value => { state.created++; return create(value); };
    URL.revokeObjectURL = value => { state.revoked++; revoke(value); };
  });
  await select(page); await download(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { t11Urls: { created: number; revoked: number } }).t11Urls)).toEqual({ created: 1, revoked: 1 });
});
for (const action of ["route", "pagehide"] as const) test(`drops a delayed Excel after ${action}`, async ({ page }) => {
  await select(page); let release!: () => void, entered!: () => void, downloads = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  page.on("download", () => downloads++);
  await page.route("**/api/staff/exports/excel-v2", async route => { const response = await route.fetch(); entered(); await held; await route.fulfill({ response }).catch(() => undefined); });
  try {
    await button(page).click(); await ready;
    if (action === "route") {
      await page.goto("/dashboard?date=2099-12-17");
      await expect(button(page)).toBeDisabled();
      await page.getByLabel("Soglia della selezione").selectOption("EXCEL");
    }
    else await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    release(); await expect(button(page)).toBeEnabled(); expect(downloads).toBe(0);
  } finally { release(); }
});
