import "dotenv/config";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

import {
  e2eAdminUsername,
  e2eReservationFirstName,
  e2eStaffUsername,
} from "./e2e-run";

const { Client } = pg;
const origin = "http://localhost:4000";
const staffPassword = process.env.AUTH_DEMO_STAFF_PASSWORD ?? "";
const adminPassword = process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "";
const databaseUrl = process.env.DATABASE_URL;
const agendaDate = "2099-12-24";

if (!databaseUrl) throw new Error("DATABASE_URL is required for T03 E2E checks.");

interface ReservationRef {
  id: string;
  version: number;
}

interface ArrivalRequestBody {
  arrived: boolean;
  version: number;
}

function payload(input: {
  lastName: string;
  partySize?: number;
  notes?: string;
}) {
  return {
    localDate: agendaDate,
    serviceType: "DINNER" as const,
    arrivalTime: "19:30",
    partySize: input.partySize ?? 2,
    roomCode: "sala-1",
    customerFirstName: e2eReservationFirstName,
    customerLastName: input.lastName,
    customerPhone: "+39 000 330 0001",
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
    notes: input.notes ?? null,
    verbalConsentConfirmed: true,
    sendWhatsAppConfirmation: false,
    capacityOverride: false,
    capacityOverrideReason: null,
  };
}

async function login(page: Page, role: "STAFF" | "ADMIN") {
  await page.goto("/login");
  await page
    .getByLabel("Username")
    .fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page
    .getByLabel("Password")
    .fill(role === "ADMIN" ? adminPassword : staffPassword);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/u);
}

async function createReservation(
  request: APIRequestContext,
  data: ReturnType<typeof payload>,
): Promise<ReservationRef> {
  const response = await request.post("/api/staff/reservations", {
    headers: { origin, "Idempotency-Key": crypto.randomUUID() },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).reservation as ReservationRef;
}

async function cancelReservation(
  request: APIRequestContext,
  reservation: ReservationRef,
) {
  const response = await request.delete(
    `/api/staff/reservations/${reservation.id}`,
    { headers: { origin }, data: { version: reservation.version } },
  );
  const responseBody = await response.text();
  if (!response.ok()) {
    const persisted = await readArrivalPersistence(reservation.id);
    throw new Error(
      `Cancellation failed: expected version ${reservation.version}, persisted version ${persisted.version}, response ${responseBody}`,
    );
  }
}

async function readArrivalPersistence(reservationId: string) {
  const database = new Client({ connectionString: databaseUrl });
  await database.connect();
  try {
    const reservation = await database.query<{
      arrived_at: Date | null;
      version: number;
    }>(
      `SELECT arrived_at, version
       FROM reservations
       WHERE id = $1`,
      [reservationId],
    );
    const audits = await database.query<{ action: string }>(
      `SELECT action::text
       FROM reservation_audit_events
       WHERE reservation_id = $1
         AND action IN ('ARRIVAL_RECORDED', 'ARRIVAL_REVERTED')
       ORDER BY created_at ASC, id ASC`,
      [reservationId],
    );
    const row = reservation.rows[0];
    if (!row) throw new Error("T03 reservation persistence row not found.");
    return {
      arrivedAt: row.arrived_at,
      version: row.version,
      actions: audits.rows.map(({ action }) => action),
    };
  } finally {
    await database.end();
  }
}

async function summaryValue(page: Page, label: string): Promise<number> {
  const item = page.locator(`[data-summary-label="${label}"]`);
  return Number(await item.locator("dd").innerText());
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
  return metrics;
}

test.describe.serial("T03 arrival lifecycle", () => {
  test("registra e annulla arrival senza doppia mutation e riallinea il riepilogo", async ({
    page,
  }) => {
    await login(page, "STAFF");
    const reservation = await createReservation(
      page.request,
      payload({ lastName: `Arrivo Corrente ${Date.now()}`, partySize: 3 }),
    );
    let currentVersion = reservation.version;
    try {
      await page.goto(`/dashboard?date=${agendaDate}&service=DINNER`);
      const card = page.locator(
        `article[data-reservation-id="${reservation.id}"]`,
      );
      await expect(card.getByTestId("arrival-state")).toHaveText("ATTESO");
      await expect(card.getByTestId("unassigned-badge")).toHaveText(
        "DA ASSEGNARE",
      );
      const arrivedBefore = await summaryValue(page, "Coperti arrivati");
      const expectedBefore = await summaryValue(page, "Coperti attesi");

      let arrivalRequests = 0;
      await page.route(`**/api/staff/reservations/${reservation.id}/arrival`, async (route) => {
        arrivalRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.continue();
      });
      const button = card.getByTestId("arrival-action");
      await expect(button).toHaveAccessibleName("Segna arrivato");
      await button.evaluate((element) => {
        const htmlButton = element as HTMLButtonElement;
        htmlButton.click();
        htmlButton.click();
      });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("aria-busy", "true");
      await expect(card.getByTestId("arrival-state")).toHaveText("ARRIVATO");
      await expect(card.getByRole("status")).toContainText("Arrivo registrato");
      expect(arrivalRequests).toBe(1);
      currentVersion += 1;
      await expect(page.locator('[data-summary-label="Coperti arrivati"] dd')).toHaveText(
        String(arrivedBefore + 3),
      );
      await expect(page.locator('[data-summary-label="Coperti attesi"] dd')).toHaveText(
        String(expectedBefore - 3),
      );

      await page.reload();
      await expect(card.getByTestId("arrival-state")).toHaveText("ARRIVATO");
      await card.getByRole("button", { name: "Segna atteso" }).click();
      await expect(card.getByTestId("arrival-state")).toHaveText("ATTESO");
      await expect(card.getByRole("status")).toContainText("Arrivo annullato");
      currentVersion += 1;
      await expect(page.locator('[data-summary-label="Coperti arrivati"] dd')).toHaveText(
        String(arrivedBefore),
      );
      await expect(page.locator('[data-summary-label="Coperti attesi"] dd')).toHaveText(
        String(expectedBefore),
      );
      const persisted = await readArrivalPersistence(reservation.id);
      expect(persisted).toEqual({
        arrivedAt: null,
        version: currentVersion,
        actions: ["ARRIVAL_RECORDED", "ARRIVAL_REVERTED"],
      });
    } finally {
      const persisted = await readArrivalPersistence(reservation.id);
      await cancelReservation(page.request, {
        id: reservation.id,
        version: persisted.version,
      });
    }
  });

  test("dopo un conflitto scarta l'override stale e usa la versione server al retry manuale", async ({
    page,
  }) => {
    await login(page, "STAFF");
    const reservationData = payload({
      lastName: `Riconciliazione conflitto ${Date.now()}`,
    });
    const reservation = await createReservation(page.request, reservationData);
    const arrivalBodies: ArrivalRequestBody[] = [];

    await page.route(
      `**/api/staff/reservations/${reservation.id}/arrival`,
      async (route) => {
        arrivalBodies.push(route.request().postDataJSON() as ArrivalRequestBody);
        await route.continue();
      },
    );

    try {
      await page.goto(`/dashboard?date=${agendaDate}&service=DINNER`);
      const card = page.locator(
        `article[data-reservation-id="${reservation.id}"]`,
      );
      await expect(card.getByTestId("arrival-state")).toHaveText("ATTESO");
      await expect(card).toHaveAttribute(
        "data-reservation-version",
        String(reservation.version),
      );

      await card.getByRole("button", { name: "Segna arrivato" }).click();
      await expect(card.getByTestId("arrival-state")).toHaveText("ARRIVATO");
      await expect(card).toHaveAttribute(
        "data-reservation-version",
        String(reservation.version + 1),
      );
      expect(arrivalBodies).toEqual([
        { arrived: true, version: reservation.version },
      ]);

      const {
        sendWhatsAppConfirmation: _sendWhatsAppConfirmation,
        verbalConsentConfirmed: _verbalConsentConfirmed,
        ...updateData
      } = reservationData;
      void _sendWhatsAppConfirmation;
      void _verbalConsentConfirmed;
      const concurrentUpdate = await page.request.patch(
        `/api/staff/reservations/${reservation.id}`,
        {
          headers: { origin },
          data: {
            ...updateData,
            notes: "Aggiornamento concorrente sintetico F-01",
            version: reservation.version + 1,
          },
        },
      );
      expect(concurrentUpdate.ok(), await concurrentUpdate.text()).toBe(true);
      const concurrentBody = (await concurrentUpdate.json()) as {
        reservation: ReservationRef;
      };
      expect(concurrentBody.reservation.version).toBe(reservation.version + 2);

      await card.getByRole("button", { name: "Segna atteso" }).click();
      await expect(card.getByRole("alert")).toContainText(
        "aggiornata da un altro operatore",
      );
      expect(arrivalBodies).toEqual([
        { arrived: true, version: reservation.version },
        { arrived: false, version: reservation.version + 1 },
      ]);

      await expect(card).toHaveAttribute(
        "data-reservation-version",
        String(reservation.version + 2),
      );
      const afterConflict = await readArrivalPersistence(reservation.id);
      expect(afterConflict).toMatchObject({
        version: reservation.version + 2,
        actions: ["ARRIVAL_RECORDED"],
      });
      expect(afterConflict.arrivedAt).not.toBeNull();
      expect(arrivalBodies).toHaveLength(2);

      await card.getByRole("button", { name: "Segna atteso" }).click();
      await expect(card.getByTestId("arrival-state")).toHaveText("ATTESO");
      await expect(card.getByRole("status")).toContainText("Arrivo annullato");
      expect(arrivalBodies).toEqual([
        { arrived: true, version: reservation.version },
        { arrived: false, version: reservation.version + 1 },
        { arrived: false, version: reservation.version + 2 },
      ]);

      const persisted = await readArrivalPersistence(reservation.id);
      expect(persisted).toEqual({
        arrivedAt: null,
        version: reservation.version + 3,
        actions: ["ARRIVAL_RECORDED", "ARRIVAL_REVERTED"],
      });
    } finally {
      const persisted = await readArrivalPersistence(reservation.id);
      await cancelReservation(page.request, {
        id: reservation.id,
        version: persisted.version,
      });
    }
  });

  test("recupera un conflitto, supporta Admin/cancellate e distingue lo storico", async ({
    page,
  }) => {
    await login(page, "ADMIN");
    const conflict = await createReservation(
      page.request,
      payload({ lastName: `Conflitto ${Date.now()}` }),
    );
    const cancelled = await createReservation(
      page.request,
      payload({ lastName: `Cancellata ${Date.now()}` }),
    );
    const historical = await createReservation(
      page.request,
      payload({ lastName: `Storica ${Date.now()}` }),
    );
    let conflictVersion = conflict.version;
    let cancelledVersion = cancelled.version;
    const database = new Client({ connectionString: databaseUrl });
    await database.connect();
    try {
      await page.goto(`/dashboard?date=${agendaDate}&service=DINNER`);
      const conflictCard = page.locator(
        `article[data-reservation-id="${conflict.id}"]`,
      );
      await database.query(
        `UPDATE reservations SET version = version + 1
         WHERE id = $1`,
        [conflict.id],
      );
      conflictVersion += 1;
      await conflictCard.getByRole("button", { name: "Segna arrivato" }).click();
      await expect(conflictCard.getByRole("alert")).toContainText(
        "aggiornata da un altro operatore",
      );
      await expect(conflictCard.getByTestId("arrival-state")).toHaveText("ATTESO");

      await cancelReservation(page.request, cancelled);
      cancelledVersion += 1;
      await page.reload();
      const cancelledCard = page.locator(
        `article[data-reservation-id="${cancelled.id}"]`,
      );
      await expect(cancelledCard).toContainText("Cancellata");
      await expect(cancelledCard.getByTestId("arrival-state")).toHaveText(
        "ARRIVO NON REGISTRATO",
      );
      await cancelledCard.getByRole("button", { name: "Segna arrivato" }).click();
      cancelledVersion += 1;
      await expect(cancelledCard.getByTestId("arrival-state")).toHaveText(
        "ARRIVATO",
      );
      await expect(
        cancelledCard.getByRole("button", {
          name: "Rimuovi arrivo registrato",
        }),
      ).toBeVisible();

      await database.query(
        `UPDATE reservations SET local_date = '2025-01-15'::date
         WHERE id = $1`,
        [historical.id],
      );
      await page.goto("/dashboard?date=2025-01-15&service=DINNER");
      const historicalCard = page.locator(
        `article[data-reservation-id="${historical.id}"]`,
      );
      await expect(historicalCard.getByTestId("arrival-state")).toHaveText(
        "ARRIVO NON REGISTRATO",
      );
      await expect(
        page.locator('[data-summary-label="Coperti senza arrivo registrato"]'),
      ).toBeVisible();
      await historicalCard.getByTestId("arrival-action").focus();
      await expect(historicalCard.getByTestId("arrival-action")).toBeFocused();
      await expect(
        page.getByRole("navigation", { name: "Navigazione area Staff" })
          .getByRole("link", { name: "Admin" }),
      ).toBeVisible();
    } finally {
      await database.end();
      await cancelReservation(page.request, {
        id: conflict.id,
        version: conflictVersion,
      });
      await cancelReservation(page.request, {
        id: cancelled.id,
        version: cancelledVersion,
      });
      await cancelReservation(page.request, historical);
    }
  });

  test("mantiene control, contenuto lungo e reflow dalla viewport 320 allo zoom 200%", async ({
    page,
  }) => {
    await login(page, "STAFF");
    const reservation = await createReservation(
      page.request,
      payload({
        lastName: `Responsabile arrival con nominativo operativo molto lungo ${Date.now()}`,
        notes: `Nota sintetica T03 ${"contenutomoltolungo".repeat(35)}`,
      }),
    );
    try {
      await page.goto(`/dashboard?date=${agendaDate}&service=DINNER`);
      const card = page.locator(
        `article[data-reservation-id="${reservation.id}"]`,
      );
      for (const viewport of [
        { width: 320, height: 640 },
        { width: 390, height: 844 },
        { width: 820, height: 1180 },
        { width: 1280, height: 720 },
        { width: 1440, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(card.getByTestId("arrival-state")).toBeVisible();
        await expect(card.getByTestId("arrival-action")).toBeVisible();
        const metrics = await expectNoHorizontalOverflow(page);
        console.info(
          `T03_RESPONSIVE_METRICS ${JSON.stringify({ viewport, ...metrics })}`,
        );
      }
      const session = await page.context().newCDPSession(page);
      await page.setViewportSize({ width: 640, height: 450 });
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
      const zoomMetrics = await expectNoHorizontalOverflow(page);
      expect(await page.evaluate(() => window.visualViewport?.scale ?? null)).toBe(2);
      console.info(
        `T03_RESPONSIVE_METRICS ${JSON.stringify({ viewport: "200%-zoom", ...zoomMetrics })}`,
      );
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    } finally {
      await cancelReservation(page.request, reservation);
    }
  });
});
