import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { e2eAdminUsername, e2eStaffUsername, e2eRestaurantId, e2eReservationFirstName, e2eRunId } from "./e2e-run";

const origin = "http://localhost:4000", date = "2099-12-17";
const target = new URL(process.env.DATABASE_URL ?? "");
if (target.hostname !== "127.0.0.1" || !/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname)) throw new Error("T06D_TEMPORARY_DATABASE_REQUIRED");
const db = new Pool({ connectionString: target.href }), owned: string[] = [];
const destinations = [
  ["Impostazioni operative", "/admin/configuration", "Configurazione"],
  ["Orari settimanali", "/admin/schedules", "Configurazione"],
  ["Date speciali", "/admin/special-dates", "Configurazione"],
  ["Sale", "/admin/rooms", "Configurazione"],
  ["Anteprima disponibilità", "/admin/availability-preview", "Configurazione"],
  ["Contenuti pubblici IT/EN", "/admin/public-settings", "Comunicazione"],
  ["Notifiche", "/admin/notification-settings", "Comunicazione"],
  ["Gestione utenti", "/admin/users", "Amministrazione"],
  ["Registro audit", "/admin/audit", "Amministrazione"],
] as const;
const nav = (page: Page) => page.getByRole("navigation", { name: "Navigazione area Staff", exact: true });
const guard = (page: Page) => page.getByRole("dialog", { name: "Modifiche non salvate", exact: true });
async function login(page: Page, role: "ADMIN" | "STAFF" = "ADMIN") {
  await page.goto("/login");
  await page.getByLabel("Username").fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page.getByLabel("Password").fill(process.env[role === "ADMIN" ? "AUTH_DEMO_ADMIN_PASSWORD" : "AUTH_DEMO_STAFF_PASSWORD"] ?? "");
  await page.getByRole("button", { name: "Accedi", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
}
async function create(page: Page) {
  const response = await page.request.post("/api/staff/reservations", { headers: { origin, "Idempotency-Key": crypto.randomUUID() }, data: {
    localDate: date, serviceType: "DINNER", arrivalTime: "19:00", partySize: 2, childrenCount: 0, gameRoomPreference: null,
    customerFirstName: e2eReservationFirstName, customerLastName: "T06D " + e2eRunId, customerPhone: "+390000006064", customerEmail: null,
    highChair: false, stroller: false, accessibility: false, celiac: false, allergies: null, intolerances: null, celebration: null, animals: false,
    notes: "T06D_SHARED", verbalConsentConfirmed: true, sendWhatsAppConfirmation: false, capacityOverride: false, capacityOverrideReason: null,
  } });
  expect(response.status(), await response.text()).toBe(201);
  const row = (await response.json()).reservation as { id: string; version: number }; owned.push(row.id); return row;
}
async function keep(page: Page) { await guard(page).getByRole("button", { name: "Esci conservando la bozza", exact: true }).click(); }
async function phone(page: Page) {
  await page.goto(`/dashboard/reservations/new?date=${date}&service=DINNER`);
  await expect(page.getByLabel("Note", { exact: true })).toBeEnabled();
}
test.afterEach(async () => {
  for (const id of owned.splice(0)) await db.query("UPDATE reservations SET status='CANCELLED',cancelled_at=now() WHERE id=$1 AND restaurant_id=$2 AND status='CONFIRMED'", [id, e2eRestaurantId]);
});
test.afterAll(async () => { await db.end(); });

test("D01 Admin hub has nine canonical destinations, shared groups, active leaf and breadcrumb", async ({ page }) => {
  await login(page); await nav(page).getByRole("link", { name: "Admin", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Hub Admin", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link")).toHaveCount(9);
  for (const label of ["Configurazione", "Comunicazione", "Amministrazione"]) await expect(page.getByRole("main").getByRole("heading", { name: label, exact: true })).toBeVisible();
  for (const [label, path, group] of destinations) {
    await nav(page).getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(origin + path);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav(page).getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    const crumb = page.getByRole("navigation", { name: "Fil d’Arianna" });
    await expect(crumb).toHaveCount(1); await expect(crumb).toContainText(group); await expect(crumb.locator('[aria-current="page"]')).toHaveText(label);
    await expect(page.getByRole("navigation", { name: "Navigazione " + group, exact: true }).getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
  }
  await page.getByRole("navigation", { name: "Fil d’Arianna" }).getByRole("link", { name: "Vai a Hub Admin", exact: true }).click();
  await expect(page).toHaveURL(origin + "/admin");
  for (const [label, path] of destinations) await expect(page.getByRole("main").getByRole("link", { name: label, exact: true })).toHaveAttribute("href", path);
});

test("D04 native links support keyboard activation and modified new-tab clicks", async ({ page }) => {
  await login(page);
  await nav(page).getByRole("link", { name: "Admin", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(origin + "/admin");
  await nav(page).getByRole("link", { name: "Agenda", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(origin + "/dashboard");
  const opened = page.context().waitForEvent("page");
  await nav(page).getByRole("link", { name: "Admin", exact: true }).click({ modifiers: ["Control"] });
  const popup = await opened; await expect(popup).toHaveURL(origin + "/admin");
  await expect(popup.getByRole("heading", { name: "Hub Admin", exact: true })).toBeVisible();
  await expect(page).toHaveURL(origin + "/dashboard"); await popup.close();
});

test("D02 Staff sees only operations and direct Admin pages and APIs remain denied", async ({ page }) => {
  await login(page, "STAFF"); await expect(nav(page).getByRole("link")).toHaveCount(3);
  await expect(nav(page)).not.toContainText("Configurazione"); await expect(nav(page)).not.toContainText("Amministrazione");
  for (const path of ["/admin", ...destinations.map(item => item[1])]) {
    await page.goto(path); await expect(page).toHaveURL(origin + "/dashboard?access=denied");
    await expect(page.getByRole("heading", { name: "Hub Admin", exact: true })).toHaveCount(0);
  }
  for (const path of ["/api/admin/operational-configuration", "/api/admin/public-settings", "/api/admin/notification-settings", "/api/admin/audit", "/api/admin/room-configuration?date=" + date + "&service=DINNER"]) expect((await page.request.get(path)).status()).toBe(403);
  expect((await page.request.post("/api/admin/users", { headers: { origin }, data: {} })).status()).toBe(403);
});

for (const state of ["expired", "revoked", "disabled", "password-change"] as const) test(`D02 canonical ${state} guard survives navigation changes`, async ({ page }) => {
  await login(page);
  try {
    if (state === "expired" || state === "revoked") await db.query(`UPDATE sessions SET ${state === "expired" ? "expires_at=now()-interval '1 minute'" : "revoked_at=now()"} WHERE user_id IN (SELECT id FROM users WHERE username=$1 AND restaurant_id=$2)`, [e2eAdminUsername, e2eRestaurantId]);
    else await db.query(`UPDATE users SET ${state === "disabled" ? "is_active=false,disabled_at=now()" : "must_change_password=true"} WHERE username=$1 AND restaurant_id=$2`, [e2eAdminUsername, e2eRestaurantId]);
    const response = await page.request.get("/api/admin/notification-settings"); expect(response.status()).toBe(state === "password-change" ? 403 : 401);
    await page.goto("/admin"); await expect(page).toHaveURL(state === "password-change" ? /\/cambia-password/u : /\/login/u);
    await expect(page.getByRole("heading", { name: "Hub Admin", exact: true })).toHaveCount(0);
  } finally {
    await db.query("UPDATE users SET is_active=true,disabled_at=null,must_change_password=false WHERE username=$1 AND restaurant_id=$2", [e2eAdminUsername, e2eRestaurantId]);
  }
});

for (const width of [320, 390, 820, 1280, 1440]) test(`D04 navigation keyboard focus and overflow at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 }); await login(page);
  if (width < 768) {
    const button = page.getByRole("button", { name: "Apri navigazione", exact: true }); await button.focus(); await page.keyboard.press("Enter");
    const menu = page.getByRole("dialog", { name: "Menu area Staff", exact: true }); await expect(menu).toBeVisible(); await expect(button).toHaveAttribute("aria-expanded", "true");
    await menu.getByRole("link", { name: "Registro audit", exact: true }).focus(); await page.keyboard.press("Tab");
    expect(await menu.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.screenshot({ path: info.outputPath(`menu-${width}.png`) }); await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0); await expect(button).toBeFocused(); await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click(); await expect(menu).toBeVisible();
    await page.locator("[data-staff-menu-backdrop]").click({ position: { x: width - 8, y: 100 } });
    await expect(menu).toHaveCount(0); await expect(button).toBeFocused();
  } else {
    expect(await page.getByTestId("staff-sidebar").evaluate(node => node.getBoundingClientRect().width)).toBe(width >= 1024 ? 216 : 72);
    const last = nav(page).getByRole("link", { name: "Registro audit", exact: true }); await last.focus(); await expect(last).toBeInViewport();
    await expect(page.getByRole("button", { name: "Logout", exact: true })).toBeInViewport();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`shell-${width}.png`), fullPage: true });
});

test("D04 resizing an open mobile menu releases its trap without navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); const url = page.url();
  await page.getByRole("button", { name: "Apri navigazione", exact: true }).click(); await expect(page.getByRole("dialog", { name: "Menu area Staff" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 }); await expect(page.getByRole("dialog", { name: "Menu area Staff" })).toHaveCount(0);
  await expect(page).toHaveURL(url); await expect(page.locator("#staff-main-content")).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});

for (const choice of ["STAY", "KEEP"] as const) test(`D-COV01 active dirty exit guard survives mobile to desktop resize: ${choice}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await phone(page);
  const field = page.getByLabel("Note", { exact: true }), marker = "T06D_COV01_" + choice;
  await field.fill(marker); const start = page.url();
  const businessRequests: string[] = [];
  page.on("request", request => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/staff/")) businessRequests.push(request.method() + " " + new URL(request.url()).pathname);
  });
  const reservationCount = async () => Number((await db.query("SELECT count(*)::int AS n FROM reservations WHERE restaurant_id=$1", [e2eRestaurantId])).rows[0].n);
  const countBefore = await reservationCount();
  await page.getByRole("button", { name: "Apri navigazione", exact: true }).click();
  await page.getByRole("dialog", { name: "Menu area Staff", exact: true }).getByRole("link", { name: "Admin", exact: true }).click();
  const dialog = guard(page); await expect(dialog).toBeVisible(); await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await dialog.evaluate(node => {
    const audit = { outsideFocus: [] as string[], stop: () => undefined as void };
    const listener = (event: FocusEvent) => {
      if (node.isConnected && !node.contains(event.target as Node)) audit.outsideFocus.push((event.target as Element).tagName);
    };
    document.addEventListener("focusin", listener);
    audit.stop = () => document.removeEventListener("focusin", listener);
    (window as typeof window & { cov01Focus: typeof audit }).cov01Focus = audit;
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(dialog).toBeVisible(); await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("#staff-mobile-navigation")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apri navigazione", exact: true })).toBeHidden();
  await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await page.keyboard.press("Tab"); await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Shift+Tab"); await expect.poll(() => dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await expect(page).toHaveURL(start); expect(businessRequests).toEqual([]);
  await page.screenshot({ path: info.outputPath(`cov01-${choice}-guard-desktop.png`) });
  const outsideFocus = await page.evaluate(() => {
    const audit = (window as typeof window & { cov01Focus: { outsideFocus: string[]; stop: () => void } }).cov01Focus;
    audit.stop(); return audit.outsideFocus;
  });
  expect(outsideFocus).toEqual([]);
  if (choice === "STAY") {
    await dialog.getByRole("button", { name: "Resta", exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(page).toHaveURL(start); await expect(field).toHaveValue(marker); await expect(field).toBeEnabled();
    await expect.poll(() => page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active !== document.body && active !== document.documentElement && active.isConnected && active.getClientRects().length > 0 && !active.closest("[inert],[hidden]");
    })).toBe(true);
    // The retained marker alone is insufficient: a second exit must still see DIRTY.
    await nav(page).getByRole("link", { name: "Admin", exact: true }).click(); await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Resta", exact: true }).click(); await expect(page).toHaveURL(start); await expect(field).toHaveValue(marker);
  } else {
    await keep(page); await expect(page).toHaveURL(origin + "/admin");
    await expect(page.getByRole("heading", { name: "Hub Admin", exact: true })).toBeVisible();
    await expect(page.getByLabel("Note", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Torna al draft PHONE", exact: true }).click(); await expect(page).toHaveURL(origin + "/dashboard/reservations/new");
    await expect(page.getByRole("button", { name: "Continua modifica", exact: true })).toBeVisible();
    await expect(page.getByLabel("Note", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Continua modifica", exact: true }).click(); await expect(field).toHaveValue(marker); await expect(field).toBeEnabled();
    await field.focus(); await expect(field).toBeFocused();
  }
  await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0);
  await expect(page.locator("[inert]")).toHaveCount(0); await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page).toHaveURL(choice === "STAY" ? start : origin + "/dashboard/reservations/new"); await expect(field).toHaveValue(marker);
  await expect(page.getByLabel("Data", { exact: true })).toHaveValue(date);
  if (choice === "KEEP") await expect(field).toBeFocused();
  expect(businessRequests).toEqual([]); expect(await reservationCount()).toBe(countBefore);
  const storage = await page.evaluate(() => JSON.stringify([location.href, history.state, Object.values(localStorage), Object.values(sessionStorage)])); expect(storage).not.toContain(marker);
  await info.attach("cov01-result", { contentType: "application/json", body: JSON.stringify({ choice, outsideFocus, businessRequests, reservationCountUnchanged: true, markerRetained: true, noResidualOverlay: true }) });
  await page.screenshot({ path: info.outputPath(`cov01-${choice}-restored.png`) });
});

for (const kind of ["PHONE", "EDIT", "NI"] as const) test(`D03 ${kind} guarded Staff/Admin, secondary navigation and native history preserve the draft`, async ({ page }) => {
  await login(page); const row = kind === "PHONE" ? null : await create(page);
  if (kind === "PHONE") await phone(page); else await page.goto(`/dashboard/reservations/${row!.id}${kind === "EDIT" ? "/edit" : ""}`);
  const field = page.getByLabel(kind === "NI" ? "Nota interna autonoma (NI)" : "Note", { exact: true }), marker = "T06D_VOLATILE_" + kind;
  await expect(field).toBeEnabled(); await field.fill(marker); const start = page.url();
  await nav(page).getByRole("link", { name: "Admin", exact: true }).click(); await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "Resta", exact: true }).click(); await expect(page).toHaveURL(start); await expect(field).toHaveValue(marker);
  await nav(page).getByRole("link", { name: "Admin", exact: true }).click(); await keep(page); await expect(page).toHaveURL(origin + "/admin");
  await page.getByRole("main").getByRole("link", { name: "Impostazioni operative", exact: true }).click(); await expect(page).toHaveURL(origin + "/admin/configuration");
  await page.getByRole("navigation", { name: "Navigazione Configurazione", exact: true }).getByRole("link", { name: "Orari settimanali", exact: true }).click(); await expect(page).toHaveURL(origin + "/admin/schedules");
  await page.evaluate(() => history.go(-3)); await expect(page).toHaveURL(start);
  await page.getByRole("button", { name: kind === "NI" ? "Continua modifica NI" : "Continua modifica", exact: true }).click(); await expect(field).toHaveValue(marker);
  await page.goForward(); await expect(page).toHaveURL(origin + "/admin"); await page.goBack(); await expect(page).toHaveURL(start);
  await page.getByRole("button", { name: kind === "NI" ? "Continua modifica NI" : "Continua modifica", exact: true }).click(); await expect(field).toHaveValue(marker);
  const storage = await page.evaluate(() => JSON.stringify([location.href, history.state, Object.values(localStorage), Object.values(sessionStorage)])); expect(storage).not.toContain(marker);
  if (row) expect((await db.query("SELECT version FROM reservations WHERE id=$1", [row.id])).rows[0].version).toBe(1);
});

test("D03 mobile dirty guard keeps the menu trigger and selective discard is explicit", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page); await phone(page);
  const field = page.getByLabel("Note", { exact: true }); await field.fill("T06D_MOBILE_KEEP"); const start = page.url();
  await page.getByRole("button", { name: "Apri navigazione", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "Menu area Staff", exact: true }), link = menu.getByRole("link", { name: "Admin", exact: true });
  await link.click(); await expect(guard(page)).toBeVisible(); await expect(page.locator("#staff-mobile-navigation")).toHaveAttribute("inert", "");
  await guard(page).getByRole("button", { name: "Resta", exact: true }).click(); await expect(menu).toBeVisible(); await expect(link).toBeFocused(); await expect(page).toHaveURL(start); await expect(field).toHaveValue("T06D_MOBILE_KEEP");
  await link.click(); await guard(page).getByRole("checkbox", { name: "Scarta soltanto la bozza PHONE", exact: true }).check();
  await guard(page).getByRole("button", { name: "Scarta selezionate ed esci", exact: true }).click(); await expect(page).toHaveURL(origin + "/admin");
  await expect(page.getByRole("button", { name: "Torna al draft PHONE", exact: true })).toHaveCount(0); await expect(menu).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("mobile-hub.png"), fullPage: true });
});

test("D03 retained ROOM survives Admin navigation and logout Resta", async ({ page }) => {
  await login(page); const row = await create(page); await page.goto(`/dashboard/assign-room?date=${date}&service=DINNER`);
  await page.locator(`[data-room-reservation="${row.id}"]`).getByRole("radio").check(); await page.getByRole("button", { name: "Assegna selezionata a Sala 1", exact: true }).click();
  await expect(page.getByTestId("assignment-room-select")).not.toHaveValue(""); await page.keyboard.press("Escape"); await keep(page);
  await nav(page).getByRole("link", { name: "Admin", exact: true }).click(); await page.getByRole("main").getByRole("link", { name: "Notifiche", exact: true }).click();
  await page.getByRole("button", { name: "Logout", exact: true }).click(); await expect(guard(page)).toContainText("ROOM"); await guard(page).getByRole("button", { name: "Resta", exact: true }).click();
  await expect(page.getByRole("button", { name: "Torna al draft ROOM", exact: true })).toBeVisible();
  expect((await db.query("SELECT count(*)::int AS n FROM reservation_assignments WHERE reservation_id=$1", [row.id])).rows[0].n).toBe(0);
});

test("D03 retained PHONE logout failure quarantines and confirmed logout cleans up", async ({ page }) => {
  await login(page); await phone(page); await page.getByLabel("Note", { exact: true }).fill("T06D_LOGOUT_RETAINED");
  await nav(page).getByRole("link", { name: "Admin", exact: true }).click(); await keep(page);
  await page.getByRole("button", { name: "Logout", exact: true }).click(); await expect(guard(page)).toContainText("PHONE"); await guard(page).getByRole("button", { name: "Resta", exact: true }).click();
  await expect(page.getByRole("button", { name: "Torna al draft PHONE", exact: true })).toBeVisible();
  await page.route("**/api/auth/logout", route => route.fulfill({ status: 500, body: "ARTIFICIAL_LOGOUT_FAILURE" }));
  await page.getByRole("button", { name: "Logout", exact: true }).click(); await guard(page).getByRole("button", { name: "Conferma logout e perdita delle bozze", exact: true }).click();
  await expect(page.getByRole("button", { name: "Verifica di nuovo la sessione", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Torna al draft PHONE", exact: true })).toHaveCount(0);
  await page.unroute("**/api/auth/logout"); await page.getByRole("button", { name: "Verifica di nuovo la sessione", exact: true }).click(); await expect(page.getByRole("button", { name: "Torna al draft PHONE", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  const response = page.waitForResponse(value => value.url().endsWith("/api/auth/logout") && value.request().method() === "POST");
  await guard(page).getByRole("button", { name: "Conferma logout e perdita delle bozze", exact: true }).click(); expect((await response).status()).toBe(303);
  await expect(page).toHaveURL(/\/login/u); await page.goBack(); await expect(page.getByLabel("Note", { exact: true })).toHaveCount(0);
});

test("D03 pending PHONE survives menu navigation and late real ACK does not redirect", async ({ page }) => {
  await login(page); await phone(page);
  await page.getByLabel("Nome", { exact: true }).fill(e2eReservationFirstName); const lastName = "T06D Pending " + e2eRunId;
  await page.getByLabel("Cognome", { exact: true }).fill(lastName); await page.getByLabel("Telefono", { exact: true }).fill("+390000006064");
  await page.getByLabel("Slot configurato").selectOption("19:00"); await page.getByLabel(/Confermo di avere acquisito verbalmente/u).check();
  let release: () => void = () => undefined, reached: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { reached = resolve; });
  await page.route("**/api/staff/reservations", async route => { if (route.request().method() !== "POST") return route.continue(); const response = await route.fetch(); const row = (await response.json()).reservation; owned.push(row.id); reached(); await gate; await route.fulfill({ response }); });
  await page.getByRole("button", { name: "Salva prenotazione telefonica", exact: true }).click(); await held;
  await expect(page.getByLabel("Note", { exact: true })).toBeDisabled(); await nav(page).getByRole("link", { name: "Admin", exact: true }).click(); await expect(guard(page)).toContainText("non annulla"); await keep(page);
  await expect(page).toHaveURL(origin + "/admin"); release(); await expect(page.getByText("Salvataggio precedente confermato.", { exact: false })).toBeVisible();
  await expect(page).toHaveURL(origin + "/admin"); await expect(page.getByLabel("Note", { exact: true })).toHaveCount(0);
  expect((await db.query("SELECT count(*)::int AS n FROM reservations WHERE restaurant_id=$1 AND customer_last_name=$2", [e2eRestaurantId, lastName])).rows[0].n).toBe(1);
});
