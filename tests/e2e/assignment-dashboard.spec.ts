import "dotenv/config";

import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import {
  e2eAdminUsername,
  e2eDiningTableName,
  e2eReservationFirstName,
  e2eRunId,
  e2eStaffUsername,
} from "./e2e-run";

const origin = "http://localhost:4000";
const adminPassword = process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "";
const staffPassword = process.env.AUTH_DEMO_STAFF_PASSWORD ?? "";

interface StaffReservation {
  id: string;
  version: number;
}

interface AssignmentContext {
  reservation: {
    version: number;
    status: "CONFIRMED" | "CANCELLED";
  };
  assignment: null | {
    room: { id: string; code: string; name: string };
    tables: Array<{ id: string; name: string; isActive: boolean }>;
    internalNotes: string | null;
    hasInactiveReferences: boolean;
    hasUnavailableRoomReference: boolean;
  };
  rooms: Array<{
    id: string;
    code: string;
    name: string;
    displayOrder: number;
    isActive: boolean;
    isAvailableForService: boolean | null;
    tables: Array<{
      id: string;
      name: string;
      isActive: boolean;
      displayOrder: number;
      minimumSeats: number;
      maximumSeats: number;
    }>;
  }>;
}

interface ConfigurationPreview {
  fingerprint: string;
  changed: boolean;
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
  await expect(page).toHaveURL(/\/dashboard/);
}

function staffPayload(input: {
  localDate: string;
  lastName: string;
  partySize?: number;
  preference?: string;
}) {
  return {
    localDate: input.localDate,
    serviceType: "DINNER" as const,
    arrivalTime: "19:00",
    partySize: input.partySize ?? 2,
    roomCode: input.preference ?? "sala-2",
    customerFirstName: e2eReservationFirstName,
    customerLastName: input.lastName,
    customerPhone: "+390000001020",
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
    notes: `Fixture M10-C ${e2eRunId}`,
    verbalConsentConfirmed: true,
    sendWhatsAppConfirmation: true,
    capacityOverride: false,
    capacityOverrideReason: null,
  };
}

async function createReservation(
  request: APIRequestContext,
  input: ReturnType<typeof staffPayload>,
): Promise<StaffReservation> {
  const response = await request.post("/api/staff/reservations", {
    headers: { origin, "Idempotency-Key": crypto.randomUUID() },
    data: input,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).reservation as StaffReservation;
}

async function readAssignment(
  request: APIRequestContext,
  reservationId: string,
): Promise<AssignmentContext> {
  const response = await request.get(
    `/api/staff/reservations/${reservationId}/assignment`,
  );
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as AssignmentContext;
}

function selectableRoom(context: AssignmentContext, code: string) {
  const room = context.rooms.find(
    (candidate) =>
      candidate.code === code &&
      candidate.isActive &&
      candidate.isAvailableForService !== false &&
      candidate.tables.some((table) => table.isActive),
  );
  expect(room, `No selectable room ${code} for M10-C E2E`).toBeTruthy();
  return room!;
}

async function assignViaApi(
  request: APIRequestContext,
  reservationId: string,
  roomCode: string,
  note = `Nota interna M10-C ${e2eRunId}`,
) {
  const context = await readAssignment(request, reservationId);
  const room = selectableRoom(context, roomCode);
  const table = room.tables.find((candidate) => candidate.isActive)!;
  const response = await request.put(
    `/api/staff/reservations/${reservationId}/assignment`,
    {
      headers: { origin },
      data: {
        version: context.reservation.version,
        roomId: room.id,
        tableIds: [table.id],
        internalNotes: note,
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  return { room, table, result: (await response.json()) as { reservationVersion: number } };
}

async function clearAndCancel(
  request: APIRequestContext,
  reservationId: string,
) {
  const context = await readAssignment(request, reservationId);
  let version = context.reservation.version;
  if (context.assignment) {
    const clear = await request.delete(
      `/api/staff/reservations/${reservationId}/assignment`,
      { headers: { origin }, data: { version } },
    );
    expect(clear.ok(), await clear.text()).toBe(true);
    version = ((await clear.json()) as { reservationVersion: number })
      .reservationVersion;
  }
  const cancellation = await request.delete(
    `/api/staff/reservations/${reservationId}`,
    { headers: { origin }, data: { version } },
  );
  expect(cancellation.ok(), await cancellation.text()).toBe(true);
}

async function applyConfiguration(
  request: APIRequestContext,
  proposal: unknown,
) {
  const previewResponse = await request.post(
    "/api/admin/room-configuration/preview",
    { headers: { origin }, data: proposal },
  );
  expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
  const preview = (await previewResponse.json()).preview as ConfigurationPreview;
  if (!preview.changed) return;
  const applyResponse = await request.post(
    "/api/admin/room-configuration/apply",
    {
      headers: { origin },
      data: { proposal, fingerprint: preview.fingerprint },
    },
  );
  expect(applyResponse.ok(), await applyResponse.text()).toBe(true);
}

function reservationCard(page: Page, reservationId: string): Locator {
  return page.locator(`article[data-reservation-id="${reservationId}"]`);
}

async function openAssignment(card: Locator) {
  await card
    .getByRole("button", {
      name: /Assegna sala e tavoli|Gestisci assegnazione/u,
    })
    .click();
  const dialog = card.page().getByTestId("assignment-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Caricamento dello stato corrente…")).toBeHidden();
  return dialog;
}

async function chooseRoomAndTable(
  dialog: Locator,
  context: AssignmentContext,
  roomCode: string,
  note: string,
) {
  const room = selectableRoom(context, roomCode);
  const table = room.tables.find((candidate) => candidate.isActive)!;
  await dialog.getByTestId("assignment-room-select").selectOption(room.id);
  await dialog.locator("label").filter({ hasText: table.name }).getByRole("checkbox").check();
  await dialog.getByTestId("assignment-internal-notes").fill(note);
  return { room, table };
}

test.describe.serial("M10-C dashboard assegnazioni", () => {
  test("Staff assegna manualmente e usa filtri/riepiloghi responsive senza perdere la preferenza", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const localDate = "2099-12-01";
    await login(page, "STAFF");
    const assignedReservation = await createReservation(
      page.request,
      staffPayload({
        localDate,
        lastName: `Assign UI ${e2eRunId}`,
        preference: "sala-2",
        partySize: 2,
      }),
    );
    const unassignedReservation = await createReservation(
      page.request,
      staffPayload({
        localDate,
        lastName: `Filter UI ${e2eRunId}`,
        preference: "sala-3",
        partySize: 3,
      }),
    );

    try {
      await page.goto(`/dashboard?date=${localDate}`);
      const card = reservationCard(page, assignedReservation.id);
      await expect(card.getByTestId("unassigned-badge")).toHaveText("DA ASSEGNARE");
      await expect(card.getByTestId("customer-room-preference")).toContainText("Sala 2");

      const context = await readAssignment(page.request, assignedReservation.id);
      const dialog = await openAssignment(card);
      const selected = await chooseRoomAndTable(
        dialog,
        context,
        "sala-1",
        `Nota UI M10-C ${e2eRunId}`,
      );

      for (const viewport of [
        { width: 390, height: 844 },
        { width: 820, height: 1000 },
        { width: 1440, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(dialog).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      }

      const saveResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().endsWith(`/reservations/${assignedReservation.id}/assignment`),
      );
      await dialog.getByTestId("assignment-save").click();
      expect((await saveResponse).status()).toBe(200);
      await expect(dialog).toBeHidden();
      await expect(card.getByTestId("final-room-name")).toHaveText(selected.room.name);
      await expect(card.getByTestId("assigned-table-names")).toContainText(selected.table.name);
      await expect(card.getByTestId("customer-room-preference")).toContainText("Sala 2");
      await expect(page.locator('[data-summary-label="Assegnate"]')).toContainText("1");
      await expect(page.locator('[data-summary-label="Da assegnare"]')).toContainText("1");
      await expect(page.locator('[data-summary-label="Coperti da assegnare"]')).toContainText("3");
      await expect(page.getByTestId("final-room-covers")).toContainText("Sala 1: 2");

      await page.getByTestId("assignment-status-filter").selectOption("UNASSIGNED");
      await page.getByRole("button", { name: "Applica filtri" }).click();
      await expect(reservationCard(page, assignedReservation.id)).toHaveCount(0);
      await expect(reservationCard(page, unassignedReservation.id)).toBeVisible();

      await page.getByTestId("assignment-status-filter").selectOption("ALL");
      await page.getByTestId("final-room-filter").selectOption("sala-1");
      await page.getByRole("button", { name: "Applica filtri" }).click();
      await expect(reservationCard(page, assignedReservation.id)).toBeVisible();
      await expect(reservationCard(page, unassignedReservation.id)).toHaveCount(0);
    } finally {
      await clearAndCancel(page.request, assignedReservation.id);
      await clearAndCancel(page.request, unassignedReservation.id);
    }
  });

  test("Staff riassegna, modifica note e rimuove logicamente l'assegnazione", async ({
    page,
  }) => {
    const localDate = "2099-12-02";
    await login(page, "STAFF");
    const reservation = await createReservation(
      page.request,
      staffPayload({
        localDate,
        lastName: `Reassign UI ${e2eRunId}`,
        preference: "sala-3",
      }),
    );

    try {
      await assignViaApi(page.request, reservation.id, "sala-1");
      await page.goto(`/dashboard?date=${localDate}`);
      const card = reservationCard(page, reservation.id);
      const current = await readAssignment(page.request, reservation.id);
      const dialog = await openAssignment(card);
      const next = await chooseRoomAndTable(
        dialog,
        current,
        "sala-2",
        `Nota riassegnata M10-C ${e2eRunId}`,
      );
      await dialog.getByTestId("assignment-save").click();
      await expect(dialog).toBeHidden();
      await expect(card.getByTestId("final-room-name")).toHaveText(next.room.name);
      await expect(card.getByTestId("customer-room-preference")).toContainText("Sala 3");

      const clearDialog = await openAssignment(card);
      await clearDialog.getByRole("button", { name: "Rimuovi assegnazione" }).click();
      const clearResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          response.url().endsWith(`/reservations/${reservation.id}/assignment`),
      );
      await clearDialog.getByTestId("assignment-clear-confirm").click();
      expect((await clearResponse).status()).toBe(200);
      await expect(clearDialog).toBeHidden();
      await expect(card.getByTestId("unassigned-badge")).toHaveText("DA ASSEGNARE");
      await expect(card.getByTestId("customer-room-preference")).toContainText("Sala 3");
    } finally {
      await clearAndCancel(page.request, reservation.id);
    }
  });

  test("Admin conserva la sala assegnata disattivata e non introduce un'altra sala inattiva", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const localDate = "2099-12-03";
    await login(page, "ADMIN");
    const reservation = await createReservation(
      page.request,
      staffPayload({
        localDate,
        lastName: `Grandfather UI ${e2eRunId}`,
        preference: "sala-2",
      }),
    );
    let currentRoomRestore: unknown;
    let decoyRoomRestore: unknown;

    try {
      const assigned = await assignViaApi(page.request, reservation.id, "sala-1");
      const context = await readAssignment(page.request, reservation.id);
      const decoyRoom = context.rooms.find((room) => room.code === "sala-2")!;
      const disableCurrent = {
        kind: "ROOM_CATALOG",
        roomId: assigned.room.id,
        displayOrder: assigned.room.displayOrder,
        isActive: false,
      };
      const disableDecoy = {
        kind: "ROOM_CATALOG",
        roomId: decoyRoom.id,
        displayOrder: decoyRoom.displayOrder,
        isActive: false,
      };
      currentRoomRestore = { ...disableCurrent, isActive: true };
      decoyRoomRestore = { ...disableDecoy, isActive: true };
      await applyConfiguration(page.request, disableCurrent);
      await applyConfiguration(page.request, disableDecoy);

      await page.goto(`/dashboard?date=${localDate}`);
      const card = reservationCard(page, reservation.id);
      await expect(card.getByTestId("assignment-grandfathering-warning")).toBeVisible();
      await expect(card.getByTestId("final-room-name")).toHaveText(assigned.room.name);
      const dialog = await openAssignment(card);
      await expect(
        dialog.getByTestId("assignment-room-select").locator(`option[value="${decoyRoom.id}"]`),
      ).toHaveAttribute("disabled", "");
      await expect(dialog.getByTestId("assignment-room-select")).toHaveValue(
        assigned.room.id,
      );
      await expect(dialog.getByText(/Puoi conservarli, ma non introdurne di nuovi/u)).toBeVisible();
      const beforeNoOp = await readAssignment(page.request, reservation.id);
      const saveResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().endsWith(`/reservations/${reservation.id}/assignment`),
      );
      await dialog.getByTestId("assignment-save").click();
      expect((await saveResponse).status()).toBe(200);
      await expect(dialog).toBeHidden();
      await expect(readAssignment(page.request, reservation.id)).resolves.toMatchObject({
        reservation: { version: beforeNoOp.reservation.version },
        assignment: {
          room: { id: assigned.room.id },
          tables: [{ id: assigned.table.id }],
          internalNotes: `Nota interna M10-C ${e2eRunId}`,
          hasInactiveReferences: true,
        },
      });
    } finally {
      if (currentRoomRestore) await applyConfiguration(page.request, currentRoomRestore);
      if (decoyRoomRestore) await applyConfiguration(page.request, decoyRoomRestore);
      await clearAndCancel(page.request, reservation.id);
    }
  });

  test("Admin conserva il tavolo assegnato disattivato e non introduce un altro tavolo inattivo", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const localDate = "2099-12-05";
    await login(page, "ADMIN");
    const reservation = await createReservation(
      page.request,
      staffPayload({
        localDate,
        lastName: `Grandfather table UI ${e2eRunId}`,
        preference: "sala-2",
      }),
    );
    const restoreProposals: unknown[] = [];

    try {
      const assigned = await assignViaApi(page.request, reservation.id, "sala-1");
      const initialContext = await readAssignment(page.request, reservation.id);
      const assignedRoom = initialContext.rooms.find(
        (room) => room.id === assigned.room.id,
      )!;
      const createDecoy = await page.request.post(
        "/api/admin/room-configuration/tables",
        {
          headers: { origin },
          data: {
            action: "CREATE_TABLE",
            roomId: assignedRoom.id,
            name: e2eDiningTableName,
            minimumSeats: 1,
            maximumSeats: 2,
            displayOrder: 99,
          },
        },
      );
      expect(createDecoy.ok(), await createDecoy.text()).toBe(true);
      const decoyTableId = ((await createDecoy.json()) as { id: string }).id;
      const context = await readAssignment(page.request, reservation.id);
      const refreshedAssignedRoom = context.rooms.find(
        (room) => room.id === assigned.room.id,
      )!;
      const currentTable = refreshedAssignedRoom.tables.find(
        (table) => table.id === assigned.table.id,
      )!;
      const decoyTable = refreshedAssignedRoom.tables.find(
        (table) => table.id === decoyTableId,
      );
      expect(decoyTable).toBeTruthy();

      for (const table of [currentTable, decoyTable!]) {
        const proposal = {
          kind: "DINING_TABLE",
          tableId: table.id,
          name: table.name,
          minimumSeats: table.minimumSeats,
          maximumSeats: table.maximumSeats,
          displayOrder: table.displayOrder,
          isActive: false,
        };
        restoreProposals.unshift({ ...proposal, isActive: true });
        await applyConfiguration(page.request, proposal);
      }

      await page.goto(`/dashboard?date=${localDate}`);
      const card = reservationCard(page, reservation.id);
      await expect(card.getByTestId("assignment-grandfathering-warning")).toBeVisible();
      const dialog = await openAssignment(card);
      const currentCheckbox = dialog
        .locator("label")
        .filter({ hasText: currentTable.name })
        .getByRole("checkbox");
      const decoyCheckbox = dialog
        .locator("label")
        .filter({ hasText: decoyTable!.name })
        .getByRole("checkbox");
      await expect(currentCheckbox).toBeChecked();
      await expect(currentCheckbox).toBeEnabled();
      await expect(decoyCheckbox).not.toBeChecked();
      await expect(decoyCheckbox).toBeDisabled();

      const beforeNoOp = await readAssignment(page.request, reservation.id);
      const saveResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().endsWith(`/reservations/${reservation.id}/assignment`),
      );
      await dialog.getByTestId("assignment-save").click();
      expect((await saveResponse).status()).toBe(200);
      await expect(dialog).toBeHidden();
      await expect(readAssignment(page.request, reservation.id)).resolves.toMatchObject({
        reservation: { version: beforeNoOp.reservation.version },
        assignment: {
          room: { id: assigned.room.id, isActive: true },
          tables: [{ id: currentTable.id, isActive: false }],
          internalNotes: `Nota interna M10-C ${e2eRunId}`,
          hasInactiveReferences: true,
          hasUnavailableRoomReference: false,
        },
      });
    } finally {
      for (const proposal of restoreProposals) {
        await applyConfiguration(page.request, proposal);
      }
      await clearAndCancel(page.request, reservation.id);
    }
  });

  test("Admin conserva la sala assegnata indisponibile e non introduce un'altra sala indisponibile", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const localDate = "2099-12-06";
    await login(page, "ADMIN");
    const reservation = await createReservation(
      page.request,
      staffPayload({
        localDate,
        lastName: `Grandfather availability UI ${e2eRunId}`,
        preference: "sala-2",
      }),
    );
    const restoreProposals: unknown[] = [];

    try {
      const assigned = await assignViaApi(page.request, reservation.id, "sala-1");
      const context = await readAssignment(page.request, reservation.id);
      const decoyRoom = selectableRoom(context, "sala-2");
      for (const room of [assigned.room, decoyRoom]) {
        const proposal = {
          kind: "SERVICE_ROOM_AVAILABILITY",
          localDate,
          serviceType: "DINNER",
          roomId: room.id,
          isAvailable: false,
        };
        restoreProposals.unshift({ ...proposal, isAvailable: true });
        await applyConfiguration(page.request, proposal);
      }

      await page.goto(`/dashboard?date=${localDate}`);
      const card = reservationCard(page, reservation.id);
      await expect(card.getByTestId("assignment-grandfathering-warning")).toContainText(
        "indisponibile",
      );
      const dialog = await openAssignment(card);
      await expect(dialog.getByTestId("assignment-room-select")).toHaveValue(
        assigned.room.id,
      );
      await expect(
        dialog.getByTestId("assignment-room-select").locator(`option[value="${decoyRoom.id}"]`),
      ).toHaveAttribute("disabled", "");

      const beforeNoOp = await readAssignment(page.request, reservation.id);
      const saveResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().endsWith(`/reservations/${reservation.id}/assignment`),
      );
      await dialog.getByTestId("assignment-save").click();
      expect((await saveResponse).status()).toBe(200);
      await expect(dialog).toBeHidden();
      await expect(readAssignment(page.request, reservation.id)).resolves.toMatchObject({
        reservation: { version: beforeNoOp.reservation.version },
        assignment: {
          room: {
            id: assigned.room.id,
            isActive: true,
            isAvailableForService: false,
          },
          tables: [{ id: assigned.table.id }],
          internalNotes: `Nota interna M10-C ${e2eRunId}`,
          hasInactiveReferences: false,
          hasUnavailableRoomReference: true,
        },
      });
    } finally {
      for (const proposal of restoreProposals) {
        await applyConfiguration(page.request, proposal);
      }
      await clearAndCancel(page.request, reservation.id);
    }
  });

  test("un conflitto ottimistico non sovrascrive la scelta vincente", async ({ page }) => {
    const localDate = "2099-12-04";
    await login(page, "STAFF");
    const reservation = await createReservation(
      page.request,
      staffPayload({
        localDate,
        lastName: `Conflict UI ${e2eRunId}`,
        preference: "sala-3",
      }),
    );

    try {
      await page.goto(`/dashboard?date=${localDate}`);
      const card = reservationCard(page, reservation.id);
      const staleContext = await readAssignment(page.request, reservation.id);
      const dialog = await openAssignment(card);
      await chooseRoomAndTable(
        dialog,
        staleContext,
        "sala-2",
        `Scelta stale M10-C ${e2eRunId}`,
      );
      const winner = await assignViaApi(
        page.request,
        reservation.id,
        "sala-1",
        `Scelta vincente M10-C ${e2eRunId}`,
      );

      const staleResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "PUT" &&
          response.url().endsWith(`/reservations/${reservation.id}/assignment`),
      );
      await dialog.getByTestId("assignment-save").click();
      expect((await staleResponse).status()).toBe(409);
      await expect(dialog).toContainText("La prenotazione è cambiata mentre lavoravi");
      await expect(dialog.getByTestId("assignment-reload-conflict")).toBeVisible();
      expect((await readAssignment(page.request, reservation.id)).assignment?.room.id).toBe(
        winner.room.id,
      );

      await dialog.getByTestId("assignment-reload-conflict").click();
      await expect(dialog.getByTestId("assignment-room-select")).toHaveValue(winner.room.id);
      await expect(card.getByTestId("final-room-name")).toHaveText(winner.room.name);
      expect((await readAssignment(page.request, reservation.id)).assignment?.internalNotes).toBe(
        `Scelta vincente M10-C ${e2eRunId}`,
      );
    } finally {
      await clearAndCancel(page.request, reservation.id);
    }
  });
});
