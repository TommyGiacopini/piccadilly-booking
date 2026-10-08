import "dotenv/config";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import {
  e2eAdminUsername,
  e2eReservationFirstName,
  e2eStaffUsername,
} from "./e2e-run";

const origin = "http://localhost:4000";
const staffPassword = process.env.AUTH_DEMO_STAFF_PASSWORD ?? "";
const adminPassword = process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "";
const agendaDate = "2099-12-22";

interface CreatedReservation {
  id: string;
  version: number;
}

function reservationPayload(input: {
  firstName: string;
  lastName: string;
  phone: string;
  arrivalTime: string;
  serviceType?: "LUNCH" | "DINNER";
  notes?: string | null;
}) {
  return {
    localDate: agendaDate,
    serviceType: input.serviceType ?? ("DINNER" as const),
    arrivalTime: input.arrivalTime,
    partySize: 2,
    childrenCount: 0,
    gameRoomPreference: null,
    customerFirstName: input.firstName,
    customerLastName: input.lastName,
    customerPhone: input.phone,
    customerEmail: null,
    highChair: false,
    stroller: false,
    accessibility: false,
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
  payload: ReturnType<typeof reservationPayload>,
): Promise<CreatedReservation> {
  const response = await request.post("/api/staff/reservations", {
    headers: { origin, "Idempotency-Key": crypto.randomUUID() },
    data: payload,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).reservation as CreatedReservation;
}

async function cancelReservations(
  request: APIRequestContext,
  reservations: readonly CreatedReservation[],
) {
  for (const reservation of reservations) {
    const response = await request.delete(
      `/api/staff/reservations/${reservation.id}`,
      {
        headers: { origin },
        data: { version: reservation.version },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
  }
}

async function visibleAgendaIds(page: Page): Promise<string[]> {
  return page
    .locator("article[data-reservation-id]")
    .evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-reservation-id") ?? ""),
    );
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

test.describe.serial("T02 Staff Agenda", () => {
  test("compone data, servizio, ricerca e ordinamenti deterministici mantenendo le azioni", async ({
    page,
  }) => {
    await login(page, "STAFF");
    const suffix = Date.now().toString();
    const created: CreatedReservation[] = [];
    const names = {
      oldest: `${e2eReservationFirstName} José Zulu ${suffix}`,
      surname: `${e2eReservationFirstName} Àlfa ${suffix}`,
      phone: `${e2eReservationFirstName} Rossi ${suffix}`,
      lunch: `${e2eReservationFirstName} Pranzo ${suffix}`,
    };

    try {
      const oldest = await createReservation(
        page.request,
        reservationPayload({
          firstName: e2eReservationFirstName,
          lastName: `José Zulu ${suffix}`,
          phone: "+39 000 220 0001",
          arrivalTime: "20:00",
        }),
      );
      created.push(oldest);
      await page.waitForTimeout(20);
      const surname = await createReservation(
        page.request,
        reservationPayload({
          firstName: e2eReservationFirstName,
          lastName: `Àlfa ${suffix}`,
          phone: "+39 000 220 0002",
          arrivalTime: "19:15",
        }),
      );
      created.push(surname);
      await page.waitForTimeout(20);
      const phone = await createReservation(
        page.request,
        reservationPayload({
          firstName: e2eReservationFirstName,
          lastName: `Rossi ${suffix}`,
          phone: "+39 000 220 7788",
          arrivalTime: "19:30",
        }),
      );
      created.push(phone);
      const lunch = await createReservation(
        page.request,
        reservationPayload({
          firstName: e2eReservationFirstName,
          lastName: `Pranzo ${suffix}`,
          phone: "+39 000 220 0004",
          arrivalTime: "12:15",
          serviceType: "LUNCH",
        }),
      );
      created.push(lunch);

      await page.goto(`/dashboard?date=${agendaDate}&service=DINNER`);
      await expect(page.getByRole("heading", { name: "Agenda", exact: true })).toBeVisible();
      await expect(page.getByTestId("agenda-result-count")).toContainText(
        "3 risultati",
      );
      const summaryPairs = page.locator(
        'section[aria-label="Riepilogo operativo"] dl > div',
      );
      await expect(summaryPairs).toHaveCount(8);
      for (let index = 0; index < 8; index += 1) {
        expect(
          await summaryPairs.nth(index).evaluate((pair) =>
            Array.from(pair.children).map((child) => child.tagName),
          ),
        ).toEqual(["DT", "DD"]);
      }
      expect(await visibleAgendaIds(page)).toEqual([
        oldest.id,
        surname.id,
        phone.id,
      ]);

      const search = page.getByTestId("agenda-search");
      await search.fill("  jose  ");
      await expect(page.getByText(names.oldest, { exact: true })).toBeVisible();
      await expect(page.getByTestId("agenda-result-count")).toContainText(
        "1 risultato",
      );

      await search.fill(`alfa ${suffix}`);
      await expect(page.getByText(names.surname, { exact: true })).toBeVisible();
      await search.fill(e2eReservationFirstName.toLowerCase());
      await expect(page.getByTestId("agenda-result-count")).toContainText(
        "3 risultati",
      );
      await search.fill("0002207788");
      await expect(page.getByText(names.phone, { exact: true })).toBeVisible();
      await search.fill("nessun-nome-fittizio-t02");
      await expect(page.getByText("Nessun risultato per la ricerca.")).toBeVisible();
      await page.getByRole("button", { name: "Mostra tutta l’agenda" }).click();

      const order = page.getByTestId("agenda-order");
      await order.selectOption("SURNAME");
      expect(await visibleAgendaIds(page)).toEqual([
        surname.id,
        oldest.id,
        phone.id,
      ]);
      await order.selectOption("FIRST_NAME");
      expect(await visibleAgendaIds(page)).toEqual([
        surname.id,
        oldest.id,
        phone.id,
      ]);
      await order.selectOption("ARRIVAL");
      expect(await visibleAgendaIds(page)).toEqual([
        surname.id,
        phone.id,
        oldest.id,
      ]);
      await order.selectOption("OLDEST");
      expect(await visibleAgendaIds(page)).toEqual([
        oldest.id,
        surname.id,
        phone.id,
      ]);

      const oldestCard = page.locator(
        `article[data-reservation-id="${oldest.id}"]`,
      );
      await expect(
        oldestCard.getByRole("button", { name: "Assegna sala e tavoli" }),
      ).toBeVisible();
      await expect(oldestCard.getByTestId("unassigned-badge")).toHaveText(
        "DA ASSEGNARE",
      );
      await expect(oldestCard.getByTestId("unassigned-badge")).toBeVisible();
      await expect(oldestCard.getByTestId("arrival-state")).toHaveText("ATTESO");
      await expect(
        oldestCard.getByRole("button", { name: "Segna arrivato" }),
      ).toBeVisible();
      await expect(oldestCard.getByRole("link", { name: "Modifica" })).toBeVisible();
      await expect(oldestCard.getByRole("button", { name: "Cancella" })).toBeVisible();

      await page.getByLabel("Servizio").selectOption("LUNCH");
      await page.getByRole("button", { name: "Applica filtri" }).click();
      await expect(page.getByText(names.lunch, { exact: true })).toBeVisible();
      await expect(page.getByText(names.oldest, { exact: true })).toHaveCount(0);

      await page.getByLabel("Seleziona data").fill("2099-12-23");
      await page.getByRole("button", { name: "Vai", exact: true }).click();
      await expect(
        page.getByText("Nessuna prenotazione nella data e nel servizio selezionati."),
      ).toBeVisible();
    } finally {
      await cancelReservations(page.request, created);
    }
  });

  test("gestisce contenuti lunghi senza overflow da 320px al desktop e allo zoom 200%", async ({
    page,
  }) => {
    await login(page, "STAFF");
    const suffix = Date.now().toString();
    const longLastName = `Responsabile della prenotazione operativa molto lunga ${suffix}`;
    const longNote = `Richiesta fittizia T02 ${"testolunghissimo".repeat(35)}`;
    let reservation: CreatedReservation | null = null;

    try {
      reservation = await createReservation(
        page.request,
        reservationPayload({
          firstName: e2eReservationFirstName,
          lastName: longLastName,
          phone: "+39 000 220 8899",
          arrivalTime: "19:45",
          notes: longNote,
        }),
      );
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
        await expect(card).toContainText(longLastName);
        await expect(card).toContainText(longNote);
        await expect(card.getByTestId("unassigned-badge")).toHaveText(
          "DA ASSEGNARE",
        );
        await expect(card.getByRole("link", { name: "Modifica" })).toBeVisible();
        await expect(card.getByRole("button", { name: "Cancella" })).toBeVisible();
        console.info(
          `T02_RESPONSIVE_METRICS ${JSON.stringify({ viewport, ...(await expectNoHorizontalOverflow(page)) })}`,
        );
      }

      const chromiumSession = await page.context().newCDPSession(page);
      await page.setViewportSize({ width: 640, height: 450 });
      await chromiumSession.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: 2,
      });
      const zoomMetrics = await expectNoHorizontalOverflow(page);
      expect(
        await page.evaluate(() => window.visualViewport?.scale ?? null),
      ).toBe(2);
      console.info(
        `T02_RESPONSIVE_METRICS ${JSON.stringify({ viewport: "200%-zoom", ...zoomMetrics })}`,
      );
      await chromiumSession.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: 1,
      });
    } finally {
      if (reservation) await cancelReservations(page.request, [reservation]);
    }
  });

  test("mantiene la Staff Agenda compatibile con la shell Admin", async ({ page }) => {
    await login(page, "ADMIN");
    await page.goto(`/dashboard?date=${agendaDate}`);
    await expect(page.getByRole("heading", { name: "Agenda", exact: true })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Navigazione area Staff" }).getByRole(
        "link",
        { name: "Admin" },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Nuova prenotazione telefonica" }),
    ).toBeVisible();
  });
});
