import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { Pool } from "pg";

import { e2eAdminUsername, e2eReservationFirstName, e2eRestaurantId, e2eRunId, e2eStaffUsername } from "./e2e-run";

const origin = "http://localhost:4000";
const headers = { origin };
const target = new URL(process.env.DATABASE_URL ?? "");
if (!/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname) || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) throw new Error("T05_TEMPORARY_DATABASE_REQUIRED");
const database = new Pool({ connectionString: target.href });
const longRoomId = crypto.randomUUID(), longTableId = crypto.randomUUID();
const longRoomName = "Area sintetica T05 " + "R".repeat(61);
const longTableName = "T05 " + "T".repeat(36);
const note = "Nota sintetica T05 città\n".padEnd(1000, "N");
const viewports = [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 640, height: 360 }];
interface Room { id: string; code: string; name: string; displayOrder: number; isActive: boolean; isAvailableForService: boolean | null; tables: Array<{ id: string; name: string; isActive: boolean }> }
interface Assignment { id: string; room: Room; tables: Array<{ id: string; name: string }>; internalNotes: string | null }
interface Context { reservation: { version: number; status: string }; assignment: Assignment | null; rooms: Room[] }

function evidence(name: string, value: unknown) {
  const folder = process.env.T05_EVIDENCE_DIR;
  if (folder) { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, `${name}.json`), JSON.stringify(value, null, 2) + "\n"); }
}
async function login(page: Page, role: "STAFF" | "ADMIN" = "STAFF") {
  await page.goto("/login"); await page.getByLabel("Username").fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page.getByLabel("Password").fill((role === "ADMIN" ? process.env.AUTH_DEMO_ADMIN_PASSWORD : process.env.AUTH_DEMO_STAFF_PASSWORD) ?? "");
  await page.getByRole("button", { name: "Accedi" }).click(); await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
}
async function create(request: APIRequestContext, date: string, label: string, childrenCount: number | null = 1, gameRoomPreference: boolean | null = true) {
  const response = await request.post("/api/staff/reservations", { headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, data: {
    localDate: date, serviceType: "DINNER", arrivalTime: "19:00", partySize: 4, childrenCount, gameRoomPreference,
    customerFirstName: e2eReservationFirstName, customerLastName: `T05 ${label} ${e2eRunId}`, customerPhone: "+390000005050", customerEmail: null,
    highChair: false, stroller: false, accessibility: false, celiac: false, allergies: null, intolerances: null, celebration: null, animals: false, notes: "Synthetic T05",
    verbalConsentConfirmed: true, sendWhatsAppConfirmation: false, capacityOverride: false, capacityOverrideReason: null,
  } });
  expect(response.status(), await response.text()).toBe(201); return (await response.json()).reservation as { id: string; version: number };
}
async function read(request: APIRequestContext, id: string): Promise<Context> {
  const response = await request.get(`/api/staff/reservations/${id}/assignment`); expect(response.status()).toBe(200); expect(response.headers()["cache-control"]).toContain("no-store"); return response.json();
}
async function stored(id: string) {
  const result = await database.query("SELECT r.version,r.status,r.updated_at,r.arrived_at,r.children_count,r.game_room_preference,r.preferences,r.allergies,a.id AS assignment_id,a.room_id,a.internal_notes,a.cleared_at,a.updated_at AS assignment_updated_at FROM reservations r LEFT JOIN reservation_assignments a ON a.reservation_id=r.id AND a.restaurant_id=r.restaurant_id WHERE r.id=$1 AND r.restaurant_id=$2 AND r.customer_first_name=$3", [id, e2eRestaurantId, e2eReservationFirstName]);
  expect(result.rowCount).toBe(1);
  const links = await database.query("SELECT dining_table_id FROM reservation_assignment_tables WHERE restaurant_id=$1 AND assignment_id=$2 ORDER BY dining_table_id", [e2eRestaurantId, result.rows[0].assignment_id]);
  const audit = await database.query("SELECT action::text,new_state FROM reservation_audit_events WHERE restaurant_id=$1 AND reservation_id=$2 ORDER BY created_at,id", [e2eRestaurantId, id]);
  return { ...result.rows[0], tableIds: links.rows.map((value) => value.dining_table_id as string), actions: audit.rows.map((value) => value.action as string) };
}
function preserved(value: Awaited<ReturnType<typeof stored>>) { return { children: value.children_count, games: value.game_room_preference, preferences: value.preferences, allergies: value.allergies, arrival: value.arrived_at }; }
function card(page: Page, id: string) { return page.locator(`article[data-reservation-id="${id}"]`); }
async function open(page: Page, id: string) {
  await card(page, id).getByRole("button", { name: /^(?:Assegna sala|Gestisci assegnazione|Vedi assegnazione storica)$/u }).click();
  const dialog = page.getByTestId("assignment-dialog"); await expect(dialog).toBeVisible(); await expect(dialog.getByText("Caricamento dello stato corrente…")).toBeHidden(); return dialog;
}
// Room-only UI replaces the retired table/note editor; persisted assertions stay.
async function save(page: Page, dialog: Locator, id: string, expected: { version: number; roomId: string; tableIds: string[]; internalNotes: string | null }) {
  const snapshot = await (await page.request.get(`/api/staff/reservations/${id}/assignment`)).json();
  const pending = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/${id}/room-assignment`));
  await dialog.getByTestId("assignment-save").click(); const response = await pending;
  expect(response.request().postDataJSON()).toEqual({ version: expected.version, roomId: expected.roomId, expectedLocalDate: snapshot.reservation.localDate, expectedServiceType: snapshot.reservation.serviceType }); expect(response.status(), await response.text()).toBe(200);
  expect(await response.json()).toMatchObject({ changed: true, reservationVersion: expected.version + 1 }); await expect(dialog).toBeHidden();
  const db = await stored(id); expect(db).toMatchObject({ version: expected.version + 1, room_id: expected.roomId, tableIds: expected.tableIds, internal_notes: expected.internalNotes, cleared_at: null }); return db;
}

async function put(request: APIRequestContext, id: string, code: string, notes: string | null = null, tables: string[] = []) {
  const context = await read(request, id); const room = context.rooms.find((value) => value.code === code)!;
  const response = await request.put(`/api/staff/reservations/${id}/assignment`, { headers, data: { version: context.reservation.version, roomId: room.id, tableIds: tables, internalNotes: notes } });
  expect(response.status(), await response.text()).toBe(200); return room;
}
async function cancel(request: APIRequestContext, id: string) {
  const current = await stored(id); if (current.status === "CANCELLED") return;
  const response = await request.delete(`/api/staff/reservations/${id}`, { headers, data: { version: current.version } }); expect(response.status(), await response.text()).toBe(200);
}
async function configuration(request: APIRequestContext, date: string, service = "DINNER") {
  const response = await request.get(`/api/admin/room-configuration?date=${date}&service=${service}`); expect(response.status()).toBe(200);
  return (await response.json()).configuration as { rooms: Room[]; service: { lifecycle: string; rooms: Array<{ id: string; configuredAvailable: boolean; isAvailable: boolean }> } };
}
async function apply(request: APIRequestContext, proposal: unknown) {
  const response = await request.post("/api/admin/room-configuration/preview", { headers, data: proposal }); expect(response.status(), await response.text()).toBe(200);
  const preview = (await response.json()).preview;
  if (preview.changed) { const result = await request.post("/api/admin/room-configuration/apply", { headers, data: { proposal, fingerprint: preview.fingerprint } }); expect(result.status(), await result.text()).toBe(200); }
  return preview;
}
function section(page: Page, label: string) { return page.locator("section").filter({ has: page.getByRole("heading", { name: label, exact: true }) }); }
async function metrics(page: Page) {
  const result = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(result.document).toBeLessThanOrEqual(result.width); expect(result.body).toBeLessThanOrEqual(result.width); return result;
}
async function screenshot(page: Page, name: string) { if (process.env.T05_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.T05_EVIDENCE_DIR, `${name}.png`) }); }

test.beforeAll(async () => {
  const identity = await database.query("SELECT current_database() AS name"); expect(identity.rows[0].name).toBe(target.pathname.slice(1));
  expect((await database.query("SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL")).rows[0].count).toBe(16);
  await database.query("INSERT INTO rooms(id,restaurant_id,name,code,display_order,is_active,updated_at) VALUES($1,$2,$3,$4,99,true,NOW())", [longRoomId, e2eRestaurantId, longRoomName, `t05-long-${e2eRunId}`]);
  await database.query("INSERT INTO dining_tables(id,room_id,name,minimum_seats,maximum_seats,is_active,updated_at) VALUES($1,$2,$3,1,2,true,NOW())", [longTableId, longRoomId, longTableName]);
  await database.query("INSERT INTO service_room_availability(id,restaurant_id,service_instance_id,room_id,is_available,updated_at) SELECT gen_random_uuid(),restaurant_id,id,$2,true,NOW() FROM service_instances WHERE restaurant_id=$1 ON CONFLICT(service_instance_id,room_id) DO NOTHING", [e2eRestaurantId, longRoomId]);
});
test.afterAll(async () => {
  try {
    await database.query("DELETE FROM reservation_assignment_tables t USING reservation_assignments a,reservations r WHERE t.assignment_id=a.id AND a.reservation_id=r.id AND a.restaurant_id=$1 AND r.customer_first_name=$2 AND a.room_id=$3", [e2eRestaurantId, e2eReservationFirstName, longRoomId]);
    await database.query("DELETE FROM reservation_assignments a USING reservations r WHERE a.reservation_id=r.id AND a.restaurant_id=$1 AND r.customer_first_name=$2 AND a.room_id=$3", [e2eRestaurantId, e2eReservationFirstName, longRoomId]);
    await database.query("DELETE FROM dining_tables WHERE id=$1 AND room_id=$2", [longTableId, longRoomId]);
    await database.query("DELETE FROM service_room_availability WHERE restaurant_id=$1 AND room_id=$2", [e2eRestaurantId, longRoomId]);
    await database.query("DELETE FROM rooms WHERE id=$1 AND restaurant_id=$2 AND code=$3", [longRoomId, e2eRestaurantId, `t05-long-${e2eRunId}`]);
  } finally { await database.end(); }
});

test.describe.serial("T05 room policy", () => {
  test("1 Staff manual assignment preserves composition, games and arrival independently", async ({ page }) => {
    const date = "2099-10-05"; await login(page); const ref = await create(page.request, date, "Manual");
    try {
      const arrived = await page.request.put(`/api/staff/reservations/${ref.id}/arrival`, { headers, data: { version: 1, arrived: true } }); expect(arrived.status()).toBe(200);
      const before = preserved(await stored(ref.id)); let puts = 0; page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith(`/${ref.id}/room-assignment`)) puts++; });
      await page.goto(`/dashboard?date=${date}&service=DINNER`); const row = card(page, ref.id);
      await expect(row).toContainText("4 coperti"); await expect(row).toContainText("Bimbi (1)"); await expect(row).toContainText("SALA GIOCHI RICHIESTA"); await expect(row.getByTestId("arrival-state")).toHaveText("ARRIVATO");
      const catalog = await read(page.request, ref.id); expect(catalog.rooms.find((room) => room.code === "sala-3")?.name).toBe("Sala 3");
      for (const [index, code] of ["sala-1", "sala-3"].entries()) {
        const dialog = await open(page, ref.id); expect(puts).toBe(index);
        const selected = catalog.rooms.find((room) => room.code === code)!; await dialog.getByTestId("assignment-room-select").selectOption(selected.id);
        const db = await save(page, dialog, ref.id, { version: index + 2, roomId: selected.id, tableIds: [], internalNotes: null }); expect(preserved(db)).toEqual(before);
        await expect(row.getByTestId("final-room-name")).toHaveText(code === "sala-3" ? "Sala 3 — Giochi" : "Sala 1");
      }
      expect(puts).toBe(2);
      const unknown = await create(page.request, date, "Unknown", null, null);
      try {
        const raw = await database.query("SELECT preferences FROM reservations WHERE id=$1 AND restaurant_id=$2", [unknown.id, e2eRestaurantId]);
        await database.query("UPDATE reservations SET preferences=$3 WHERE id=$1 AND restaurant_id=$2", [unknown.id, e2eRestaurantId, JSON.stringify({ ...JSON.parse(raw.rows[0].preferences), children: true, roomCode: "sala-3" })]);
        const rawBefore = preserved(await stored(unknown.id)); await put(page.request, unknown.id, "sala-3"); await page.reload();
        await expect(card(page, unknown.id)).toContainText("Bambini segnalati · numero non specificato"); await expect(card(page, unknown.id)).not.toContainText("SALA GIOCHI RICHIESTA");
        const historicalPreference = await open(page, unknown.id); await expect(historicalPreference.getByText("Sala 3", { exact: true })).toBeVisible(); expect(preserved(await stored(unknown.id))).toEqual(rawBefore);
        evidence("staff-manual-foundation-arrival", { assignmentRequests: puts, rawApiRoom3: "Sala 3", operationalLabel: "Sala 3 — Giochi", knownAndUnknownPreserved: true, arrivalPreserved: true });
      } finally { await cancel(page.request, unknown.id); }
    } finally { await cancel(page.request, ref.id); }
  });
  test("2 Admin enables legacy per service and Staff assigns it without changing other services", async ({ page, browser }) => {
    const date = "2099-10-06"; await login(page, "ADMIN"); const config = await configuration(page.request, date); const legacy = config.rooms.find((room) => room.code === "galleria")!;
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: "DINNER", roomId: legacy.id, isAvailable: true };
    const staff = await browser.newPage(); await login(staff); const ref = await create(staff.request, date, "Legacy");
    try {
      await staff.goto(`/dashboard?date=${date}&service=DINNER`); const unavailable = await open(staff, ref.id);
      await expect(unavailable.getByTestId("assignment-room-select").locator(`option[value="${legacy.id}"]`)).toHaveJSProperty("disabled", true);
      const unavailableResponse = await staff.request.put(`/api/staff/reservations/${ref.id}/assignment`, { headers, data: { version: 1, roomId: legacy.id, tableIds: [], internalNotes: null } });
      expect(unavailableResponse.status()).toBe(409); expect((await unavailableResponse.json()).code).toBe("ROOM_UNAVAILABLE"); expect((await stored(ref.id)).version).toBe(1); await staff.keyboard.press("Escape");
      await page.goto(`/admin/rooms?date=${date}&service=DINNER`); const legacySection = section(page, "Galleria"); await expect(legacySection.getByText("Area legacy", { exact: true })).toBeVisible();
      const preview = page.waitForResponse((response) => response.url().endsWith("/room-configuration/preview")); const applied = page.waitForResponse((response) => response.url().endsWith("/room-configuration/apply"));
      await legacySection.getByRole("button", { name: "Rendi disponibile", exact: true }).click(); expect((await preview).status()).toBe(200); expect((await applied).status()).toBe(200);
      await expect(page.getByRole("status")).toContainText("Configurazione salvata");
      const enabled = await configuration(page.request, date); expect(enabled.service.rooms.find((room) => room.id === legacy.id)).toMatchObject({ configuredAvailable: true, isAvailable: true });
      expect((await configuration(page.request, date, "LUNCH")).service.rooms.find((room) => room.id === legacy.id)?.isAvailable).toBe(false);
      expect(enabled.service.rooms.find((room) => room.id === config.rooms.find((room) => room.code === "terrazzo")?.id)?.isAvailable).toBe(false);
      await staff.reload(); const dialog = await open(staff, ref.id); await dialog.getByTestId("assignment-room-select").selectOption(legacy.id);
      await save(staff, dialog, ref.id, { version: 1, roomId: legacy.id, tableIds: [], internalNotes: null }); await expect(card(staff, ref.id)).toContainText("Area legacy");
      const publicResponse = await page.request.get(`/api/public/availability?date=${date}&service=DINNER&partySize=2`); expect((await publicResponse.json()).rooms).toContainEqual({ code: "galleria", name: "Galleria" });
      evidence("legacy-admin-staff", { previewStatus: 200, applyStatus: 200, assignmentStatus: 200, dinnerEnabled: true, lunchAndTerraceUnchanged: true, publicNamesRaw: true });
    } finally { await cancel(staff.request, ref.id); await apply(page.request, { ...proposal, isAvailable: false }); await staff.close(); }
  });
  test("3 grandfathered legacy remains in history, filter and summary with stale no-op", async ({ page }) => {
    const date = "2099-10-07"; await login(page, "ADMIN"); const config = await configuration(page.request, date); const legacy = config.rooms.find((room) => room.code === "galleria")!;
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: "DINNER", roomId: legacy.id, isAvailable: true };
    await apply(page.request, proposal); const ref = await create(page.request, date, "Grandfather", 0, null);
    try {
      await put(page.request, ref.id, "galleria"); await apply(page.request, { ...proposal, isAvailable: false }); const before = await stored(ref.id);
      const noop = await page.request.put(`/api/staff/reservations/${ref.id}/assignment`, { headers, data: { version: 1, roomId: legacy.id, tableIds: [], internalNotes: null } }); expect(noop.status()).toBe(200); expect(await noop.json()).toMatchObject({ changed: false, reservationVersion: 2 }); expect(await stored(ref.id)).toEqual(before);
      await page.goto(`/dashboard?date=${date}&service=DINNER`); await expect(card(page, ref.id).getByTestId("assignment-grandfathering-warning")).toBeVisible();
      await page.getByTestId("final-room-filter").selectOption("galleria"); await page.getByRole("button", { name: "Applica filtri" }).click(); await expect(card(page, ref.id)).toBeVisible(); await expect(page.getByTestId("final-room-covers")).toContainText("Galleria: 4");
      const fresh = await create(page.request, date, "Invalid legacy");
      try { const invalid = await page.request.put(`/api/staff/reservations/${fresh.id}/assignment`, { headers, data: { version: 1, roomId: legacy.id, tableIds: [], internalNotes: null } }); expect(invalid.status()).toBe(409); expect((await invalid.json()).code).toBe("ROOM_UNAVAILABLE"); } finally { await cancel(page.request, fresh.id); }
      await cancel(page.request, ref.id); await page.goto(`/dashboard?date=${date}&service=DINNER&status=ALL&finalRoom=galleria`);
      const history = await open(page, ref.id); await expect(history).toContainText("Galleria · Area legacy"); await expect(history.getByTestId("assignment-save")).toHaveCount(0); await expect(card(page, ref.id)).toContainText("Storico, escluso dai conteggi operativi.");
      evidence("legacy-history-noop", { noOpStatus: 200, unchangedVersion: before.version, timestampAuditAndLinksUnchanged: true, invalidNewReference: 409, cancelledReadOnly: true, filterRawCode: "galleria" });
    } finally { await cancel(page.request, ref.id); await apply(page.request, { ...proposal, isAvailable: false }); }
  });
  test("4 T04 retains tables/notes, blocks implicit cleanup, handles real409/reload and double submit", async ({ page }) => {
    const date = "2099-10-08"; await login(page); const ref = await create(page.request, date, "Retention");
    try {
      const context = await read(page.request, ref.id), games = context.rooms.find(r => r.code === "sala-3")!, first = context.rooms.find(r => r.code === "sala-1")!;
      await put(page.request, ref.id, "sala-3", note, [games.tables[0].id]); const before = await stored(ref.id);
      await page.goto(`/dashboard?date=${date}&service=DINNER`); const dialog = await open(page, ref.id); await expect(dialog).toContainText(note); await expect(dialog).toContainText(games.tables[0].name); await expect(dialog.getByRole("checkbox")).toHaveCount(0); await expect(dialog.locator("textarea")).toHaveCount(0); expect(await stored(ref.id)).toEqual(before);
      await dialog.getByTestId("assignment-room-select").selectOption(first.id);
      const blocked = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/${ref.id}/room-assignment`)); await dialog.getByTestId("assignment-save").click(); const response = await blocked; expect(response.status()).toBe(409); expect((await response.json()).code).toBe("LEGACY_TABLE_LINKS_PRESENT"); expect(await stored(ref.id)).toEqual(before); await expect(dialog.getByRole("alert")).toBeFocused();
      // The deliberate full-state legacy API retains table removal/note editing semantics.
      await put(page.request, ref.id, "sala-1", note); await put(page.request, ref.id, "sala-1", "Winning note");
      const stale = await page.request.put(`/api/staff/reservations/${ref.id}/assignment`, { headers, data: { version: 2, roomId: games.id, tableIds: [], internalNotes: note } }); expect(stale.status()).toBe(409); expect((await stale.json()).code).toBe("VERSION_CONFLICT");
      await dialog.getByTestId("assignment-reload-conflict").click(); await expect(dialog).toContainText("Winning note"); await dialog.getByRole("button", { name: "Riapplica scelta su versione riletta" }).click(); await dialog.getByTestId("assignment-room-select").selectOption(games.id);
      let release!: () => void, posts = 0; const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route(`**/api/staff/reservations/${ref.id}/room-assignment`, async route => { posts++; await gate; await route.continue(); });
      const waiting = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/${ref.id}/room-assignment`));
      await dialog.getByTestId("assignment-save").evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await expect(dialog).toHaveAttribute("aria-busy", "true"); await expect(dialog.getByTestId("assignment-save")).toBeDisabled(); await expect.poll(() => posts).toBe(1); expect((await stored(ref.id)).version).toBe(4); release();
      expect((await waiting).status()).toBe(200); await expect(dialog).toBeHidden(); expect((await stored(ref.id)).version).toBe(5); await page.unrouteAll({ behavior: "ignoreErrors" });
      await put(page.request, ref.id, "sala-3", "Winning note", [games.tables[0].id]); await put(page.request, ref.id, "sala-3", "Winning note", []); expect((await stored(ref.id)).version).toBe(7);
      const deleted = await page.request.delete(`/api/staff/reservations/${ref.id}/assignment`, { headers, data: { version: 7 } }); expect(deleted.status()).toBe(200); const cleared = await stored(ref.id); expect(cleared.cleared_at).not.toBeNull(); expect(cleared.tableIds).toEqual([]); expect(cleared.internal_notes).toBe("Winning note");
      await put(page.request, ref.id, "sala-3"); expect((await stored(ref.id)).assignment_id).toBe(before.assignment_id);
      evidence("t04-retention-conflict", { originalTableAndNotesRetained: true, real409: true, explicitReload: true, doubleSubmitRequestCount: posts, tableRemovalDistinctFromDelete: true, reactivatedSameIdentity: true });
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await cancel(page.request, ref.id); }
  });
  test("5 Admin preserves order/policy, distinguishes global/local/effective and historical scope", async ({ page, browser }) => {
    const date = "2099-10-09"; await login(page, "ADMIN"); const config = await configuration(page.request, date), legacy = config.rooms.find((room) => room.code === "galleria")!;
    const local = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: "DINNER", roomId: legacy.id, isAvailable: true };
    const catalog = { kind: "ROOM_CATALOG", roomId: legacy.id, displayOrder: 0, isActive: false };
    try {
      await apply(page.request, local); await apply(page.request, catalog); await page.goto(`/admin/rooms?date=${date}&service=DINNER`);
      const legacySection = section(page, "Galleria"); await expect(legacySection.locator("dt").filter({ hasText: /^Stato globale$/u }).locator(".." )).toContainText("Inattiva");
      await expect(legacySection.locator("dt").filter({ hasText: /^Configurata per questo servizio$/u }).locator("..")).toContainText("Sì");
      await expect(legacySection.locator("dt").filter({ hasText: /^Disponibilità effettiva$/u }).locator("..")).toContainText("Non disponibile");
      const headings = await page.getByRole("heading", { level: 2 }).allTextContents(); expect(headings.indexOf("Galleria")).toBeLessThan(headings.indexOf("Sala 1")); await expect(section(page, "Sala 3 — Giochi")).toContainText("Disponibile per default");
      await expect(legacySection.locator('input[name="roomName"],input[name="code"],select[name="serviceAvailabilityPolicy"]')).toHaveCount(0);
      await apply(page.request, { ...catalog, isActive: true }); const enabled = await configuration(page.request, date); expect(enabled.service.rooms.find((room) => room.id === legacy.id)).toMatchObject({ configuredAvailable: true, isAvailable: true });
      const instancesBefore = await database.query("SELECT id,version,updated_at FROM service_instances WHERE restaurant_id=$1 ORDER BY id", [e2eRestaurantId]);
      await page.goto("/admin/rooms?date=2020-01-01&service=DINNER"); await expect(page.getByText("La disponibilità del servizio storico è in sola lettura. Lo stato globale delle sale è quello attuale.")).toBeVisible();
      await expect(section(page, "Galleria").getByRole("button", { name: /^Rendi (?:non )?disponibile$/u })).toBeDisabled(); await expect(section(page, "Galleria").getByRole("button", { name: "Salva sala", exact: true })).toBeEnabled();
      expect((await database.query("SELECT id,version,updated_at FROM service_instances WHERE restaurant_id=$1 ORDER BY id", [e2eRestaurantId])).rows).toEqual(instancesBefore.rows);
      const staff = await browser.newPage(); try { await login(staff); expect((await staff.request.get(`/api/admin/room-configuration?date=${date}&service=DINNER`)).status()).toBe(403); } finally { await staff.close(); }
      evidence("admin-policy-order", { configuredOrderPreserved: true, globalLocalEffectiveDistinct: true, rawPolicyUnchanged: true, historicalLocalReadOnlyGlobalCurrent: true, readsNeverMaterialize: true, staffDenied: 403 });
    } finally { await apply(page.request, { ...catalog, displayOrder: legacy.displayOrder, isActive: true }); await apply(page.request, { ...local, isAvailable: false }); }
  });
  test("6 responsive/accessibility, long content, focus/keyboard and busy/error/success", async ({ page }) => {
    const date = "2099-10-10"; await login(page, "ADMIN"); const ref = await create(page.request, date, "Responsive");
    try {
      await apply(page.request, { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: "DINNER", roomId: longRoomId, isAvailable: true });
      const raw = await database.query("SELECT preferences FROM reservations WHERE id=$1 AND restaurant_id=$2", [ref.id, e2eRestaurantId]); await database.query("UPDATE reservations SET preferences=$3,notes=$4 WHERE id=$1 AND restaurant_id=$2", [ref.id, e2eRestaurantId, JSON.stringify({ ...JSON.parse(raw.rows[0].preferences), legacyText: "L".repeat(1000) }), note]);
      const records = [];
      for (const viewport of viewports) {
        await page.setViewportSize(viewport); await page.goto(`/admin/rooms?date=${date}&service=DINNER`); await expect(section(page, "Sala 3 — Giochi")).toBeVisible(); await expect(section(page, longRoomName)).toBeVisible();
        const legacy = section(page, "Galleria").getByText("Area legacy", { exact: true }); await expect(legacy).toBeVisible();
        const targets = await page.locator('main button:not(:disabled),main select,main input:not([type="checkbox"]),main label:has(input[type="checkbox"])').evaluateAll((nodes) => nodes.map((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
        expect(targets.every((node) => node.height >= 44 && node.width >= 44)).toBe(true);
        const contrast = await legacy.evaluate((node) => {
          const style = getComputedStyle(node), canvas = document.createElement("canvas").getContext("2d")!;
          function luminance(value: string) { canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1); const rgb = [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3).map((n) => { const c = n / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722; }
          const fg = luminance(style.color), bg = luminance(style.backgroundColor); return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        }); expect(contrast).toBeGreaterThanOrEqual(4.5); records.push({ viewport, admin: await metrics(page), legacyContrast: contrast, reflow: viewport.width === 640 ? "200% equivalent 1280x720→640x360 CSS reflow, not browser zoom" : null }); await screenshot(page, `t05-admin-${viewport.width}x${viewport.height}`);
      }
      // Legacy table/note editing is now an explicit API compatibility proof.
      const seeded = await read(page.request, ref.id); const long = seeded.rooms.find(r => r.id === longRoomId)!;
      const legacyWrite = await page.request.put(`/api/staff/reservations/${ref.id}/assignment`, { headers, data: { version: 1, roomId: longRoomId, tableIds: [long.tables[0].id], internalNotes: note } }); expect(legacyWrite.status()).toBe(200);
      await page.goto(`/dashboard?date=${date}&service=DINNER`); const trigger = card(page, ref.id).getByRole("button", { name: "Gestisci assegnazione", exact: true }); await trigger.focus(); await page.keyboard.press("Enter"); let dialog = page.getByTestId("assignment-dialog"); await expect(dialog).toContainText(note); await expect(dialog.getByRole("button", { name: "Chiudi gestione assegnazione" })).toBeFocused();
      const roomSelect = dialog.getByRole("combobox", { name: "Sala definitiva", exact: true }); await expect(roomSelect).toHaveCount(1); await expect(roomSelect).toHaveAccessibleName("Sala definitiva"); expect(await roomSelect.evaluate(node => (node as HTMLSelectElement).labels?.length)).toBe(1);
      await expect(dialog.getByRole("checkbox")).toHaveCount(0); await expect(dialog.locator("textarea")).toHaveCount(0); await expect(dialog).toContainText(longTableName);
      for (const viewport of viewports) { await page.setViewportSize(viewport); records.push({ viewport, dialog: await metrics(page) }); await expect(dialog).toContainText(note); expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true); const targets = await dialog.locator("button:not(:disabled),select").evaluateAll(nodes => nodes.map(n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height }))); expect(targets.every(n => n.width >= 44 && n.height >= 44)).toBe(true); await screenshot(page, `t05-dialog-${viewport.width}x${viewport.height}`); }
      await dialog.getByTestId("assignment-save").focus(); await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "Chiudi gestione assegnazione" })).toBeFocused(); await page.keyboard.press("Shift+Tab"); await expect(dialog.getByTestId("assignment-save")).toBeFocused();
      // Retire the old UI's table mutation, retain a real HTTP409 through the new command.
      const context = await read(page.request, ref.id), legacy = context.rooms.find(r => r.code === "terrazzo")!;
      await page.route(`**/api/staff/reservations/${ref.id}/room-assignment`, async route => { const body = route.request().postDataJSON(); await route.continue({ postData: JSON.stringify({ ...body, roomId: legacy.id }) }); });
      const rejected = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/${ref.id}/room-assignment`)); await dialog.getByTestId("assignment-save").click(); expect((await rejected).status()).toBe(409); await expect(dialog.getByRole("alert")).toBeFocused(); await expect(dialog).toHaveAttribute("aria-describedby", await dialog.getByRole("alert").getAttribute("id") ?? ""); expect((await stored(ref.id)).version).toBe(2);
      await page.unrouteAll({ behavior: "ignoreErrors" }); await dialog.getByTestId("assignment-reload-conflict").click(); await dialog.getByRole("button", { name: "Adotta sala riletta" }).click();
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); await page.route(`**/api/staff/reservations/${ref.id}/room-assignment`, async route => { await gate; await route.continue(); });
      const success = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith(`/${ref.id}/room-assignment`)); const before = await stored(ref.id); await dialog.getByTestId("assignment-save").click(); await expect(dialog).toHaveAttribute("aria-busy", "true"); release(); expect((await success).status()).toBe(200); await expect(dialog).toBeHidden(); expect(await stored(ref.id)).toEqual(before); await expect(trigger).toBeFocused();
      await expect(card(page, ref.id).getByRole("status").filter({ hasText: "Nessuna modifica: la sala era già aggiornata." })).toBeVisible();
      for (const viewport of viewports) { await page.setViewportSize(viewport); await metrics(page); await expect(card(page, ref.id).getByTestId("final-room-name")).toHaveText(longRoomName); await expect(card(page, ref.id)).toContainText(longTableName); }
      await page.unrouteAll({ behavior: "ignoreErrors" }); await cancel(page.request, ref.id); await page.goto(`/dashboard?date=${date}&service=DINNER&status=ALL`); dialog = await open(page, ref.id); await expect(dialog).toContainText(longRoomName); await expect(dialog).toContainText(note); for (const viewport of viewports) { await page.setViewportSize(viewport); await metrics(page); }
      evidence("responsive-accessibility", { records, roomCodePoints: [...longRoomName].length, tableCodePoints: [...longTableName].length, notesCodePoints: [...note].length, legacyCodePoints: 1000, keyboardFocusTrapAndReturn: true, realError409: true, busyAndServerConfirmedSuccess: true, cancelledHistoryUntruncated: true, target: "engineering checks; no formal WCAG certification" });
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await cancel(page.request, ref.id); }
  });
});
