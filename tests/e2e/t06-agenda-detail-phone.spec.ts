import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { Pool } from "pg";
import { e2eAdminUsername, e2eReservationFirstName, e2eRestaurantId, e2eRunId } from "./e2e-run";

const origin = "http://localhost:4000", date = "2099-12-16";
const target = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname)) throw new Error("T06B_TEMPORARY_DATABASE_REQUIRED");
const database = new Pool({ connectionString: target.href }), owned: string[] = [];
async function login(page: Page, path = "/dashboard") {
  await page.goto("/login?returnTo=" + encodeURIComponent(path));
  await page.getByLabel("Username").fill(e2eAdminUsername);
  await page.getByLabel("Password").fill(process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "");
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(new RegExp(path.replace(/[?]/gu, "\\?")));
}
function payload(label: string) { return { localDate: date, serviceType: "DINNER", arrivalTime: "19:00", partySize: 4, childrenCount: 0, gameRoomPreference: null,
  customerFirstName: e2eReservationFirstName, customerLastName: "T06B " + label + " " + e2eRunId, customerPhone: "+390000000616", customerEmail: null,
  highChair: false, stroller: false, accessibility: false, celiac: false, allergies: null, intolerances: null, celebration: null, animals: false,
  notes: "T06B_SHARED_NC", verbalConsentConfirmed: true, sendWhatsAppConfirmation: false, capacityOverride: false, capacityOverrideReason: null }; }
async function create(request: APIRequestContext, label: string, extra = {}) {
  const result = await request.post("/api/staff/reservations", { headers: { origin, "Idempotency-Key": crypto.randomUUID() }, data: { ...payload(label), ...extra } });
  expect(result.status(), await result.text()).toBe(201); const row = (await result.json()).reservation as { id: string; version: number }; owned.push(row.id); return row;
}
async function stored(id: string) { const result = await database.query("SELECT id,version,status,notes,private_notes,children_count,game_room_preference,local_date,arrived_at FROM reservations WHERE id=$1 AND restaurant_id=$2", [id, e2eRestaurantId]); expect(result.rowCount).toBe(1); return result.rows[0]; }
test.afterEach(async ({ page }) => { for (const id of owned.splice(0)) { const row = await stored(id); if (row.status === "CONFIRMED") { const response = await page.request.delete("/api/staff/reservations/" + id, { headers: { origin }, data: { version: row.version } }); expect(response.status()).toBe(200); } } });
test.afterAll(async () => database.end());

test("F03 Agenda emphasizes children and present NC/NI/legacy semantically and visually", async ({ page }, info) => {
  await login(page);
  const item = await create(page.request, "Visual children", { childrenCount: 2, gameRoomPreference: false });
  const unknown = await create(page.request, "Visual unknown", { childrenCount: null, gameRoomPreference: null, notes: null });
  const adults = await create(page.request, "Visual TA", { notes: null });
  expect((await page.request.put("/api/staff/reservations/" + item.id + "/private-notes", { headers: { origin }, data: { version: 1, privateNotes: "F03_PRIVATE_MARKER" } })).status()).toBe(200);
  const room = (await database.query("SELECT id FROM rooms WHERE restaurant_id=$1 AND is_active=true ORDER BY display_order,id LIMIT 1", [e2eRestaurantId])).rows[0].id as string;
  expect((await page.request.put("/api/staff/reservations/" + item.id + "/assignment", { headers: { origin }, data: { version: 2, roomId: room, tableIds: [], internalNotes: "F03_LEGACY_MARKER" } })).status()).toBe(200);
  await page.goto("/dashboard?date=" + date);
  const row = page.locator('article[data-reservation-id="' + item.id + '"]');
  const children = row.getByText("Bimbi (2)", { exact: true }); await expect(children).toHaveJSProperty("tagName", "STRONG"); await expect(children).toHaveCSS("font-weight", "600");
  for (const label of ["NC condivisa presente", "NI autonoma presente", "NI legacy presente · assegnazione attiva"]) {
    const indicator = row.getByText(label, { exact: true }); await expect(indicator).toHaveJSProperty("tagName", "STRONG"); await expect(indicator).toHaveCSS("font-weight", "600");
    await expect(indicator.locator("..")).toHaveAttribute("data-note-presence", "present"); await expect(indicator.locator("..")).toHaveCSS("border-top-width", "2px");
  }
  const unknownRow = page.locator('article[data-reservation-id="' + unknown.id + '"]'), adultRow = page.locator('article[data-reservation-id="' + adults.id + '"]');
  await expect(unknownRow.getByTestId("agenda-composition")).toHaveText("Composizione non specificata"); await expect(adultRow.getByTestId("agenda-composition")).toHaveText("TA");
  await expect(unknownRow.getByTestId("agenda-composition").locator("strong")).toHaveCount(0);
  await expect(unknownRow.locator('[data-note-presence="absent"]').first()).toHaveCSS("border-top-width", "1px");
  await expect(unknownRow.locator('[data-note-presence="absent"] strong')).toHaveCount(0);
  await expect(row).not.toContainText("F03_PRIVATE_MARKER"); await expect(row).not.toContainText("F03_LEGACY_MARKER");
  for (const width of [320, 390, 820, 1440]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: info.outputPath("f03-agenda-" + width + ".png"), fullPage: true }); }
  expect((await page.request.delete("/api/staff/reservations/" + item.id + "/assignment", { headers: { origin }, data: { version: 3 } })).status()).toBe(200);
  await page.reload(); await expect(row.getByText("NI legacy presente · assegnazione rimossa", { exact: true })).toHaveJSProperty("tagName", "STRONG");
  expect((await stored(item.id)).children_count).toBe(2);
});

test("B-E01/E02: compact composition, separate presence and fixed drawer instance through resize", async ({ page }, info) => {
  await login(page);
  const item = await create(page.request, "Detail");
  expect((await page.request.put("/api/staff/reservations/" + item.id + "/private-notes", { headers: { origin }, data: { version: 1, privateNotes: "T06B_PRIVATE_DOSSIER_MARKER" } })).status()).toBe(200);
  const response = await page.goto("/dashboard?date=" + date);
  expect(await response!.text()).not.toContain("T06B_PRIVATE_DOSSIER_MARKER");
  const row = page.locator('article[data-reservation-id="' + item.id + '"]');
  await expect(row).toContainText("TA"); await expect(row).toContainText("NC condivisa presente"); await expect(row).toContainText("NI autonoma presente");
  await page.setViewportSize({ width: 1280, height: 720 }); await row.locator("[data-open-reservation]").click();
  const drawer = page.getByRole("dialog", { name: "Dettaglio prenotazione", exact: true }), note = drawer.getByLabel("Nota interna autonoma (NI)", { exact: true });
  await expect(note).toHaveValue("T06B_PRIVATE_DOSSIER_MARKER");
  await note.fill("T06B_RESIZE_DRAFT");
  for (const viewport of [{width:320,height:640},{width:390,height:844},{width:820,height:1180},{width:1023,height:720},{width:1024,height:720},{width:1280,height:720},{width:1440,height:900}]) {
    await page.setViewportSize(viewport); await expect(drawer).toBeVisible(); await expect(note).toHaveValue("T06B_RESIZE_DRAFT");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("detail-" + viewport.width + ".png") });
  }
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await expect(note).toHaveValue("T06B_RESIZE_DRAFT");
  await page.screenshot({ path: info.outputPath("detail-zoom200.png") });
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await page.keyboard.press("Escape"); const guard = page.getByRole("dialog", { name: "Modifiche non salvate" }); await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "Resta", exact: true }).click(); await expect(note).toHaveValue("T06B_RESIZE_DRAFT");
  await drawer.getByRole("button", { name: "Chiudi dettaglio" }).click(); await guard.getByRole("button", { name: "Esci conservando la bozza" }).click();
  await expect(row.locator("[data-open-reservation]")).toBeFocused();
  await page.setViewportSize({ width: 1023, height: 800 }); await row.locator("[data-open-reservation]").click();
  await expect(page).toHaveURL(new RegExp("/dashboard/reservations/" + item.id + "$")); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Continua modifica NI" }).click(); await expect(page.getByLabel("Nota interna autonoma (NI)", { exact: true })).toHaveValue("T06B_RESIZE_DRAFT");
});

test("B-E03: detail deep link has own SSR authorization, exact callback and tenant isolation", async ({ page, browser }) => {
  await login(page); const item = await create(page.request, "DeepLink");
  const anonymous = await browser.newContext(), tab = await anonymous.newPage();
  await tab.goto("/dashboard/reservations/" + item.id); await expect(tab).toHaveURL(/\/login\?returnTo=/u);
  await tab.getByLabel("Username").fill(e2eAdminUsername); await tab.getByLabel("Password").fill(process.env.AUTH_DEMO_ADMIN_PASSWORD ?? ""); await tab.getByRole("button", { name: "Accedi" }).click();
  await expect(tab).toHaveURL(new RegExp("/dashboard/reservations/" + item.id + "$")); await expect(tab.getByRole("heading", { name: "Dettaglio prenotazione", exact: true })).toBeVisible();
  expect((await tab.goto("/dashboard/reservations/not-a-uuid"))?.status()).toBe(404);
  expect((await tab.goto("/dashboard/reservations/" + crypto.randomUUID()))?.status()).toBe(404);
  await anonymous.close();
});

test("B-E04: PHONE captures full payload, retry identity and actual returned detail ID without reset", async ({ page }) => {
  await login(page); await page.goto("/dashboard/reservations/new?date=" + date + "&service=LUNCH");
  await expect(page.getByLabel("Servizio", { exact: true })).toHaveValue("LUNCH");
  await page.getByLabel("Servizio", { exact: true }).selectOption("DINNER");
  await page.getByLabel("Slot configurato").selectOption("19:00"); await page.getByLabel("Nome", { exact: true }).fill(e2eReservationFirstName);
  const lastName = "T06B Phone " + e2eRunId;
  await page.getByLabel("Cognome", { exact: true }).fill(lastName); await page.getByLabel("Telefono", { exact: true }).fill("+390000000616");
  await page.getByLabel("Note", { exact: true }).fill("T06B_PHONE_NC"); await page.getByLabel(/Confermo di avere acquisito verbalmente/u).check();
  await page.getByLabel("Invia conferma WhatsApp", { exact: false }).uncheck();
  let firstKey = "", firstPayload = "", calls = 0, release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/staff/reservations", async route => { if (route.request().method() !== "POST") return route.continue();
    calls++; if (calls === 1) { firstKey = route.request().headers()["idempotency-key"]; firstPayload = route.request().postData()!; const response = await route.fetch(); expect(response.status()).toBe(201); owned.push((await response.json()).reservation.id); await held; return route.abort("failed"); }
    expect(route.request().headers()["idempotency-key"]).toBe(firstKey); expect(route.request().postData()).toBe(firstPayload); return route.continue();
  });
  await page.getByRole("button", { name: "Salva prenotazione telefonica" }).click();
  await expect(page.getByLabel("Note", { exact: true })).toBeDisabled(); await expect(page.getByLabel(/Confermo di avere acquisito verbalmente/u)).toBeDisabled();
  await page.getByRole("button", { name: "Salvataggio…", exact: true }).dispatchEvent("click"); expect(calls).toBe(1); release();
  await expect(page.getByRole("alert").filter({ hasText: "Errore di rete" })).toBeVisible();
  await expect(page.getByLabel("Note", { exact: true })).toHaveValue("T06B_PHONE_NC");
  const ack = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/staff/reservations");
  await page.getByRole("button", { name: "Salva prenotazione telefonica" }).click(); const response = await ack; expect(response.status()).toBe(200);
  const body = await response.json(); expect(body.replayed).toBe(true); expect(firstPayload).not.toContain("privateNotes"); expect(calls).toBe(2);
  await expect(page.getByLabel("Cognome", { exact: true })).toHaveValue(lastName);
  await expect(page.getByRole("link", { name: "Apri dettaglio", exact: true })).toHaveAttribute("href", "/dashboard/reservations/" + body.reservation.id);
  expect((await database.query("SELECT count(*)::int AS n FROM reservations WHERE restaurant_id=$1 AND customer_last_name=$2", [e2eRestaurantId, lastName])).rows[0].n).toBe(1);
  await page.getByRole("link", { name: "Torna Agenda", exact: true }).click();
  await page.getByRole("link", { name: "Nuova prenotazione", exact: true }).click();
  await expect(page.getByLabel("Nome", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Continua modifica", exact: true })).toHaveCount(0);
});

test("B-E05: Edit success returns to originating Agenda; reschedule preserves NI and clears assignment only server-side", async ({ page }) => {
  await login(page); const item = await create(page.request, "Reschedule");
  await page.request.put("/api/staff/reservations/" + item.id + "/private-notes", { headers: { origin }, data: { version: 1, privateNotes: "T06B_RESCHEDULE_NI" } });
  const context = await (await page.request.get("/api/staff/reservations/" + item.id + "/assignment")).json();
  expect((await page.request.put("/api/staff/reservations/" + item.id + "/assignment", { headers: { origin }, data: { version: 2, roomId: context.rooms.find((room: {code:string}) => room.code === "sala-1").id, tableIds: [], internalNotes: null } })).status()).toBe(200);
  const source = "/dashboard?date=" + date + "&service=DINNER&status=CONFIRMED&origin=PHONE&assignment=ASSIGNED&finalRoom=ALL";
  await page.goto(source); const row = page.locator('article[data-reservation-id="' + item.id + '"]');
  await row.locator("[data-open-reservation]").click(); await page.getByRole("dialog", { name: "Dettaglio prenotazione", exact: true }).getByRole("link", { name: "Modifica", exact: true }).click();
  await page.getByLabel("Data", { exact: true }).fill("2099-12-17"); await page.getByLabel("Note", { exact: true }).fill("T06B_EDIT_NC");
  await page.getByRole("button", { name: "Salva modifiche", exact: true }).click(); await expect(page).toHaveURL(source);
  await expect(page.getByRole("link", { name: "Apri Agenda della nuova destinazione" })).toHaveAttribute("href", /date=2099-12-17/u);
  const final = await stored(item.id); expect(final.private_notes).toBe("T06B_RESCHEDULE_NI"); expect(final.notes).toBe("T06B_EDIT_NC"); expect(final.version).toBe(4);
  expect((await database.query("SELECT cleared_at FROM reservation_assignments WHERE reservation_id=$1", [item.id])).rows[0].cleared_at).not.toBeNull();
});

test("B-E06: cancelled detail is read-only for NC/NI/assignment while preserving T03 controls", async ({ page }) => {
  await login(page); const item = await create(page.request, "Cancelled");
  await page.request.delete("/api/staff/reservations/" + item.id, { headers: { origin }, data: { version: 1 } });
  await page.goto("/dashboard/reservations/" + item.id);
  await expect(page.getByLabel("Nota interna autonoma (NI)", { exact: true })).toHaveAttribute("readonly", "");
  await expect(page.getByRole("link", { name: "Modifica", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Vedi assegnazione storica" })).toBeVisible();
  await expect(page.getByText(/Cancellata/u).first()).toBeVisible();
});

test("B-H02/B-E08: partial failures and stale section versions never replace the NI draft", async ({ page }) => {
  await login(page); const item = await create(page.request, "Partial");
  const earlier = await (await page.request.get("/api/staff/reservations/" + item.id + "/private-notes")).json();
  await page.request.put("/api/staff/reservations/" + item.id + "/private-notes", { headers: { origin }, data: { version: 1, privateNotes: "T06B_NEWER_CANONICAL_NI" } });
  let reads = 0;
  await page.route("**/api/staff/reservations/" + item.id + "/assignment", route => route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"INTERNAL_ERROR"}' }));
  await page.route("**/api/staff/reservations/" + item.id + "/private-notes", route => { if (route.request().method() !== "GET") return route.continue(); reads++; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(earlier) }); });
  await page.goto("/dashboard/reservations/" + item.id);
  await expect(page.getByText("T06B_SHARED_NC", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Versioni differenti" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Lettura non disponibile" })).toBeVisible();
  const field = page.getByLabel("Nota interna autonoma (NI)", { exact: true }); await field.fill("T06B_INTACT_LOCAL_NI");
  expect(reads).toBe(1);
  await page.unroute("**/api/staff/reservations/" + item.id + "/private-notes");
  await page.getByRole("button", { name: "Rileggi nota senza sostituire bozza" }).click();
  await expect(page.getByText("Nota canonica riletta: T06B_NEWER_CANONICAL_NI · versione 2", { exact: true })).toBeVisible();
  await expect(field).toHaveValue("T06B_INTACT_LOCAL_NI");
  expect((await stored(item.id)).private_notes).toBe("T06B_NEWER_CANONICAL_NI");
});
