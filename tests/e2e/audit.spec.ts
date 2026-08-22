import "dotenv/config";

import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  e2eAdminUsername,
  e2eAuditMustChangeUsername,
  e2eReservationFirstName,
  e2eRestaurantId,
  e2eStaffUsername,
} from "./e2e-run";

const origin = "http://localhost:4000";
const adminPassword = process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "";
const staffPassword = process.env.AUTH_DEMO_STAFF_PASSWORD ?? "";
const databaseUrl = process.env.DATABASE_URL;
const foreignEventId = randomUUID();
const sensitivePhone = "+390000009876";
const sensitiveEmail = "M9F.Audit+Secret@example.test";

if (!databaseUrl) throw new Error("DATABASE_URL is required for M9-F E2E checks.");

const database = new Pool({ connectionString: databaseUrl });

interface AuditItem {
  source: "RESERVATION" | "ADMINISTRATIVE";
  eventId: string;
  occurredAt: string;
  category: string;
  action: string;
  outcome: string;
  actorKind: string;
  actorUserId?: string;
  correlationId: string;
}

interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
}

interface PublicConfiguration {
  contacts: {
    publicPhone: string;
    publicBookingBaseUrl: string;
    publicEmail: string | null;
    whatsappNumber: string | null;
  };
  fingerprints: { contacts: string };
}

let reservationEvent: AuditItem;
let administrativeEvent: AuditItem;
let legacyReservationEventId: string;
let outsideFilterEventId: string;

async function login(page: Page, username: string, password: string, destination = /\/dashboard/) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(destination);
}

async function readAudit(request: APIRequestContext, query = "limit=100"): Promise<AuditPage> {
  const response = await request.get(`/api/admin/audit?${query}`);
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
  return response.json() as Promise<AuditPage>;
}

async function readConfiguration(request: APIRequestContext): Promise<PublicConfiguration> {
  const response = await request.get("/api/admin/public-settings");
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).configuration as PublicConfiguration;
}

async function collectAuditIds(
  request: APIRequestContext,
  limit: number,
  filters: Record<string, string> = {},
): Promise<string[]> {
  const collected: string[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ ...filters, limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    const result = await readAudit(request, params.toString());
    collected.push(...result.items.map((item) => item.eventId));
    cursor = result.nextCursor;
  } while (cursor);
  return collected;
}

function localToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function changeContacts(request: APIRequestContext, configuration: PublicConfiguration, contacts: PublicConfiguration["contacts"]) {
  const response = await request.post("/api/admin/public-settings/contacts", {
    headers: { origin },
    data: { fingerprint: configuration.fingerprints.contacts, contacts },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function createPublicReservation(request: APIRequestContext) {
  const response = await request.post("/api/public/reservations", {
    headers: { origin, "Idempotency-Key": crypto.randomUUID() },
    data: {
      localDate: "2099-12-20",
      serviceType: "DINNER",
      arrivalTime: "19:00",
      partySize: 2,
      roomCode: "sala-1",
      customerFirstName: e2eReservationFirstName,
      customerLastName: "M9-F Fixture",
      customerPhone: "+390000000002",
      customerEmail: null,
      highChair: false,
      stroller: false,
      accessibility: false,
      children: false,
      celiac: false,
      allergies: null,
      intolerances: null,
      celebration: null,
      animals: false,
      notes: "Fixture fittizia M9-F",
      language: "it",
      privacyAccepted: true,
      termsAccepted: true,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const result = await database.query<{ id: string }>(
    `SELECT id::text
       FROM reservations
      WHERE restaurant_id = $1::uuid
        AND customer_first_name = $2
        AND customer_last_name = 'M9-F Fixture'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [e2eRestaurantId, e2eReservationFirstName],
  );
  expect(result.rows[0]?.id).toBeTruthy();
  return result.rows[0]!.id;
}

async function auditDatabaseSnapshot() {
  const result = await database.query<{
    reservation_audit_count: string;
    audit_count: string;
    audit_fingerprint: string | null;
    reservation_count: string;
    user_count: string;
    room_count: string;
  }>(`
    SELECT
      (SELECT count(*)::text FROM reservation_audit_events) AS reservation_audit_count,
      (SELECT count(*)::text FROM audit_events) AS audit_count,
      (SELECT md5(string_agg(id::text || created_at::text, ',' ORDER BY id)) FROM audit_events) AS audit_fingerprint,
      (SELECT count(*)::text FROM reservations) AS reservation_count,
      (SELECT count(*)::text FROM users) AS user_count,
      (SELECT count(*)::text FROM rooms) AS room_count
  `);
  return result.rows[0];
}

async function newPage(context: BrowserContext) {
  return context.newPage();
}

test.describe.serial("M9-F consultazione audit Admin", () => {
  test.beforeAll(async () => {
    await database.query(
      `INSERT INTO audit_events (
         id, restaurant_id, category, action, outcome, actor_user_id,
         actor_role, entity_type, entity_id, correlation_id,
         previous_state, new_state, metadata
       ) VALUES (
         $1::uuid, '00000000-0000-4000-8000-000000000001'::uuid,
         'AUTHENTICATION', 'LOGIN_SUCCEEDED', 'SUCCESS', NULL,
         NULL, NULL, NULL, $2::uuid, NULL, NULL,
         '{"decoy":"other tenant"}'::jsonb
       )`,
      [foreignEventId, randomUUID()],
    );
  });

  test.afterAll(async () => {
    await database.query("DELETE FROM audit_events WHERE id = $1::uuid", [
      foreignEventId,
    ]);
    await database.end();
  });

  test("Admin vede nello stesso elenco eventi prenotazione e amministrativi", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    const reservationId = await createPublicReservation(page.request);
    const original = await readConfiguration(page.request);
    await changeContacts(page.request, original, {
      ...original.contacts,
      publicPhone: sensitivePhone,
      publicEmail: sensitiveEmail,
    });
    try {
      reservationEvent = (await readAudit(page.request, "source=RESERVATION&action=CREATED&limit=100")).items[0];
      administrativeEvent = (await readAudit(page.request, "source=ADMINISTRATIVE&action=PUBLIC_CONTACTS_UPDATED&limit=100")).items[0];
      expect(reservationEvent?.source).toBe("RESERVATION");
      expect(administrativeEvent?.source).toBe("ADMINISTRATIVE");
      expect(administrativeEvent.actorUserId).toBeTruthy();

      legacyReservationEventId = randomUUID();
      outsideFilterEventId = randomUUID();
      await database.query(
        `INSERT INTO reservation_audit_events (
           id, restaurant_id, reservation_id, action, actor_origin,
           actor_user_id, actor_role, correlation_id, previous_state,
           new_state, capacity_override, capacity_override_reason
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'UPDATED', 'PUBLIC',
           NULL, NULL, $4::uuid,
           '{"schedule":{"localDate":"2099-12-19","serviceType":"DINNER","arrivalTime":"19:00"},"customerPhone":"+397777777777","rawRequest":"legacy-before"}'::jsonb,
           '{"schedule":{"localDate":"2099-12-20","serviceType":"DINNER","arrivalTime":"19:00"},"customerPhone":"+399999999999","internalNotes":"legacy secret","rawRequest":{"authorization":"Bearer forbidden"}}'::jsonb,
           false, NULL
         )`,
        [legacyReservationEventId, e2eRestaurantId, reservationId, randomUUID()],
      );
      await database.query(
        `INSERT INTO audit_events (
           id, restaurant_id, category, action, outcome, actor_user_id,
           actor_role, entity_type, entity_id, correlation_id,
           previous_state, new_state, metadata
         ) VALUES (
           $1::uuid, $2::uuid, 'AUTHENTICATION', 'LOGIN_SUCCEEDED',
           'SUCCESS', $3::uuid, 'ADMIN', NULL, NULL, $4::uuid,
           NULL, NULL,
           '{"customerPhone":"+398888888888","rawRequest":{"cookie":"forbidden"}}'::jsonb
         )`,
        [
          outsideFilterEventId,
          e2eRestaurantId,
          administrativeEvent.actorUserId,
          randomUUID(),
        ],
      );

      const response = await page.goto("/admin/audit");
      expect(response?.headers()["cache-control"]).toContain("no-store");
      expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
      await expect(page.getByText("Prenotazione creata").first()).toBeVisible();
      await expect(page.getByText("Contatti pubblici aggiornati").first()).toBeVisible();
    } finally {
      await changeContacts(page.request, await readConfiguration(page.request), original.contacts);
    }
  });

  test("ordinamento e paginazione keyset non producono duplicati o omissioni", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    const filters = { from: localToday(), to: localToday() };
    const expected = await collectAuditIds(page.request, 100, filters);
    const firstPage = await readAudit(
      page.request,
      new URLSearchParams({ ...filters, limit: "2" }).toString(),
    );
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await readAudit(
      page.request,
      new URLSearchParams({
        ...filters,
        limit: "2",
        cursor: firstPage.nextCursor!,
      }).toString(),
    );
    expect(secondPage.items.length).toBeGreaterThan(0);
    expect(
      secondPage.items.some((item) =>
        firstPage.items.some((first) => first.eventId === item.eventId),
      ),
    ).toBe(false);
    const collected = await collectAuditIds(page.request, 2, filters);
    expect(expected.length).toBeGreaterThan(2);
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toContain(legacyReservationEventId);
    expect(collected).toContain(outsideFilterEventId);
    expect(collected).not.toContain(foreignEventId);
    const ordered = (await readAudit(
      page.request,
      new URLSearchParams({ ...filters, limit: "100" }).toString(),
    )).items;
    for (let index = 1; index < ordered.length; index += 1) {
      expect(
        new Date(ordered[index - 1]!.occurredAt).getTime(),
      ).toBeGreaterThanOrEqual(new Date(ordered[index]!.occurredAt).getTime());
    }
  });

  test("filtri per periodo, categoria, azione e attore sono applicati dal server e dalla UI", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    const actorId = administrativeEvent.actorUserId;
    expect(actorId).toBeTruthy();
    const today = localToday();
    const result = await readAudit(
      page.request,
      new URLSearchParams({
        from: today,
        to: today,
        source: "ADMINISTRATIVE",
        category: "CONFIGURATION",
        action: "PUBLIC_CONTACTS_UPDATED",
        actor: actorId!,
        limit: "100",
      }).toString(),
    );
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((item) => item.category === "CONFIGURATION" && item.action === "PUBLIC_CONTACTS_UPDATED" && item.actorUserId === actorId)).toBe(true);
    expect(result.items.map((item) => item.eventId)).not.toContain(
      outsideFilterEventId,
    );

    await page.goto("/admin/audit");
    await page.getByLabel("Categoria", { exact: true }).selectOption("CONFIGURATION");
    await page.getByLabel("Azione", { exact: true }).selectOption("PUBLIC_CONTACTS_UPDATED");
    await page.getByLabel("Attore", { exact: true }).fill(actorId!);
    await page.getByRole("button", { name: "Applica filtri" }).click();
    await expect(page.getByText("Contatti pubblici aggiornati").first()).toBeVisible();
    await expect(page.locator("li[data-event-id]").first()).toContainText("CONFIGURATION");
  });

  test("dettaglio mostra prima/dopo minimizzati e non espone contatti sensibili", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    const response = await page.request.get(`/api/admin/audit/ADMINISTRATIVE/${administrativeEvent.eventId}`);
    const body = await response.text();
    expect(response.ok(), body).toBe(true);
    expect(body).not.toContain(sensitivePhone);
    expect(body).not.toContain(sensitiveEmail);

    const legacyResponse = await page.request.get(
      `/api/admin/audit/RESERVATION/${legacyReservationEventId}`,
    );
    const legacyBody = await legacyResponse.text();
    expect(legacyResponse.ok(), legacyBody).toBe(true);
    expect(legacyBody).not.toContain("+399999999999");
    expect(legacyBody).not.toContain("legacy secret");
    expect(legacyBody).not.toContain("Bearer forbidden");
    expect(legacyBody).not.toContain("rawRequest");

    await page.goto("/admin/audit");
    await page.getByLabel("Azione", { exact: true }).selectOption("PUBLIC_CONTACTS_UPDATED");
    await page.getByRole("button", { name: "Applica filtri" }).click();
    await page.locator(`li[data-event-id="${administrativeEvent.eventId}"]`).getByRole("button", { name: "Dettaglio" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Stato precedente");
    await expect(dialog).toContainText("Telefono configurato");
    await expect(dialog).not.toContainText(sensitivePhone);
    await expect(dialog).not.toContainText(sensitiveEmail);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("Staff, anonimo e utente con cambio obbligatorio sono respinti", async ({ page, browser }) => {
    await login(page, e2eAdminUsername, adminPassword);
    const username = e2eAuditMustChangeUsername;
    const creation = await page.request.post("/api/admin/users", {
      headers: { origin },
      data: { username, role: "STAFF" },
    });
    expect(creation.status()).toBe(201);
    const temporaryPassword = (await creation.json()).temporaryPassword as string;

    const anonymousContext = await browser.newContext();
    const staffContext = await browser.newContext();
    const mustChangeContext = await browser.newContext();
    try {
      const anonymous = await newPage(anonymousContext);
      expect((await anonymous.request.get("/api/admin/audit")).status()).toBe(401);
      await anonymous.goto("/admin/audit");
      await expect(anonymous).toHaveURL(/\/login\?returnTo=/);

      const staff = await newPage(staffContext);
      await login(staff, e2eStaffUsername, staffPassword);
      expect((await staff.request.get("/api/admin/audit")).status()).toBe(403);
      await staff.goto("/admin/audit");
      await expect(staff).toHaveURL(/\/dashboard\?access=denied/);

      const mustChange = await newPage(mustChangeContext);
      await login(mustChange, username, temporaryPassword, /\/cambia-password/);
      const blocked = await mustChange.request.get("/api/admin/audit");
      expect(blocked.status()).toBe(403);
      await expect(blocked.json()).resolves.toEqual({ error: "PASSWORD_CHANGE_REQUIRED" });
      await mustChange.goto("/admin/audit");
      await expect(mustChange).toHaveURL(/\/cambia-password/);
    } finally {
      await anonymousContext.close();
      await staffContext.close();
      await mustChangeContext.close();
    }
  });

  test("un ID evento non appartenente al tenant non è leggibile direttamente", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    const response = await page.request.get(`/api/admin/audit/ADMINISTRATIVE/${foreignEventId}`);
    expect(response.status()).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "NOT_FOUND" });
  });

  test("lista, filtri, paginazione, dettaglio e errori restano read-only", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    const before = await auditDatabaseSnapshot();
    await page.goto("/admin/audit");
    await expect(page.getByRole("heading", { name: "Eventi cronologici" })).toBeVisible();
    await page.getByLabel("Sorgente", { exact: true }).selectOption("RESERVATION");
    await page.getByRole("button", { name: "Applica filtri" }).click();
    await expect(page.getByText("Prenotazione creata").first()).toBeVisible();
    const pageOne = await readAudit(page.request, "limit=1");
    expect(pageOne.nextCursor).not.toBeNull();
    await readAudit(page.request, `limit=1&cursor=${encodeURIComponent(pageOne.nextCursor!)}`);
    await page.request.get(`/api/admin/audit/RESERVATION/${reservationEvent.eventId}`);
    expect((await page.request.get("/api/admin/audit?cursor=invalid***")).status()).toBe(400);
    expect(await auditDatabaseSnapshot()).toEqual(before);
  });

  test("interfaccia e dettaglio non hanno overflow a 390, 820 e 1440 px", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 820, height: 1_180 },
      { width: 1_440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/admin/audit");
      await expect(page.getByText("Prenotazione creata").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.locator(`li[data-event-id="${reservationEvent.eventId}"]`).getByRole("button", { name: "Dettaglio" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole("button", { name: "Chiudi" }).click();
    }
  });
});
