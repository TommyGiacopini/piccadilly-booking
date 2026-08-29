import "dotenv/config";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { Pool } from "pg";

import {
  e2eAdminUsername,
  e2eReservationFirstName,
  e2eRestaurantId,
  e2eRunId,
  e2eStaffUsername,
} from "./e2e-run";

const origin = "http://localhost:4000";
const restaurantId = e2eRestaurantId;
const adminPassword = process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "";
const staffPassword = process.env.AUTH_DEMO_STAFF_PASSWORD ?? "";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required for M10-B E2E checks.");

const database = new Pool({ connectionString: databaseUrl });

interface StaffReservation {
  id: string;
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  partySize: number;
  version: number;
  customer: {
    firstName: string;
    lastName: string;
    phone: string;
    email: string | null;
  };
  roomCode: string;
  highChair: boolean;
  stroller: boolean;
  accessibility: boolean;
  children: boolean;
  celiac: boolean;
  allergies: string | null;
  intolerances: string | null;
  celebration: string | null;
  animals: boolean;
  notes: string | null;
}

interface AssignmentContext {
  reservation: { version: number };
  assignment: null | {
    hasInactiveReferences: boolean;
    hasUnavailableRoomReference: boolean;
    internalNotes: string | null;
  };
  rooms: Array<{
    id: string;
    code: string;
    name: string;
    displayOrder: number;
    isActive: boolean;
    isAvailableForService: boolean | null;
    tables: Array<{ id: string; isActive: boolean }>;
  }>;
}

interface Preview {
  fingerprint: string;
  changed: boolean;
  confirmationRequired: boolean;
  impact: {
    reservationCount: number;
    assignmentReservationCount: number;
  };
}

async function login(page: Page, role: "STAFF" | "ADMIN") {
  await page.goto("/login");
  await page
    .getByLabel("Username")
    .fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page.getByLabel("Password").fill(role === "ADMIN" ? adminPassword : staffPassword);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

function staffPayload(input: {
  localDate: string;
  lastName: string;
  roomCode?: string;
  arrivalTime?: string;
}) {
  return {
    localDate: input.localDate,
    serviceType: "DINNER" as const,
    arrivalTime: input.arrivalTime ?? "19:00",
    partySize: 2,
    roomCode: input.roomCode ?? "sala-2",
    customerFirstName: e2eReservationFirstName,
    customerLastName: input.lastName,
    customerPhone: "+390000001010",
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
    notes: `Fixture M10-B ${e2eRunId}`,
    capacityOverride: false,
    capacityOverrideReason: null,
  };
}

function publicPayload(localDate: string, lastName: string, arrivalTime = "19:00") {
  return {
    localDate,
    serviceType: "DINNER" as const,
    arrivalTime,
    partySize: 2,
    roomCode: "sala-2",
    highChair: false,
    stroller: false,
    accessibility: false,
    children: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: `Fixture pubblica M10-B ${e2eRunId}`,
    customerFirstName: e2eReservationFirstName,
    customerLastName: lastName,
    customerPhone: "+390000001011",
    customerEmail: null,
    language: "it" as const,
    privacyAccepted: true,
    termsAccepted: true,
  };
}

async function createStaffReservation(
  request: APIRequestContext,
  input: ReturnType<typeof staffPayload>,
): Promise<StaffReservation> {
  const response = await request.post("/api/staff/reservations", {
    headers: { origin, "Idempotency-Key": crypto.randomUUID() },
    data: {
      ...input,
      verbalConsentConfirmed: true,
      sendWhatsAppConfirmation: true,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).reservation as StaffReservation;
}

async function assignmentContext(
  request: APIRequestContext,
  reservationId: string,
): Promise<AssignmentContext> {
  const response = await request.get(
    `/api/staff/reservations/${reservationId}/assignment`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as AssignmentContext;
}

async function assign(
  request: APIRequestContext,
  reservationId: string,
  roomCode = "sala-1",
) {
  const context = await assignmentContext(request, reservationId);
  const room = context.rooms.find(
    (candidate) =>
      candidate.code === roomCode &&
      candidate.isActive &&
      candidate.isAvailableForService !== false &&
      candidate.tables.some((table) => table.isActive),
  );
  expect(room, `No active ${roomCode} E2E assignment fixture`).toBeTruthy();
  const table = room?.tables.find((candidate) => candidate.isActive);
  const response = await request.put(
    `/api/staff/reservations/${reservationId}/assignment`,
    {
      headers: { origin },
      data: {
        version: context.reservation.version,
        roomId: room?.id,
        tableIds: [table?.id],
        internalNotes: `Nota interna M10-B ${e2eRunId}`,
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return { room: room!, result: (await response.json()) as { reservationVersion: number } };
}

async function preview(request: APIRequestContext, proposal: unknown): Promise<Preview> {
  const response = await request.post("/api/admin/room-configuration/preview", {
    headers: { origin },
    data: proposal,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).preview as Preview;
}

async function apply(request: APIRequestContext, proposal: unknown) {
  const current = await preview(request, proposal);
  if (!current.changed) return current;
  const response = await request.post("/api/admin/room-configuration/apply", {
    headers: { origin },
    data: { proposal, fingerprint: current.fingerprint },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return current;
}

async function clearAndCancel(
  request: APIRequestContext,
  reservationId: string,
) {
  const context = await assignmentContext(request, reservationId);
  const cleared = await request.delete(
    `/api/staff/reservations/${reservationId}/assignment`,
    { headers: { origin }, data: { version: context.reservation.version } },
  );
  if (!cleared.ok()) return;
  const version = ((await cleared.json()) as { reservationVersion: number })
    .reservationVersion;
  const cancelled = await request.delete(`/api/staff/reservations/${reservationId}`, {
    headers: { origin },
    data: { version },
  });
  expect(cancelled.ok(), await cancelled.text()).toBe(true);
}

test.describe.serial("M10-B lifecycle assegnazioni", () => {
  test.afterAll(async () => {
    await database.end();
  });

  test("assegnazione via API e reschedule Staff sono atomici", async ({ page }) => {
    await login(page, "STAFF");
    const original = staffPayload({
      localDate: "2099-11-18",
      lastName: `Staff lifecycle ${e2eRunId}`,
    });
    const reservation = await createStaffReservation(page.request, original);
    const assigned = await assign(page.request, reservation.id);

    const update = await page.request.patch(`/api/staff/reservations/${reservation.id}`, {
      headers: { origin },
      data: {
        ...original,
        localDate: "2099-11-19",
        version: assigned.result.reservationVersion,
      },
    });
    expect(update.ok(), await update.text()).toBe(true);
    const updated = (await update.json()).reservation as StaffReservation;
    expect(updated).toMatchObject({ localDate: "2099-11-19", version: 3 });
    const context = await assignmentContext(page.request, reservation.id);
    expect(context.assignment).toBeNull();
    const stored = await database.query<{ cleared_at: string | null; audits: string }>(
      `SELECT ra.cleared_at::text,
              (SELECT count(*)::text FROM reservation_audit_events e
               WHERE e.restaurant_id = ra.restaurant_id
                 AND e.reservation_id = ra.reservation_id
                 AND e.action::text = 'UNASSIGNED') AS audits
       FROM reservation_assignments ra
       WHERE ra.restaurant_id = $1::uuid AND ra.reservation_id = $2::uuid`,
      [restaurantId, reservation.id],
    );
    expect(stored.rows[0]?.cleared_at).not.toBeNull();
    expect(stored.rows[0]?.audits).toBe("1");
    await clearAndCancel(page.request, reservation.id);
  });

  test("assegnazione via API e reschedule dal link personale non espongono dati interni", async ({ page }) => {
    await login(page, "STAFF");
    const lastName = `Public lifecycle ${e2eRunId}`;
    const createdResponse = await page.request.post("/api/public/reservations", {
      headers: { origin, "Idempotency-Key": crypto.randomUUID() },
      data: publicPayload("2099-11-20", lastName),
    });
    expect(createdResponse.ok(), await createdResponse.text()).toBe(true);
    const created = (await createdResponse.json()) as { managementPath: string };
    const token = created.managementPath.slice("/p/".length);
    const reservationRow = await database.query<{ id: string }>(
      `SELECT id::text FROM reservations
       WHERE restaurant_id = $1::uuid
         AND customer_first_name = $2
         AND customer_last_name = $3
       ORDER BY created_at DESC LIMIT 1`,
      [restaurantId, e2eReservationFirstName, lastName],
    );
    const reservationId = reservationRow.rows[0]?.id;
    expect(reservationId).toBeTruthy();
    await assign(page.request, reservationId!);

    const publicUpdate = publicPayload("2099-11-20", lastName, "19:15");
    const update = await page.request.patch(`/api/public/reservations/${token}`, {
      headers: { origin },
      data: {
        localDate: publicUpdate.localDate,
        serviceType: publicUpdate.serviceType,
        arrivalTime: publicUpdate.arrivalTime,
        partySize: publicUpdate.partySize,
        roomCode: publicUpdate.roomCode,
        highChair: publicUpdate.highChair,
        stroller: publicUpdate.stroller,
        accessibility: publicUpdate.accessibility,
        children: publicUpdate.children,
        celiac: publicUpdate.celiac,
        allergies: publicUpdate.allergies,
        intolerances: publicUpdate.intolerances,
        celebration: publicUpdate.celebration,
        animals: publicUpdate.animals,
        notes: publicUpdate.notes,
      },
    });
    expect(update.ok(), await update.text()).toBe(true);
    const body = (await update.json()) as { reservation: Record<string, unknown> };
    expect(body.reservation).not.toHaveProperty("assignment");
    expect(body.reservation).not.toHaveProperty("internalNotes");
    expect(JSON.stringify(body)).not.toContain(`Nota interna M10-B ${e2eRunId}`);
    expect((await assignmentContext(page.request, reservationId!)).assignment).toBeNull();
    const cancellation = await page.request.delete(`/api/public/reservations/${token}`, {
      headers: { origin },
      data: {},
    });
    expect(cancellation.ok(), await cancellation.text()).toBe(true);
  });

  test("preview obsoleta, conferma Admin e grandfathering restano coerenti a ogni viewport", async ({ page }) => {
    test.setTimeout(90_000);
    await login(page, "ADMIN");
    const localDate = "2099-11-22";
    const original = staffPayload({
      localDate,
      lastName: `Impact lifecycle ${e2eRunId}`,
      roomCode: "sala-2",
    });
    const reservation = await createStaffReservation(page.request, original);
    let room:
      | { id: string; code: string; name: string; displayOrder: number }
      | undefined;
    let restoreProposal: unknown;

    try {
      const beforeAssignment = await assignmentContext(page.request, reservation.id);
      room = beforeAssignment.rooms.find((candidate) => candidate.code === "sala-1");
      expect(room).toBeTruthy();
      const disableProposal = {
        kind: "ROOM_CATALOG",
        roomId: room!.id,
        displayOrder: room!.displayOrder,
        isActive: false,
      };
      restoreProposal = { ...disableProposal, isActive: true };
      await apply(page.request, restoreProposal);
      const stale = await preview(page.request, disableProposal);
      await assign(page.request, reservation.id, room!.code);

      const staleApply = await page.request.post(
        "/api/admin/room-configuration/apply",
        {
          headers: { origin },
          data: { proposal: disableProposal, fingerprint: stale.fingerprint },
        },
      );
      expect(staleApply.status()).toBe(409);
      await expect(staleApply.json()).resolves.toMatchObject({ code: "IMPACT_CHANGED" });
      const current = await preview(page.request, disableProposal);
      expect(current).toMatchObject({
        confirmationRequired: true,
        impact: { assignmentReservationCount: expect.any(Number) },
      });
      expect(current.impact.assignmentReservationCount).toBeGreaterThanOrEqual(1);

      await page.goto(`/admin/rooms?date=${localDate}&service=DINNER`);
      const roomSection = page.locator("section").filter({
        has: page.getByRole("heading", { name: room!.name, exact: true }),
      });
      const roomForm = roomSection.locator('form:has(button:has-text("Salva sala"))');
      await roomForm.getByLabel("Sala attiva globalmente").uncheck();
      await roomForm.getByRole("button", { name: "Salva sala" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("assegnazioni finali");
      for (const width of [390, 820, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(dialog).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      }
      await dialog.getByRole("button", { name: "Conferma e applica" }).click();
      await expect(page.getByRole("status")).toContainText("Configurazione salvata");

      const grandfathered = await assignmentContext(page.request, reservation.id);
      expect(grandfathered.assignment).toMatchObject({
        hasInactiveReferences: true,
        internalNotes: `Nota interna M10-B ${e2eRunId}`,
      });
    } finally {
      if (restoreProposal) await apply(page.request, restoreProposal);
      await clearAndCancel(page.request, reservation.id);
    }
  });

  test("IMPACT_CHANGED chiude il dialogo quando la nuova preview non richiede conferma", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 820, height: 900 });
    await login(page, "ADMIN");
    const localDate = "2099-11-23";
    const reservation = await createStaffReservation(
      page.request,
      staffPayload({
        localDate,
        lastName: `Stale UI lifecycle ${e2eRunId}`,
        roomCode: "sala-2",
      }),
    );
    let restoreProposal: unknown;

    try {
      const context = await assignmentContext(page.request, reservation.id);
      const room = context.rooms.find((candidate) => candidate.code === "sala-1");
      expect(room).toBeTruthy();
      const disableProposal = {
        kind: "ROOM_CATALOG",
        roomId: room!.id,
        displayOrder: room!.displayOrder,
        isActive: false,
      };
      restoreProposal = { ...disableProposal, isActive: true };
      await apply(page.request, restoreProposal);
      const assigned = await assign(page.request, reservation.id, room!.code);

      await page.goto(`/admin/rooms?date=${localDate}&service=DINNER`);
      const roomSection = page.locator("section").filter({
        has: page.getByRole("heading", { name: room!.name, exact: true }),
      });
      const roomForm = roomSection.locator(
        'form:has(button:has-text("Salva sala"))',
      );
      await roomForm.getByLabel("Sala attiva globalmente").uncheck();
      await roomForm.getByRole("button", { name: "Salva sala" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Conferma esplicita");

      const clear = await page.request.delete(
        `/api/staff/reservations/${reservation.id}/assignment`,
        {
          headers: { origin },
          data: { version: assigned.result.reservationVersion },
        },
      );
      expect(clear.ok(), await clear.text()).toBe(true);

      await dialog.getByRole("button", { name: "Conferma e applica" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("status")).toContainText(
        "L'impatto è cambiato. Ripeti l'azione",
      );
      await expect
        .poll(async () => {
          const stored = await database.query<{ is_active: boolean }>(
            `SELECT is_active FROM rooms
             WHERE restaurant_id = $1::uuid AND id = $2::uuid`,
            [restaurantId, room!.id],
          );
          return stored.rows[0]?.is_active;
        })
        .toBe(true);

      await roomForm.getByRole("button", { name: "Salva sala" }).click();
      await expect(page.getByRole("status")).toContainText(
        "Configurazione salvata",
      );
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect
        .poll(async () => {
          const stored = await database.query<{ is_active: boolean }>(
            `SELECT is_active FROM rooms
             WHERE restaurant_id = $1::uuid AND id = $2::uuid`,
            [restaurantId, room!.id],
          );
          return stored.rows[0]?.is_active;
        })
        .toBe(false);
    } finally {
      if (restoreProposal) await apply(page.request, restoreProposal);
      await clearAndCancel(page.request, reservation.id);
    }
  });
});
