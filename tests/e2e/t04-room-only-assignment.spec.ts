import "dotenv/config";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { Pool } from "pg";

import { e2eAdminUsername, e2eReservationFirstName, e2eRestaurantId, e2eRunId, e2eStaffUsername } from "./e2e-run";

const origin = "http://localhost:4000";
const database = new Pool({ connectionString: process.env.DATABASE_URL });
const emptyRoomId = crypto.randomUUID();
const longRoomId = crypto.randomUUID();
const longTableId = crypto.randomUUID();
const longRoomName = "Sala sintetica T04 " + "S".repeat(61);
const longTableName = "T04 " + "T".repeat(36);
const headers = { origin };

interface Room {
  id: string; name: string; code: string; isActive: boolean; isAvailableForService: boolean | null;
  tables: Array<{ id: string; name: string; isActive: boolean }>;
}
interface Context {
  reservation: { version: number; status: "CONFIRMED" | "CANCELLED" };
  assignment: null | { id: string; room: { id: string; name: string }; tables: Array<{ id: string; name: string }>; internalNotes: string | null };
  rooms: Room[];
}
interface Ref { id: string; version: number }

function evidence(name: string, value: unknown) {
  const directory = process.env.T04_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
}

async function login(page: Page, role: "STAFF" | "ADMIN" = "STAFF") {
  await page.goto("/login");
  await page.getByLabel("Username").fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page.getByLabel("Password").fill((role === "ADMIN" ? process.env.AUTH_DEMO_ADMIN_PASSWORD : process.env.AUTH_DEMO_STAFF_PASSWORD) ?? "");
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
}

function payload(date: string, label: string, childrenCount: number | null = 0, gameRoomPreference: boolean | null = null) {
  return {
    localDate: date, serviceType: "DINNER", arrivalTime: "19:00", partySize: 4, childrenCount, gameRoomPreference,
    customerFirstName: e2eReservationFirstName, customerLastName: `T04 ${label} ${e2eRunId}`,
    customerPhone: "+390000004040", customerEmail: null,
    highChair: false, stroller: false, accessibility: false, celiac: false, allergies: null, intolerances: null,
    celebration: null, animals: false, notes: "Fixture sintetica T04", verbalConsentConfirmed: true,
    sendWhatsAppConfirmation: false, capacityOverride: false, capacityOverrideReason: null,
  };
}

async function create(request: APIRequestContext, data: ReturnType<typeof payload>): Promise<Ref> {
  const response = await request.post("/api/staff/reservations", { headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, data });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).reservation;
}

async function read(request: APIRequestContext, id: string): Promise<Context> {
  const response = await request.get(`/api/staff/reservations/${id}/assignment`);
  expect(response.status(), await response.text()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store, max-age=0");
  return response.json();
}

async function stored(id: string) {
  const result = await database.query("SELECT r.version,r.status,r.arrived_at,r.children_count,r.game_room_preference,r.preferences,r.allergies,a.id AS assignment_id,a.room_id,a.internal_notes,a.cleared_at FROM reservations r LEFT JOIN reservation_assignments a ON a.reservation_id=r.id AND a.restaurant_id=r.restaurant_id WHERE r.id=$1 AND r.restaurant_id=$2 AND r.customer_first_name=$3", [id, e2eRestaurantId, e2eReservationFirstName]);
  expect(result.rowCount).toBe(1);
  const links = await database.query("SELECT dining_table_id FROM reservation_assignment_tables WHERE restaurant_id=$1 AND assignment_id=$2 ORDER BY dining_table_id", [e2eRestaurantId, result.rows[0].assignment_id]);
  const audits = await database.query("SELECT action::text,actor_origin::text,new_state FROM reservation_audit_events WHERE restaurant_id=$1 AND reservation_id=$2 ORDER BY created_at,id", [e2eRestaurantId, id]);
  return { ...result.rows[0], tableIds: links.rows.map((row) => row.dining_table_id as string), actions: audits.rows.map((row) => row.action as string), audits: audits.rows };
}

function card(page: Page, id: string) { return page.locator(`article[data-reservation-id="${id}"]`); }

async function open(page: Page, id: string) {
  await card(page, id).getByRole("button", { name: /^(?:Assegna sala|Gestisci assegnazione|Vedi assegnazione storica)$/u }).click();
  const dialog = page.getByTestId("assignment-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Caricamento dello stato corrente…")).toBeHidden();
  return dialog;
}

async function save(page: Page, dialog: Locator, id: string, expected: { version: number; roomId: string; tableIds: string[]; internalNotes: string | null }) {
  const responsePromise = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/reservations/${id}/assignment`));
  await dialog.getByTestId("assignment-save").click();
  const response = await responsePromise;
  expect(response.request().postDataJSON()).toEqual(expected);
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ changed: true, reservationVersion: expected.version + 1, assignment: { room: { id: expected.roomId } } });
  expect(body.assignment.tables.map((table: { id: string }) => table.id).sort()).toEqual(expected.tableIds);
  await expect(dialog).toBeHidden();
  const db = await stored(id);
  expect(db).toMatchObject({ version: expected.version + 1, room_id: expected.roomId, tableIds: expected.tableIds, internal_notes: expected.internalNotes, cleared_at: null });
  return db;
}

async function cancel(request: APIRequestContext, id: string) {
  const current = await stored(id);
  if (current.status === "CANCELLED") return;
  const response = await request.delete(`/api/staff/reservations/${id}`, { headers, data: { version: current.version } });
  expect(response.status(), await response.text()).toBe(200);
}

async function noOverflow(page: Page, dialog: Locator) {
  const metrics = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, activeElement: document.activeElement?.tagName }));
  if (metrics.document > metrics.width || metrics.body > metrics.width) {
    evidence("overflow-diagnostic", await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")].map((node) => { const rect = node.getBoundingClientRect(); return { tag: node.tagName, className: typeof node.className === "string" ? node.className : "", role: node.getAttribute("role"), testId: node.getAttribute("data-testid"), width: rect.width, right: rect.right, inDialog: !!node.closest('[role="dialog"]') }; }).filter((node) => node.right > innerWidth + 1 && node.width > 0)));
  }
  expect(metrics.document).toBeLessThanOrEqual(metrics.width);
  expect(metrics.body).toBeLessThanOrEqual(metrics.width);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  return metrics;
}

async function textContrast(button: Locator) {
  const metrics = await button.evaluate((node) => {
    const style = getComputedStyle(node);
    function rgba(value: string) {
      const context = document.createElement("canvas").getContext("2d")!;
      context.fillStyle = value; context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    }
    function luminance(color: number[]) {
      const linear = color.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    }
    const foreground = rgba(style.color), background = rgba(style.backgroundColor);
    const first = luminance(foreground), second = luminance(background);
    return { foreground, background, ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) };
  });
  expect([metrics.foreground[3], metrics.background[3]]).toEqual([255, 255]);
  expect(metrics.ratio).toBeGreaterThanOrEqual(4.5);
  return metrics;
}

test.beforeAll(async () => {
  // Exclusive run tenant on the temporary schema15 database; no persistent/catalog edits.
  for (const [id, name, code] of [[emptyRoomId, "Sala sintetica T04 senza tavoli", `t04-empty-${e2eRunId}`], [longRoomId, longRoomName, `t04-long-${e2eRunId}`]]) {
    await database.query("INSERT INTO rooms(id,restaurant_id,name,code,display_order,is_active,updated_at) VALUES($1,$2,$3,$4,99,true,NOW())", [id, e2eRestaurantId, name, code]);
  }
  await database.query("INSERT INTO dining_tables(id,room_id,name,minimum_seats,maximum_seats,is_active,updated_at) VALUES($1,$2,$3,1,2,true,NOW())", [longTableId, longRoomId, longTableName]);
  // Match canonical catalog creation: existing owned service instances need both new room rows.
  await database.query("INSERT INTO service_room_availability(id,restaurant_id,service_instance_id,room_id,is_available,updated_at) SELECT gen_random_uuid(),s.restaurant_id,s.id,r.id,true,NOW() FROM service_instances s CROSS JOIN rooms r WHERE s.restaurant_id=$1 AND r.restaurant_id=$1 AND r.id=ANY($2::uuid[]) ON CONFLICT(service_instance_id,room_id) DO NOTHING", [e2eRestaurantId, [emptyRoomId, longRoomId]]);
});
test.afterAll(async () => {
  try {
    // Remove only this suite's exact synthetic catalog/assignment fixtures before canonical run purge.
    await database.query("DELETE FROM reservation_assignment_tables t USING reservation_assignments a,reservations r WHERE t.assignment_id=a.id AND a.reservation_id=r.id AND a.restaurant_id=$1 AND r.customer_first_name=$2 AND a.room_id=ANY($3::uuid[])", [e2eRestaurantId, e2eReservationFirstName, [emptyRoomId, longRoomId]]);
    await database.query("DELETE FROM reservation_assignments a USING reservations r WHERE a.reservation_id=r.id AND a.restaurant_id=$1 AND r.customer_first_name=$2 AND a.room_id=ANY($3::uuid[])", [e2eRestaurantId, e2eReservationFirstName, [emptyRoomId, longRoomId]]);
    await database.query("DELETE FROM dining_tables WHERE id=$1 AND room_id=$2", [longTableId, longRoomId]);
    await database.query("DELETE FROM service_room_availability WHERE restaurant_id=$1 AND room_id=ANY($2::uuid[])", [e2eRestaurantId, [emptyRoomId, longRoomId]]);
    await database.query("DELETE FROM rooms WHERE restaurant_id=$1 AND id=ANY($2::uuid[]) AND code=ANY($3::text[])", [e2eRestaurantId, [emptyRoomId, longRoomId], [`t04-empty-${e2eRunId}`, `t04-long-${e2eRunId}`]]);
  } finally { await database.end(); }
});

test.describe.serial("T04 Revised room-only assignment", () => {
  test("room-only without configured tables persists neutral Agenda, filters and partition summary", async ({ page }) => {
    const date = "2099-11-04";
    await login(page);
    const ref = await create(page.request, payload(date, "Empty room"));
    try {
      await page.goto(`/dashboard?date=${date}&service=DINNER`);
      const row = card(page, ref.id);
      await expect(row.getByTestId("unassigned-badge")).toHaveText("DA ASSEGNARE");
      await expect(row.getByTestId("assigned-table-names")).toHaveText("—");
      const dialog = await open(page, ref.id);
      await expect(dialog.getByText("Preferenza storica di sala", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Non specificata", { exact: true })).toBeVisible();
      await dialog.getByTestId("assignment-room-select").selectOption(emptyRoomId);
      await expect(dialog.getByText("Nessun tavolo configurato. Puoi salvare la sala senza tavoli.")).toBeVisible();
      await expect(dialog.getByRole("group", { name: "Tavoli · opzionale (0/20)" })).toBeVisible();
      const db = await save(page, dialog, ref.id, { version: 1, roomId: emptyRoomId, tableIds: [], internalNotes: null });
      expect(db.actions.filter((action: string) => action === "ASSIGNED")).toHaveLength(1);
      await expect(row.getByTestId("final-room-name")).toHaveText("Sala sintetica T04 senza tavoli");
      await expect(row.getByTestId("assigned-table-names")).toHaveText("DA ASSEGNARE");
      await expect(row.getByTestId("unassigned-badge")).toHaveCount(0);
      await expect(page.locator('[data-summary-label="Assegnate"] dd')).toHaveText("1");
      await expect(page.locator('[data-summary-label="Da assegnare"] dd')).toHaveText("0");
      await expect(page.getByTestId("final-room-covers")).toContainText("Sala sintetica T04 senza tavoli: 4");
      await page.reload();
      expect((await read(page.request, ref.id)).assignment?.tables).toEqual([]);
      await expect(card(page, ref.id).getByTestId("assigned-table-names")).toHaveText("DA ASSEGNARE");
      await page.getByTestId("final-room-filter").selectOption(`t04-empty-${e2eRunId}`);
      await page.getByRole("button", { name: "Applica filtri" }).click();
      await expect(card(page, ref.id)).toBeVisible();
      await page.getByTestId("assignment-status-filter").selectOption("UNASSIGNED");
      await page.getByRole("button", { name: "Applica filtri" }).click();
      await expect(card(page, ref.id)).toHaveCount(0);
      evidence("room-only-empty", { requestVersion: 1, responseVersion: db.version, junctionCount: db.tableIds.length, actions: db.actions });
    } finally { await cancel(page.request, ref.id); }
  });

  test("panel transitions preserve loaded tables/notes, explicit room reset, separate DELETE and same-entity reactivation", async ({ page }) => {
    const date = "2099-11-05";
    await login(page);
    const ref = await create(page.request, payload(date, "Transitions"));
    try {
      await page.goto(`/dashboard?date=${date}&service=DINNER`);
      const context = await read(page.request, ref.id);
      const room = context.rooms.find((candidate) => candidate.id !== longRoomId && candidate.isActive && candidate.isAvailableForService !== false && candidate.tables.some((table) => table.isActive))!;
      expect(room).toBeTruthy();
      const table = room.tables.find((candidate) => candidate.isActive)!;
      const note = "Nota sintetica T04 da conservare";
      let dialog = await open(page, ref.id);
      await dialog.getByTestId("assignment-room-select").selectOption(room.id);
      await dialog.getByTestId("assignment-internal-notes").fill(note);
      const first = await save(page, dialog, ref.id, { version: 1, roomId: room.id, tableIds: [], internalNotes: note });
      dialog = await open(page, ref.id);
      await dialog.locator("label").filter({ hasText: table.name }).getByRole("checkbox").check();
      await save(page, dialog, ref.id, { version: 2, roomId: room.id, tableIds: [table.id], internalNotes: note });
      const beforeOpen = await stored(ref.id);
      dialog = await open(page, ref.id);
      await expect(dialog.locator("label").filter({ hasText: table.name }).getByRole("checkbox")).toBeChecked();
      await expect(dialog.getByTestId("assignment-internal-notes")).toHaveValue(note);
      expect(await stored(ref.id)).toEqual(beforeOpen);
      await dialog.getByRole("button", { name: "Rimuovi tutti i tavoli", exact: true }).click();
      expect((await stored(ref.id)).tableIds).toEqual([table.id]);
      await save(page, dialog, ref.id, { version: 3, roomId: room.id, tableIds: [], internalNotes: note });
      dialog = await open(page, ref.id);
      await dialog.locator("label").filter({ hasText: table.name }).getByRole("checkbox").check();
      await save(page, dialog, ref.id, { version: 4, roomId: room.id, tableIds: [table.id], internalNotes: note });
      dialog = await open(page, ref.id);
      await dialog.getByTestId("assignment-room-select").selectOption(emptyRoomId);
      await expect(dialog.getByText(/Sala cambiata: la selezione tavoli è stata azzerata/u)).toBeVisible();
      await expect(dialog.getByTestId("assignment-internal-notes")).toHaveValue(note);
      await save(page, dialog, ref.id, { version: 5, roomId: emptyRoomId, tableIds: [], internalNotes: note });
      dialog = await open(page, ref.id);
      await dialog.getByRole("button", { name: "Rimuovi assegnazione", exact: true }).click();
      const responsePromise = page.waitForResponse((response) => response.request().method() === "DELETE" && response.url().endsWith(`/reservations/${ref.id}/assignment`));
      await dialog.getByTestId("assignment-clear-confirm").click();
      const response = await responsePromise;
      expect(response.request().postDataJSON()).toEqual({ version: 6 });
      expect(await response.json()).toEqual({ changed: true, reservationVersion: 7, assignment: null });
      await expect(dialog).toBeHidden();
      const cleared = await stored(ref.id);
      expect(cleared.cleared_at).not.toBeNull();
      expect(cleared.assignment_id).toBe(first.assignment_id);
      await expect(card(page, ref.id).getByTestId("unassigned-badge")).toBeVisible();
      dialog = await open(page, ref.id);
      await dialog.getByTestId("assignment-room-select").selectOption(emptyRoomId);
      const reactivated = await save(page, dialog, ref.id, { version: 7, roomId: emptyRoomId, tableIds: [], internalNotes: null });
      expect(reactivated.assignment_id).toBe(first.assignment_id);
      expect(reactivated.actions.filter((action: string) => action === "ASSIGNED")).toHaveLength(2);
      expect(reactivated.actions.filter((action: string) => action === "REASSIGNED")).toHaveLength(4);
      expect(reactivated.actions.filter((action: string) => action === "UNASSIGNED")).toHaveLength(1);
      evidence("transitions", { finalVersion: reactivated.version, sameEntity: reactivated.assignment_id === first.assignment_id, junctionCount: reactivated.tableIds.length, actions: reactivated.actions });
    } finally { await cancel(page.request, ref.id); }
  });

  test("Foundation composition/games and T03 arrival remain independent; Admin reads cancelled room-only history", async ({ page, browser }) => {
    const date = "2099-11-06";
    await login(page);
    const ref = await create(page.request, payload(date, "Foundation", 2, true));
    const unknown = await create(page.request, payload(date, "Unknown", null, null));
    try {
      const arrival = await page.request.put(`/api/staff/reservations/${ref.id}/arrival`, { headers, data: { version: 1, arrived: true } });
      expect(arrival.status()).toBe(200);
      const before = await stored(ref.id);
      await page.goto(`/dashboard?date=${date}&service=DINNER`);
      const row = card(page, ref.id);
      await expect(row).toContainText("4 coperti · 2 bambini");
      await expect(row.getByText("SALA GIOCHI RICHIESTA", { exact: true })).toBeVisible();
      await expect(row.getByTestId("arrival-state")).toHaveText("ARRIVATO");
      await expect(card(page, unknown.id)).toContainText("4 coperti · composizione non specificata");
      const dialog = await open(page, ref.id);
      await dialog.getByTestId("assignment-room-select").selectOption(emptyRoomId);
      await dialog.getByTestId("assignment-internal-notes").fill("Storia T04 sintetica");
      const after = await save(page, dialog, ref.id, { version: 2, roomId: emptyRoomId, tableIds: [], internalNotes: "Storia T04 sintetica" });
      expect(after).toMatchObject({ children_count: 2, game_room_preference: true, arrived_at: before.arrived_at, preferences: before.preferences, allergies: before.allergies });
      await expect(row.getByText("SALA GIOCHI RICHIESTA", { exact: true })).toBeVisible();
      await expect(row.getByTestId("arrival-state")).toHaveText("ARRIVATO");
      await cancel(page.request, ref.id);
      const adminContext = await browser.newContext({ baseURL: origin });
      try {
        const admin = await adminContext.newPage();
        await login(admin, "ADMIN");
        await admin.goto(`/dashboard?date=${date}&service=DINNER&status=ALL`);
        const history = await open(admin, ref.id);
        await expect(history.getByText("Cancellata · assegnazione solo storica")).toBeVisible();
        await expect(history.getByText("Tavoli: DA ASSEGNARE", { exact: true })).toBeVisible();
        await expect(history).toContainText("Storia T04 sintetica");
        await expect(history.getByTestId("assignment-save")).toHaveCount(0);
        await expect(history.getByRole("button", { name: "Rimuovi assegnazione", exact: true })).toHaveCount(0);
        for (const method of ["put", "delete"] as const) {
          const response = await admin.request[method](`/api/staff/reservations/${ref.id}/assignment`, { headers, data: method === "put" ? { version: 4, roomId: emptyRoomId, tableIds: [], internalNotes: "Storia T04 sintetica" } : { version: 4 } });
          expect(response.status()).toBe(409);
          expect(await response.json()).toMatchObject({ code: "RESERVATION_CANCELLED" });
        }
        expect((await stored(ref.id)).assignment_id).toBe(after.assignment_id);
        evidence("foundation-arrival-cancelled", { composition: [after.children_count, after.game_room_preference], arrivalPreserved: String(after.arrived_at) === String(before.arrived_at), historyRetained: true, cancelledVersion: (await stored(ref.id)).version });
      } finally { await adminContext.close(); }
    } finally { await cancel(page.request, ref.id); await cancel(page.request, unknown.id); }
  });

  test("authentic Staff PATCH conflict requires explicit GET refresh and server version; double submit emits one PUT", async ({ page }) => {
    const date = "2099-11-07";
    await login(page);
    const data = payload(date, "Conflict");
    const ref = await create(page.request, data);
    try {
      await page.goto(`/dashboard?date=${date}&service=DINNER`);
      const dialog = await open(page, ref.id);
      await dialog.getByTestId("assignment-room-select").selectOption(emptyRoomId);
      await dialog.getByTestId("assignment-internal-notes").fill("Scelta locale T04");
      const { verbalConsentConfirmed: _consent, sendWhatsAppConfirmation: _notification, ...editable } = data;
      void _consent; void _notification;
      const concurrent = await page.request.patch(`/api/staff/reservations/${ref.id}`, { headers, data: { ...editable, version: 1, childrenCount: 2, gameRoomPreference: true, notes: "Aggiornamento concorrente reale" } });
      expect(concurrent.status(), await concurrent.text()).toBe(200);
      expect((await stored(ref.id)).version).toBe(2);
      let puts = 0;
      let gets = 0;
      const bodies: unknown[] = [];
      page.on("request", (request) => { if (request.url().endsWith(`/reservations/${ref.id}/assignment`)) { if (request.method() === "PUT") { puts++; bodies.push(request.postDataJSON()); } if (request.method() === "GET") gets++; } });
      const conflictPromise = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/reservations/${ref.id}/assignment`));
      await dialog.getByTestId("assignment-save").click();
      const conflict = await conflictPromise;
      expect(conflict.status()).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: "VERSION_CONFLICT" });
      const alert = dialog.getByRole("alert");
      await expect(alert).toBeFocused();
      await expect(dialog).toHaveAttribute("aria-describedby", await alert.getAttribute("id") ?? "");
      await expect(dialog.getByTestId("assignment-save")).toBeDisabled();
      await expect(dialog.getByTestId("assignment-internal-notes")).toHaveValue("Scelta locale T04");
      expect((await stored(ref.id)).assignment_id).toBeNull();
      expect(puts).toBe(1); expect(gets).toBe(0);
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      const reloadPromise = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(`/reservations/${ref.id}/assignment`));
      await dialog.getByTestId("assignment-reload-conflict").click();
      expect((await (await reloadPromise).json()).reservation.version).toBe(2);
      await expect(dialog.getByTestId("assignment-room-select")).toHaveValue("");
      await dialog.getByTestId("assignment-room-select").selectOption(emptyRoomId);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route(`**/api/staff/reservations/${ref.id}/assignment`, async (route) => { if (route.request().method() === "PUT") { await gate; } await route.continue(); });
      const successPromise = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/reservations/${ref.id}/assignment`));
      await dialog.getByTestId("assignment-save").evaluate((node) => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
      await expect(dialog).toHaveAttribute("aria-busy", "true");
      await expect(dialog.getByTestId("assignment-save")).toBeDisabled();
      await expect.poll(() => puts).toBe(2);
      expect((await stored(ref.id)).version).toBe(2);
      release();
      const success = await successPromise;
      expect(success.status()).toBe(200);
      expect(success.request().postDataJSON()).toEqual({ version: 2, roomId: emptyRoomId, tableIds: [], internalNotes: null });
      expect(await success.json()).toMatchObject({ reservationVersion: 3, changed: true });
      await expect(dialog).toBeHidden();
      expect(puts).toBe(2); expect(gets).toBe(1);
      const db = await stored(ref.id);
      expect(db).toMatchObject({ version: 3, children_count: 2, game_room_preference: true, tableIds: [] });
      expect(db.actions.filter((action: string) => action === "ASSIGNED")).toHaveLength(1);
      evidence("conflict-double-submit", { staleStatus: 409, requestBodies: bodies, putCount: puts, explicitGetCount: gets, finalVersion: db.version, assignmentAuditCount: db.actions.filter((action: string) => action === "ASSIGNED").length });
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await cancel(page.request, ref.id); }
  });

  test("keyboard focus, long content, five viewports and declared 200% equivalent reflow survive network failure", async ({ page }) => {
    const date = "2099-11-08";
    await login(page);
    const ref = await create(page.request, payload(date, "Responsive"));
    const note = "Nota sintetica lunga T04 città\n".padEnd(1000, "N");
    try {
      await page.goto(`/dashboard?date=${date}&service=DINNER`);
      const trigger = card(page, ref.id).getByRole("button", { name: "Assegna sala", exact: true });
      await trigger.focus(); await page.keyboard.press("Enter");
      let dialog = page.getByTestId("assignment-dialog");
      await expect(dialog.getByText("Caricamento dello stato corrente…")).toBeHidden();
      await expect(dialog.getByRole("button", { name: "Chiudi gestione assegnazione" })).toBeFocused();
      await dialog.getByTestId("assignment-room-select").selectOption(longRoomId);
      const checkbox = dialog.getByRole("checkbox", { name: new RegExp(longTableName, "u") });
      await checkbox.focus(); await page.keyboard.press("Space"); await expect(checkbox).toBeChecked();
      await dialog.getByTestId("assignment-internal-notes").fill(note);
      const metrics = [];
      for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 640, height: 360 }]) {
        await page.setViewportSize(viewport);
        const saveButton = dialog.getByTestId("assignment-save");
        await page.mouse.move(0, 0);
        const normalContrast = await textContrast(saveButton);
        await saveButton.hover();
        const hoverContrast = await textContrast(saveButton);
        await page.mouse.move(0, 0);
        metrics.push({ viewport, ...(await noOverflow(page, dialog)), contrast: { normal: normalContrast, hover: hoverContrast }, reflow: viewport.width === 640 ? "200% equivalent: 1280x720 CSS viewport reduced to 640x360; not browser zoom" : null });
        if (process.env.T04_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.T04_EVIDENCE_DIR, `t04-dialog-${viewport.width}x${viewport.height}.png`) });
        await expect(dialog.getByTestId("assignment-internal-notes")).toHaveValue(note);
        const targets = await dialog.locator("button:not(:disabled),select").evaluateAll((nodes) => nodes.map((node) => ({ tag: node.tagName, height: node.getBoundingClientRect().height, width: node.getBoundingClientRect().width })));
        expect(targets.every((target) => target.height >= 44 && target.width >= 44)).toBe(true);
      }
      await dialog.getByTestId("assignment-save").focus(); await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Chiudi gestione assegnazione" })).toBeFocused();
      await page.keyboard.press("Shift+Tab"); await expect(dialog.getByTestId("assignment-save")).toBeFocused();
      await page.route(`**/api/staff/reservations/${ref.id}/assignment`, async (route) => { if (route.request().method() === "PUT") await route.abort("failed"); else await route.continue(); });
      await dialog.getByTestId("assignment-save").click();
      const error = dialog.getByRole("alert");
      await expect(error).toContainText("Errore di rete. La scelta non è stata salvata.");
      await expect(error).toBeFocused();
      await expect(dialog).toHaveAttribute("aria-describedby", await error.getAttribute("id") ?? "");
      await expect(dialog).toHaveAttribute("aria-busy", "false");
      expect((await stored(ref.id)).version).toBe(1);
      expect((await stored(ref.id)).assignment_id).toBeNull();
      for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 640, height: 360 }]) { await page.setViewportSize(viewport); await noOverflow(page, dialog); }
      await page.keyboard.press("Escape"); await expect(dialog).toBeHidden(); await expect(trigger).toBeFocused();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      dialog = await open(page, ref.id);
      await dialog.getByTestId("assignment-room-select").selectOption(longRoomId);
      await dialog.getByRole("checkbox", { name: new RegExp(longTableName, "u") }).check();
      await dialog.getByTestId("assignment-internal-notes").fill(note);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route(`**/api/staff/reservations/${ref.id}/assignment`, async (route) => { if (route.request().method() === "PUT") await gate; await route.continue(); });
      const responsePromise = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/reservations/${ref.id}/assignment`));
      await dialog.getByTestId("assignment-save").click(); await expect(dialog).toHaveAttribute("aria-busy", "true");
      for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 640, height: 360 }]) { await page.setViewportSize(viewport); await noOverflow(page, dialog); }
      release();
      const response = await responsePromise;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toEqual({ version: 1, roomId: longRoomId, tableIds: [longTableId], internalNotes: note });
      await expect(dialog).toBeHidden();
      await expect(card(page, ref.id).getByRole("status").filter({ hasText: "Assegnazione salvata." })).toBeVisible();
      await expect(card(page, ref.id).getByTestId("final-room-name")).toHaveText(longRoomName);
      const db = await stored(ref.id); expect(db).toMatchObject({ version: 2, tableIds: [longTableId], internal_notes: note });
      await cancel(page.request, ref.id);
      await page.goto(`/dashboard?date=${date}&service=DINNER&status=ALL`);
      const history = await open(page, ref.id);
      await expect(history).toContainText(longRoomName);
      await expect(history).toContainText(longTableName);
      expect(await history.locator("p").filter({ hasText: "Note interne:" }).innerText()).toContain(note);
      await expect(history.getByTestId("assignment-save")).toHaveCount(0);
      for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 640, height: 360 }]) { await page.setViewportSize(viewport); await noOverflow(page, history); }
      if (process.env.T04_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.T04_EVIDENCE_DIR, "t04-cancelled-long-history-reflow.png") });
      evidence("responsive-keyboard", { metrics, longRoomCodePoints: [...longRoomName].length, longTableCodePoints: [...longTableName].length, notesCodePoints: [...note].length, failureFocus: "associated role=alert", cancelledLongHistoryUntruncated: true, target: "WCAG 2.2 AA engineering checks; no formal certification", finalVersion: db.version, cancelledVersion: (await stored(ref.id)).version });
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await cancel(page.request, ref.id); }
  });
});
