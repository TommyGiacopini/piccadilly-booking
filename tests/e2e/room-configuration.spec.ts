import "dotenv/config";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  e2eAdminUsername,
  e2eDiningTableName,
  e2eReservationFirstName,
  e2eRestaurantId,
  e2eStaffUsername,
} from "./e2e-run";

const origin = "http://localhost:4000";
const date = "2099-11-18";
const service = "DINNER";
const adminPassword = process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "";
const staffPassword = process.env.AUTH_DEMO_STAFF_PASSWORD ?? "";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required for M9-D E2E checks.");

const database = new Pool({ connectionString: databaseUrl });

async function serviceInstanceSnapshot() {
  const instances = await database.query<{
    id: string;
    version: number;
    local_date: string;
    service_type: string;
    created_at: string;
    updated_at: string;
  }>(`
    SELECT id::text, version, local_date::text, service_type::text,
           created_at::text, updated_at::text
    FROM service_instances
    WHERE restaurant_id = $1::uuid
    ORDER BY id
  `, [e2eRestaurantId]);
  const rooms = await database.query<{
    id: string;
    service_instance_id: string;
    room_id: string;
    is_available: boolean;
    created_at: string;
    updated_at: string;
  }>(`
    SELECT id::text, service_instance_id::text, room_id::text, is_available,
           created_at::text, updated_at::text
    FROM service_room_availability
    WHERE restaurant_id = $1::uuid
    ORDER BY id
  `, [e2eRestaurantId]);
  return {
    instances: instances.rows,
    rooms: rooms.rows,
  };
}

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

async function configuration(request: APIRequestContext) {
  const response = await request.get(`/api/admin/room-configuration?date=${date}&service=${service}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).configuration as {
    rooms: Array<{ id: string; code: string; displayOrder: number; isActive: boolean }>;
    service: { rooms: Array<{ id: string; configuredAvailable: boolean }> };
  };
}

async function preview(request: APIRequestContext, proposal: unknown) {
  const response = await request.post("/api/admin/room-configuration/preview", { headers: { origin }, data: proposal });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).preview as { fingerprint: string; changed: boolean; impact: { reservationCount: number } };
}

async function apply(request: APIRequestContext, proposal: unknown) {
  const current = await preview(request, proposal);
  if (!current.changed) return current;
  const response = await request.post("/api/admin/room-configuration/apply", { headers: { origin }, data: { proposal, fingerprint: current.fingerprint } });
  expect(response.ok(), await response.text()).toBe(true);
  return current;
}

test.describe.serial("M9-D sale e tavoli", () => {
  test.afterAll(async () => {
    await database.end();
  });

  test("Admin abilita separatamente Galleria e la disponibilità pubblica la riflette", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    const state = await configuration(page.request);
    const room = state.rooms.find((candidate) => candidate.code === "galleria");
    const terrace = state.rooms.find((candidate) => candidate.code === "terrazzo");
    expect(room).toBeTruthy();
    expect(terrace).toBeTruthy();
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: service, roomId: room?.id, isAvailable: true };
    const terraceProposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: service, roomId: terrace?.id, isAvailable: false };
    await apply(page.request, { ...proposal, isAvailable: false });
    await apply(page.request, terraceProposal);
    try {
      await page.goto(`/admin/rooms?date=${date}&service=${service}`);
      await expect(page.getByLabel("Data")).toHaveValue(date);
      await expect(page.getByLabel("Servizio")).toHaveValue(service);
      const roomSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Galleria", exact: true }) });
      await roomSection.getByRole("button", { name: "Rendi disponibile" }).click();
      await expect(page.getByRole("status")).toContainText("Configurazione salvata");
      const publicAvailability = await page.request.get(`/api/public/availability?date=${date}&service=${service}&partySize=2`);
      const rooms = (await publicAvailability.json()).rooms as Array<{ code: string; name: string }>;
      expect(rooms).toContainEqual({ code: "galleria", name: "Galleria" });
      expect(rooms.map((candidate) => candidate.code)).not.toContain("terrazzo");
    } finally {
      await apply(page.request, { ...proposal, isAvailable: false });
      await apply(page.request, terraceProposal);
    }
  });

  test("sala non disponibile scompare per pubblico e Staff senza mutare la prenotazione", async ({ page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    const state = await configuration(page.request);
    const room = state.rooms.find((candidate) => candidate.code === "sala-1");
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: service, roomId: room?.id, isAvailable: false };
    await apply(page.request, { ...proposal, isAvailable: true });
    let reservation: { id: string; status: string; version: number } | undefined;
    try {
      const created = await page.request.post("/api/staff/reservations", { headers: { origin, "Idempotency-Key": crypto.randomUUID() }, data: { localDate: date, serviceType: service, arrivalTime: "19:00", partySize: 2, roomCode: "sala-1", customerFirstName: e2eReservationFirstName, customerLastName: "Room", customerPhone: "+39000000000", customerEmail: null, highChair: false, stroller: false, accessibility: false, children: false, celiac: false, allergies: null, intolerances: null, celebration: null, animals: false, notes: null, verbalConsentConfirmed: true, capacityOverride: false, capacityOverrideReason: null } });
      expect(created.ok(), await created.text()).toBe(true);
      reservation = (await created.json()).reservation as { id: string; status: string; version: number };
      const impact = await apply(page.request, proposal);
      expect(impact.impact.reservationCount).toBeGreaterThan(0);
      for (const path of ["/api/public/availability", "/api/staff/availability"]) {
        const response = await page.request.get(`${path}?date=${date}&service=${service}&partySize=2`);
        expect((await response.json()).rooms.map((candidate: { code: string }) => candidate.code)).not.toContain("sala-1");
      }
      await expect((await page.request.get(`/api/staff/reservations/${reservation.id}`)).json()).resolves.toMatchObject({ reservation: { id: reservation.id, status: "CONFIRMED", version: reservation.version } });
    } finally {
      await apply(page.request, { ...proposal, isAvailable: true });
      if (reservation) {
        const cancelled = await page.request.delete(`/api/staff/reservations/${reservation.id}`, { headers: { origin }, data: { version: reservation.version } });
        expect(cancelled.ok(), await cancelled.text()).toBe(true);
      }
    }
  });

  test("Admin preserva lifecycle sala, gestisce un tavolo e una preview concorrente diventa obsoleta", async ({ page }) => {
    test.setTimeout(60_000);
    await login(page, e2eAdminUsername, adminPassword);
    const state = await configuration(page.request);
    const room = state.rooms.find((candidate) => candidate.code === "sala-2")!;
    const availabilityProposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: service, roomId: room.id, isAvailable: false };
    const disable = { kind: "ROOM_CATALOG", roomId: room.id, displayOrder: room.displayOrder, isActive: false };
    await apply(page.request, { ...disable, isActive: true });
    await apply(page.request, { ...availabilityProposal, isAvailable: true });
    try {
      const stale = await preview(page.request, availabilityProposal);
      await apply(page.request, disable);
      const staleResponse = await page.request.post("/api/admin/room-configuration/apply", { headers: { origin }, data: { proposal: availabilityProposal, fingerprint: stale.fingerprint } });
      expect(staleResponse.status()).toBe(409);
      await page.goto(`/admin/rooms?date=${date}&service=${service}`);
      const roomSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Sala 2", exact: true }) });
      await expect(roomSection.getByLabel("Sala attiva globalmente")).not.toBeChecked();
      await apply(page.request, { ...disable, isActive: true });
      await page.reload();
      await expect(roomSection.getByLabel("Sala attiva globalmente")).toBeChecked();
    } finally {
      await apply(page.request, { ...disable, isActive: true });
      await apply(page.request, { ...availabilityProposal, isAvailable: true });
    }

    const tableName = e2eDiningTableName;
    await page.goto(`/admin/rooms?date=${date}&service=${service}`);
    const roomSection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Sala 2", exact: true }) });
    await roomSection.getByLabel("Nuovo tavolo").fill(tableName);
    const createForm = roomSection.locator('form:has(button:has-text("Aggiungi"))');
    await createForm.getByLabel("Min").fill("2");
    await createForm.getByLabel("Max").fill("4");
    await createForm.getByLabel("Ordine").fill("99");
    await createForm.getByRole("button", { name: "Aggiungi" }).click();
    await expect(page.getByRole("status")).toContainText("Tavolo salvato");
    const tableInput = roomSection.locator(`input[value="${tableName}"]`);
    await expect(tableInput).toBeVisible();
    const updateForm = roomSection.locator(`form:has(input[value="${tableName}"])`);
    await updateForm.getByLabel("Max").fill("6");
    await updateForm.getByLabel("Attivo").uncheck();
    await updateForm.getByRole("button", { name: "Salva" }).click();
    await expect(page.getByRole("status")).toContainText("Configurazione salvata");
    await expect(updateForm.getByLabel("Attivo")).not.toBeChecked();
  });

  test("Staff e anonimo sono respinti e la UI non deborda a 390, 820 e 1440 px", async ({ browser, page }) => {
    await login(page, e2eAdminUsername, adminPassword);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/admin/rooms?date=${date}&service=${service}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    const anonymous = await browser.newPage();
    const staff = await browser.newPage();
    await login(staff, e2eStaffUsername, staffPassword);
    const payload = { kind: "ROOM_CATALOG", roomId: crypto.randomUUID(), displayOrder: 1, isActive: false };
    expect((await anonymous.request.post("/api/admin/room-configuration/preview", { headers: { origin }, data: payload })).status()).toBe(401);
    expect((await staff.request.post("/api/admin/room-configuration/preview", { headers: { origin }, data: payload })).status()).toBe(403);
    await anonymous.close();
    await staff.close();
  });

  test("GET, rendering server-side e preview non modificano istanze o righe sala", async ({ page }) => {
    const readDate = "2099-11-24";
    await login(page, e2eAdminUsername, adminPassword);
    const createdResponse = await page.request.post("/api/public/reservations", {
      headers: { origin, "Idempotency-Key": crypto.randomUUID() },
      data: {
        localDate: readDate,
        serviceType: "DINNER",
        arrivalTime: "19:00",
        partySize: 2,
        roomCode: "sala-1",
        customerFirstName: e2eReservationFirstName,
        customerLastName: "ReadOnly",
        customerPhone: "+39000000000",
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
        notes: null,
        language: "it",
        privacyAccepted: true,
        termsAccepted: true,
      },
    });
    expect(createdResponse.ok(), await createdResponse.text()).toBe(true);
    const created = (await createdResponse.json()) as {
      managementPath: string;
    };
    const before = await serviceInstanceSnapshot();

    const adminGet = await page.request.get(
      `/api/admin/room-configuration?date=${readDate}&service=DINNER`,
    );
    expect(adminGet.ok(), await adminGet.text()).toBe(true);
    const room = (await adminGet.json()).configuration.rooms.find(
      (candidate: { code: string }) => candidate.code === "sala-1",
    ) as { id: string; displayOrder: number; isActive: boolean };
    const noOpPreview = await page.request.post(
      "/api/admin/room-configuration/preview",
      {
        headers: { origin },
        data: {
          kind: "ROOM_CATALOG",
          roomId: room.id,
          displayOrder: room.displayOrder,
          isActive: room.isActive,
        },
      },
    );
    expect(noOpPreview.ok(), await noOpPreview.text()).toBe(true);
    expect((await noOpPreview.json()).preview.changed).toBe(false);
    for (const path of [
      `/api/public/availability?date=${readDate}&service=DINNER&partySize=2`,
      `/api/staff/availability?date=${readDate}&service=DINNER&partySize=2`,
    ]) {
      const response = await page.request.get(path);
      expect(response.ok(), await response.text()).toBe(true);
    }
    for (const path of [
      `/admin/rooms?date=${readDate}&service=DINNER`,
      `/dashboard?date=${readDate}&service=DINNER`,
      "/prenota?lang=en",
      `${created.managementPath}?lang=en`,
    ]) {
      const response = await page.goto(path);
      expect(response?.ok()).toBe(true);
    }

    expect(await serviceInstanceSnapshot()).toEqual(before);
  });
});
