import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { e2eAdminUsername, e2eStaffUsername, e2eRestaurantId, e2eReservationFirstName, e2eRunId } from "./e2e-run";

const target = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname)) throw new Error("T09_TEMPORARY_DATABASE_REQUIRED");
const database = new Pool({ connectionString: process.env.DATABASE_URL });
const day = "2099-12-14", origin = "http://localhost:4000", marker = "T09_NC_" + e2eRunId.slice(0, 8);
const prefix = "T09 " + e2eRunId.slice(0, 8) + " ";
let ids: string[] = [];
const previewPath = "/api/staff/exports/preview";
const isPreview = (url: string) => new URL(url).pathname === previewPath;
async function login(page: Page, role: "STAFF" | "ADMIN" = "STAFF") {
  await page.goto("/login");
  await page.getByLabel("Username").fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page.getByLabel("Password").fill(process.env[role === "ADMIN" ? "AUTH_DEMO_ADMIN_PASSWORD" : "AUTH_DEMO_STAFF_PASSWORD"] ?? "");
  await page.getByRole("button", { name: "Accedi", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/u);
  await page.goto("/dashboard?date=" + day);
}
async function setup() {
  const actor = await database.query("SELECT id FROM users WHERE restaurant_id=$1 AND username=$2", [e2eRestaurantId, e2eStaffUsername]);
  expect(actor.rowCount).toBe(1);
  const rooms = await database.query("SELECT id,code FROM rooms WHERE restaurant_id=$1", [e2eRestaurantId]);
  const roomIds = new Map(rooms.rows.map(row => [row.code, row.id]));
  const cases = [
    { name: "Zulu", children: 0, games: null, room: null, time: "19:30", service: "DINNER", status: "CONFIRMED" },
    { name: "Beta", children: 2, games: true, room: "sala-1", time: "19:45", service: "DINNER", status: "CONFIRMED" },
    { name: "Alpha", children: null, games: null, room: "sala-1", time: "19:00", service: "DINNER", status: "CONFIRMED" },
    { name: "Gamma", children: 1, games: false, room: "galleria", time: "20:00", service: "DINNER", status: "CONFIRMED" },
    { name: "Cleared", children: null, games: null, room: "sala-2", time: "19:15", service: "DINNER", status: "CONFIRMED" },
    { name: "Lunch", children: 0, games: null, room: "sala-3", time: "12:30", service: "LUNCH", status: "CONFIRMED" },
    { name: "Cancelled", children: 0, games: null, room: null, time: "19:00", service: "DINNER", status: "CANCELLED" },
  ];
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index], id = randomUUID(); ids.push(id);
    await database.query("INSERT INTO reservations (id,restaurant_id,local_date,service_type,arrival_time,party_size,children_count,game_room_preference,status,origin,customer_first_name,customer_last_name,customer_phone,customer_email,preferences,allergies,notes,private_notes,privacy_policy_version,privacy_consent_at,privacy_consent_method,created_by_user_id,created_at,updated_at,cancelled_at) VALUES ($1,$2,$3,$4,$5,4,$6,$7,$8,'PHONE',$9,$10,'+390000000909','t09@example.test',$11,'{}',$12,'T09_NI_BROWSER_FORBIDDEN','test-only',now(),'VERBAL',$13,$14,$14,$15)",
      [id, e2eRestaurantId, day, item.service, item.time, item.children, item.games, item.status, e2eReservationFirstName, prefix + item.name,
        JSON.stringify({ children: item.children === null, roomCode: "sala-3", highChair: false, stroller: false, accessibility: false, celebration: null, animals: false }), marker, actor.rows[0].id,
        new Date(Date.UTC(2099, 11, 1, 10, index)), item.status === "CANCELLED" ? new Date() : null]);
    if (item.room) await database.query("INSERT INTO reservation_assignments (id,restaurant_id,reservation_id,room_id,internal_notes,assigned_by_user_id,updated_by_user_id,created_at,updated_at,cleared_at) VALUES ($1,$2,$3,$4,'T09_LEGACY_NI_BROWSER_FORBIDDEN',$5,$5,now(),now(),$6)",
      [randomUUID(), e2eRestaurantId, id, roomIds.get(item.room), actor.rows[0].id, item.name === "Cleared" ? new Date() : null]);
  }
}
async function cleanup() {
  if (!ids.length) return;
  await database.query("DELETE FROM reservation_assignments WHERE restaurant_id=$1 AND reservation_id=ANY($2::uuid[])", [e2eRestaurantId, ids]);
  await database.query("DELETE FROM reservations WHERE restaurant_id=$1 AND id=ANY($2::uuid[])", [e2eRestaurantId, ids]);
  ids = [];
}
async function fingerprint() {
  const rows = await database.query("SELECT id,version,notes,private_notes,updated_at FROM reservations WHERE restaurant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id", [e2eRestaurantId, ids]);
  const audit = await database.query("SELECT count(*)::int AS n FROM audit_events WHERE restaurant_id=$1 AND category='EXPORT'", [e2eRestaurantId]);
  const outbox = await database.query("SELECT count(*)::int AS n FROM notification_outbox WHERE restaurant_id=$1", [e2eRestaurantId]);
  return { business: createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex"), exportAudit: audit.rows[0].n, outbox: outbox.rows[0].n };
}
async function load(page: Page, service = "DINNER") {
  await page.getByLabel("Pranzo o cena per l’anteprima").selectOption(service);
  const response = page.waitForResponse(response => isPreview(response.url()));
  await page.getByRole("button", { name: "Mostra anteprima", exact: true }).click();
  const result = await response; expect(result.status()).toBe(200);
  await expect(page.getByTestId("export-preview-results")).toBeVisible();
  return result;
}
test.beforeEach(async ({ page }) => { await setup(); await login(page); });
test.afterEach(async () => { await cleanup(); });
test.afterAll(async () => { await cleanup(); await database.end(); });

test("D02 explicit service, grouped presentation and privacy do not mutate or audit", async ({ page }) => {
  let calls = 0; page.on("request", request => { if (isPreview(request.url())) calls++; });
  await expect(page.getByLabel("Pranzo o cena per l’anteprima")).toHaveValue("");
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "Mostra anteprima", exact: true }).click();
  await expect(page.locator("#preview-error-summary")).toBeFocused(); expect(calls).toBe(0);
  const before = await fingerprint(), response = await load(page);
  const json = await response.json();
  expect(json.summary).toMatchObject({ reservationCount: 5, partySizeTotal: 20, unknownCompositionCount: 2 });
  expect(json.groups.map((group: { key: string }) => group.key)).toEqual(["UNASSIGNED", "SALA_1", "SALA_2", "SALA_3", "GALLERIA"]);
  const results = page.getByTestId("export-preview-results");
  await expect(results).toContainText("Tutti adulti"); await expect(results).toContainText("Bimbi (2)");
  await expect(results).toContainText("Bambini segnalati senza conteggio"); await expect(results).toContainText("totali parziali");
  await expect(results).toContainText("Giochi richiesti — non garantiti"); await expect(results).toContainText("Area legacy");
  await expect(results).toContainText(marker); await expect(results).not.toContainText("+390000000909");
  await expect(results).not.toContainText("T09_NI_BROWSER_FORBIDDEN"); await expect(results).not.toContainText("T09_LEGACY_NI_BROWSER_FORBIDDEN");
  expect(JSON.stringify(json).includes("T09_NI_BROWSER_FORBIDDEN")).toBe(false);
  expect(json.groups[1].rows.map((row: { customerLastName: string }) => row.customerLastName)).toEqual([prefix + "Beta", prefix + "Alpha"]);
  expect(await fingerprint()).toEqual(before);
  const persisted = await page.evaluate(value => JSON.stringify({ url: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage } }).includes(value), marker);
  expect(persisted).toBe(false);
});
test("D03 sorts inside rooms, keeps legacy selectable and separates lunch and empty", async ({ page }) => {
  await load(page);
  await page.getByLabel("Ordina dentro ogni sala").selectOption("NAME_ASC");
  await load(page);
  const group = page.locator("section[aria-labelledby='preview-room-SALA_1']");
  await expect(group.getByRole("rowheader")).toHaveText([e2eReservationFirstName + " " + prefix + "Alpha", e2eReservationFirstName + " " + prefix + "Beta"]);
  await page.getByLabel("Sala effettiva").selectOption("GALLERIA"); await load(page);
  await expect(page.getByTestId("export-preview-results")).toContainText(prefix + "Gamma");
  await expect(page.getByTestId("export-preview-results")).not.toContainText(prefix + "Beta");
  await page.getByLabel("Sala effettiva").selectOption("ALL"); await load(page, "LUNCH");
  await expect(page.getByTestId("export-preview-results")).toContainText(prefix + "Lunch");
  await expect(page.getByTestId("export-preview-results")).not.toContainText(prefix + "Gamma");
  await page.getByLabel("Data anteprima").fill("2099-12-15"); await load(page);
  await expect(page.getByTestId("export-preview-results")).toContainText("Nessuna prenotazione confermata per la selezione.");
});
test("D05 an obsolete delayed response cannot replace a subsequent selection", async ({ page }) => {
  await page.getByLabel("Pranzo o cena per l’anteprima").selectOption("DINNER");
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { arrived = resolve; });
  let count = 0;
  await page.route("**/api/staff/exports/preview", async route => {
    if (++count !== 1) return route.continue();
    const response = await route.fetch(); arrived(); await held;
    await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.getByRole("button", { name: "Mostra anteprima", exact: true }).click(); await ready;
    await page.getByLabel("Ordina dentro ogni sala").selectOption("NAME_ASC");
    await load(page); release();
    await expect(page.getByTestId("export-preview-results")).toContainText("cognome/nome A–Z");
    await expect(page.locator("section[aria-labelledby='preview-room-SALA_1']").getByRole("rowheader")).toHaveText([e2eReservationFirstName + " " + prefix + "Alpha", e2eReservationFirstName + " " + prefix + "Beta"]);
    expect(count).toBe(2);
  } finally { release(); }
});
for (const kind of ["same-user", "admin"] as const) test("D07 real cookie switch after delayed proof: " + kind, async ({ page }, info) => {
  await load(page);
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { arrived = resolve; });
  let ownerBinding = "";
  await page.route("**/api/auth/draft-context", async route => {
    const response = await route.fetch(), body = await response.json();
    ownerBinding = body.sessionBinding; arrived(); await held; await route.fulfill({ response }).catch(() => undefined);
  });
  const before = await fingerprint();
  try {
    await page.getByRole("button", { name: "Mostra anteprima", exact: true }).click(); await ready;
    await page.evaluate(() => { const state = window as Window & { t09Events?: string[] }; state.t09Events = []; for (const type of ["focus", "visibilitychange", "pageshow"]) addEventListener(type, () => state.t09Events?.push(type)); });
    const switched = await page.request.post("/api/auth/login", { headers: { origin }, form: {
      username: kind === "admin" ? e2eAdminUsername : e2eStaffUsername,
      password: process.env[kind === "admin" ? "AUTH_DEMO_ADMIN_PASSWORD" : "AUTH_DEMO_STAFF_PASSWORD"] ?? "", returnTo: "/dashboard",
    }, maxRedirects: 0 });
    expect(switched.status()).toBe(303);
    const current = await page.request.post("/api/auth/draft-context", { headers: { origin }, data: { challenge: randomUUID() } });
    expect(current.status()).toBe(200); expect((await current.json()).sessionBinding === ownerBinding).toBe(false);
    const events = await page.evaluate(() => { const value = (window as Window & { t09Events?: string[] }).t09Events; if (!value) throw new Error("Event observer missing"); return value; });
    expect(events).toEqual([]);
    const pending = page.waitForResponse(response => isPreview(response.url())); release();
    const response = await pending;
    expect(response.status()).toBe(403); expect((await response.json()).code).toBe("DRAFT_SESSION_MISMATCH");
    expect(response.request().headers()["x-piccadilly-draft-session-binding"] === ownerBinding).toBe(true);
    await expect(page.getByTestId("export-preview-results")).toHaveCount(0);
    expect(await fingerprint()).toEqual(before);
    const evidence = { kind, proofWasRealAndDelayed: true, cookieSwitchedViaCanonicalLogin303: true, windowEventsDuringSwitch: events, bindingChanged: true, dispatched: true, rejectedStatus: response.status(), classification: "SERVER_REJECTED_BEFORE_EXPORT_READ", noBusinessWrite: true, noDownloadAudit: true };
    const file = info.outputPath("cookie-switch-evidence.json"); writeFileSync(file, JSON.stringify(evidence, null, 2));
    await info.attach("cookie-switch", { path: file, contentType: "application/json" });
  } finally { release(); }
});
for (const failure of ["http", "network", "malformed"] as const) test("D05 explicit recovery after " + failure + " without cached data", async ({ page }) => {
  await load(page);
  await page.route("**/api/staff/exports/preview", async route => {
    if (failure === "network") return route.abort("failed");
    if (failure === "malformed") return route.fulfill({ status: 200, contentType: "application/json", body: '{"unexpected":"synthetic"}' });
    return route.fulfill({ status: 500, contentType: "application/json", body: '{"code":"EXPORT_PREVIEW_FAILED","error":"synthetic"}' });
  });
  await page.getByRole("button", { name: "Mostra anteprima", exact: true }).click();
  await expect(page.locator("#preview-error-summary")).toBeVisible();
  await expect(page.getByTestId("export-preview-results")).toHaveCount(0);
  await page.unroute("**/api/staff/exports/preview"); await load(page);
  await expect(page.getByTestId("export-preview-results")).toContainText(marker);
});
for (const proofFailure of ["http", "malformed", "noncanonical-binding"] as const) test("D07 proof " + proofFailure + " prevents dispatch rather than relying on server rejection", async ({ page }) => {
  await load(page);
  let dispatched = 0; page.on("request", request => { if (isPreview(request.url())) dispatched++; });
  await page.route("**/api/auth/draft-context", async route => {
    if (proofFailure === "noncanonical-binding") {
      const response = await route.fetch(); const body = await response.json();
      return route.fulfill({ status: 200, json: { ...body, sessionBinding: "A".repeat(42) + "B" } });
    }
    return route.fulfill({ status: proofFailure === "http" ? 500 : 200, contentType: "application/json", body: '{"error":"INTERNAL_ERROR"}' });
  });
  await page.getByRole("button", { name: "Mostra anteprima", exact: true }).click();
  await expect(page.locator("#preview-error-summary")).toBeVisible(); expect(dispatched).toBe(0);
  await expect(page.getByTestId("export-preview-results")).toHaveCount(0);
});
test("E04 keyboard, responsive reflow and readonly preview preserve markers", async ({ page }, info) => {
  await database.query("UPDATE reservations SET notes=$2 WHERE id=$1", [ids[1], marker + " " + "N".repeat(950)]);
  await load(page);
  const metrics = [];
  for (const width of [320, 390, 820, 1280, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByTestId("export-preview-results")).toContainText(marker);
    await expect(page.getByTestId("export-preview-results")).toContainText("N".repeat(950));
    await expect(page.getByLabel("Data anteprima")).toHaveValue(day);
    await expect(page.getByLabel("Pranzo o cena per l’anteprima")).toHaveValue("DINNER");
    const controls = await page.locator("#preview-date,#preview-service,#preview-room,#preview-order,#preview-target").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
    expect(controls.every(height => height >= 44)).toBe(true);
    const table = page.getByRole("region", { name: "Tabella Sala 1", exact: true });
    await table.focus(); await expect(table).toBeFocused(); await page.keyboard.press("ArrowRight");
    metrics.push(await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth })));
    await page.screenshot({ path: info.outputPath("preview-" + width + ".png"), fullPage: true });
  }
  await page.setViewportSize({ width: 640, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const contrast = await page.getByRole("button", { name: "Mostra anteprima", exact: true }).evaluate(element => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const components = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
      return components[0] * 0.2126 + components[1] * 0.7152 + components[2] * 0.0722;
    };
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  const file = info.outputPath("responsive-evidence.json");
  writeFileSync(file, JSON.stringify({ metrics, longNotesPreserved: true, controlsMinimumHeight: 44, buttonContrast: contrast, keyboardTableRegion: true, reflowSimulation640: true, nativeZoomCertified: false, bfcacheActivated: false, WCAGCertification: false }, null, 2));
  await info.attach("responsive", { path: file, contentType: "application/json" });
});
test("D01 legacy download remains a different contract and generates audit only for the file", async ({ page }) => {
  const before = await fingerprint(); await load(page);
  expect((await fingerprint()).exportAudit).toBe(before.exportAudit);
  await expect(page.getByTestId("export-preview-area")).toContainText("non applicano questi filtri");
  const download = page.waitForEvent("download");
  await page.getByTestId("legacy-export-downloads").getByRole("button", { name: "PDF giornata completa", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("piccadilly-prenotazioni-" + day + ".pdf");
  await expect.poll(async () => (await fingerprint()).exportAudit).toBe(before.exportAudit + 1);
  const after = await fingerprint(); expect(after.business).toBe(before.business); expect(after.outbox).toBe(before.outbox);
});
test("E03 a retained PHONE draft survives preview proof and cross-layout navigation", async ({ page }) => {
  const nav = page.getByRole("navigation", { name: "Navigazione area Staff" });
  await nav.getByRole("link", { name: "Nuova prenotazione", exact: true }).click();
  const input = page.getByLabel("Nome", { exact: true }); await expect(input).toBeVisible(); await input.fill("T09_RETAINED_PHONE");
  await nav.getByRole("link", { name: "Agenda", exact: true }).click();
  await page.getByRole("dialog", { name: "Modifiche non salvate" }).getByRole("button", { name: "Esci conservando la bozza" }).click();
  await load(page);
  await nav.getByRole("link", { name: "Nuova prenotazione", exact: true }).click();
  await page.getByRole("button", { name: "Continua modifica", exact: true }).click();
  await expect(page.getByLabel("Nome", { exact: true })).toHaveValue("T09_RETAINED_PHONE");
});

test("E03 canonical logout 303 and native Back cannot restore the previous preview", async ({ page }, info) => {
  await load(page);
  const persisted: boolean[] = [];
  page.on("console", message => { if (message.text().startsWith("__T09_PAGESHOW_")) persisted.push(message.text() === "__T09_PAGESHOW_true"); });
  await page.addInitScript(() => addEventListener("pageshow", event => console.info("__T09_PAGESHOW_" + event.persisted)));
  await page.evaluate(() => addEventListener("pageshow", event => console.info("__T09_PAGESHOW_" + event.persisted)));
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/logout");
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  expect((await response).status()).toBe(303); await expect(page).toHaveURL(/\/login/u);
  await page.goBack({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("export-preview-results")).toHaveCount(0);
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
  const file = info.outputPath("logout-back-evidence.json");
  writeFileSync(file, JSON.stringify({ canonicalLogoutStatus: 303, nativeBackExecuted: true, previousPreviewAbsent: true, pageshowPersisted: persisted, BFCacheClassification: persisted.includes(true) ? "OBSERVED_THIS_CASE_NOT_GLOBAL_CERTIFICATION" : "NOT_ACTIVATED_NO_BFCACHE_PASS" }, null, 2));
  await info.attach("logout-back", { path: file, contentType: "application/json" });
});

