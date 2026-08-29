import "dotenv/config";

import { createHash, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

import { resolveDatabaseUrl } from "../../src/server/db/database-config";
import {
  e2eAdminUsername,
  e2eReservationFirstName,
  e2eRestaurantId,
  e2eRunId,
  e2eStaffUsername,
} from "./e2e-run";

const origin = "http://localhost:4000";
const adminPassword = process.env.AUTH_DEMO_ADMIN_PASSWORD ?? "";
const staffPassword = process.env.AUTH_DEMO_STAFF_PASSWORD ?? "";
const client = new Pool({
  connectionString: resolveDatabaseUrl(process.env.DATABASE_URL),
});

async function login(page: Page, role: "ADMIN" | "STAFF") {
  await page.goto("/login");
  await page.getByLabel("Username").fill(role === "ADMIN" ? e2eAdminUsername : e2eStaffUsername);
  await page.getByLabel("Password").fill(role === "ADMIN" ? adminPassword : staffPassword);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

function phonePayload(localDate: string, suffix: string) {
  return {
    localDate,
    serviceType: "DINNER" as const,
    arrivalTime: "19:00",
    partySize: 2,
    roomCode: "sala-1",
    customerFirstName: e2eReservationFirstName,
    customerLastName: `Notifications ${suffix}`,
    customerPhone: "+390000001212",
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
    notes: `M12 ${e2eRunId}`,
    verbalConsentConfirmed: true,
    sendWhatsAppConfirmation: true,
    capacityOverride: false,
    capacityOverrideReason: null,
  };
}

async function createPhoneViaApi(page: Page, date: string, suffix: string) {
  const response = await page.request.post("/api/staff/reservations", {
    headers: { origin, "Idempotency-Key": randomUUID() },
    data: phonePayload(date, suffix),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).reservation as { id: string; version: number };
}

function key(marker: string) {
  return createHash("sha256").update(`${e2eRunId}:${marker}`).digest("hex");
}

async function clearReservationNotifications(reservationId: string) {
  await client.query(
    `DELETE FROM notification_simulation_receipts
     WHERE restaurant_id = $1::uuid
       AND outbox_id IN (SELECT id FROM notification_outbox WHERE restaurant_id = $1::uuid AND reservation_id = $2::uuid)`,
    [e2eRestaurantId, reservationId],
  );
  await client.query(
    `DELETE FROM notification_attempts
     WHERE restaurant_id = $1::uuid
       AND outbox_id IN (SELECT id FROM notification_outbox WHERE restaurant_id = $1::uuid AND reservation_id = $2::uuid)`,
    [e2eRestaurantId, reservationId],
  );
  await client.query(
    "DELETE FROM notification_outbox WHERE restaurant_id = $1::uuid AND reservation_id = $2::uuid",
    [e2eRestaurantId, reservationId],
  );
}

async function insertTerminalOutbox(input: {
  reservationId: string;
  eventGroupId: string;
  reservationVersion: number;
  channel: "WHATSAPP" | "EMAIL";
  strategy: "WHATSAPP_ONLY" | "WHATSAPP_AND_EMAIL_PARALLEL";
  destination: string;
  payload: object;
  scheduledAt: Date;
  expiresAt: Date;
  status: "SUCCEEDED" | "DEAD";
  attemptCount: number;
  idempotencyKey: string;
  terminalAt: Date;
  terminalFailureCode: "SIMULATED_PERMANENT_FAILURE" | null;
}) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO notification_outbox (
       restaurant_id, reservation_id, event_group_id, reservation_version,
       event_type, source, channel, strategy, destination, payload_version,
       payload, scheduled_at, available_at, expires_at, status, attempt_count,
       max_attempts, retry_policy_version, idempotency_key,
       origin_correlation_id, terminal_at, terminal_failure_code, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, 'RESERVATION_CONFIRMED', 'PHONE',
       $5, $6, $7, 1, $8::jsonb, $9, $9, $10, $11, $12, 4, 1, $13,
       $14::uuid, $15, $16, CURRENT_TIMESTAMP
     ) RETURNING id`,
    [
      e2eRestaurantId,
      input.reservationId,
      input.eventGroupId,
      input.reservationVersion,
      input.channel,
      input.strategy,
      input.destination,
      JSON.stringify(input.payload),
      input.scheduledAt,
      input.expiresAt,
      input.status,
      input.attemptCount,
      input.idempotencyKey,
      randomUUID(),
      input.terminalAt,
      input.terminalFailureCode,
    ],
  );
  return result.rows[0]!.id;
}

test.describe.serial("M12 notification surfaces", () => {
  test.afterAll(async () => {
    await client.end();
  });

  test("phone create defaults WhatsApp confirmation on and submits explicit opt-out with clear UX", async ({ page }) => {
    await client.query(
      "UPDATE restaurant_notification_settings SET strategy = 'WHATSAPP_ONLY', updated_at = CURRENT_TIMESTAMP WHERE restaurant_id = $1::uuid",
      [e2eRestaurantId],
    );
    await login(page, "STAFF");
    await page.goto("/dashboard/reservations/new?date=2099-12-10");
    const checkbox = page.getByLabel("Invia conferma WhatsApp");
    await expect(checkbox).toBeChecked();
    await expect(page.getByText("Riguarda solo la conferma WhatsApp iniziale.")).toBeVisible();
    await expect(page.getByText(/I promemoria futuri restano previsti/)).toBeVisible();
    await expect(page.getByText(/l’email può partire in modo indipendente/)).toBeVisible();
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(checkbox).toBeVisible();
    }

    await page.getByLabel("Data").fill("2099-12-10");
    await page.getByLabel("Nome", { exact: true }).fill(e2eReservationFirstName);
    await page.getByLabel("Cognome").fill("Optout UI");
    await page.getByLabel("Telefono").fill("+390000001213");
    await page.getByLabel("Sala preferita (non garantita)").selectOption("sala-1");
    await expect(page.getByLabel("Slot configurato").locator("option[value='19:00']")).toHaveCount(1);
    await page.getByLabel("Slot configurato").selectOption("19:00");
    await checkbox.uncheck();
    await page.getByLabel(/Confermo di avere acquisito verbalmente/).check();
    const requestPromise = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/staff/reservations"));
    const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/api/staff/reservations"));
    await page.getByRole("button", { name: "Salva prenotazione telefonica" }).click();
    const submitted = await requestPromise;
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    expect(submitted.postDataJSON()).toMatchObject({ sendWhatsAppConfirmation: false });
    await expect(page.getByText("Prenotazione telefonica salvata e capacità aggiornata.")).toBeVisible();
  });

  test("Admin changes and persists strategy, while Staff cannot access the panel", async ({ browser }) => {
    const adminContext = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const adminPage = await adminContext.newPage();
    await login(adminPage, "ADMIN");
    await adminPage.goto("/admin/notification-settings");
    await expect(adminPage.getByRole("heading", { name: "Strategia notifiche" })).toBeVisible();
    await adminPage.getByLabel("WhatsApp + email in parallelo").check();
    await adminPage.getByRole("button", { name: "Salva strategia" }).click();
    await expect(adminPage.getByText("Strategia salvata per i nuovi eventi.")).toBeVisible();
    await adminPage.reload();
    await expect(adminPage.getByLabel("WhatsApp + email in parallelo")).toBeChecked();
    await adminPage.getByRole("button", { name: "Salva strategia" }).click();
    await expect(adminPage.getByText("La strategia era già impostata.")).toBeVisible();
    for (const width of [390, 820, 1440]) {
      await adminPage.setViewportSize({ width, height: 900 });
      await expect(adminPage.getByRole("button", { name: "Salva strategia" })).toBeVisible();
    }
    await adminPage.getByLabel("Solo WhatsApp").check();
    await adminPage.getByRole("button", { name: "Salva strategia" }).click();
    await adminContext.close();

    const staffContext = await browser.newContext();
    const staffPage = await staffContext.newPage();
    await login(staffPage, "STAFF");
    await staffPage.goto("/admin/notification-settings");
    await expect(staffPage).toHaveURL(/\/dashboard\?access=denied/);
    await staffContext.close();
  });

  test("dashboard shows permanent and partial warnings without delivery internals", async ({ page }) => {
    const date = "2099-12-11";
    await login(page, "STAFF");
    const permanent = await createPhoneViaApi(page, date, "Permanent");
    const partial = await createPhoneViaApi(page, date, "Partial");
    await clearReservationNotifications(permanent.id);
    await clearReservationNotifications(partial.id);
    const payload = {
      schemaVersion: 1,
      templateKey: "RESERVATION_CONFIRMED",
      templateVersion: 1,
      locale: "IT",
      params: {
        customerFirstName: e2eReservationFirstName,
        restaurantName: "E2E",
        localDate: date,
        serviceType: "DINNER",
        arrivalTime: "19:00",
        partySize: 2,
      },
    } as const;
    const scheduledAt = new Date("2099-12-11T10:00:00.000Z");
    const terminalAt = new Date("2099-12-11T10:01:00.000Z");
    const expiresAt = new Date("2099-12-12T10:00:00.000Z");
    const partialGroup = randomUUID();
    const succeededId = await insertTerminalOutbox({
      reservationId: partial.id,
      eventGroupId: partialGroup,
      reservationVersion: partial.version,
      channel: "WHATSAPP",
      strategy: "WHATSAPP_AND_EMAIL_PARALLEL",
      destination: "+390000009999",
      payload,
      scheduledAt,
      expiresAt,
      status: "SUCCEEDED",
      attemptCount: 1,
      idempotencyKey: key("partial-wa"),
      terminalAt,
      terminalFailureCode: null,
    });
    await client.query(
      `INSERT INTO notification_attempts (
         restaurant_id, outbox_id, attempt_number, provider_kind,
         attempt_correlation_id, started_at, completed_at, outcome,
         provider_reference, deduplicated
       ) VALUES ($1::uuid, $2::uuid, 1, 'SIMULATED_WHATSAPP', $3::uuid, $4, $5, 'SUCCESS', $6, false)`,
      [
        e2eRestaurantId,
        succeededId,
        randomUUID(),
        scheduledAt,
        terminalAt,
        "M12-PROVIDER-REFERENCE-MUST-NOT-RENDER",
      ],
    );
    await insertTerminalOutbox({
      reservationId: permanent.id,
      eventGroupId: randomUUID(),
      reservationVersion: permanent.version,
      channel: "WHATSAPP",
      strategy: "WHATSAPP_ONLY",
      destination: "+390000008888",
      payload,
      scheduledAt,
      expiresAt,
      status: "DEAD",
      attemptCount: 0,
      idempotencyKey: key("permanent-wa"),
      terminalAt,
      terminalFailureCode: "SIMULATED_PERMANENT_FAILURE",
    });
    await insertTerminalOutbox({
      reservationId: partial.id,
      eventGroupId: partialGroup,
      reservationVersion: partial.version,
      channel: "EMAIL",
      strategy: "WHATSAPP_AND_EMAIL_PARALLEL",
      destination: "M12-DESTINATION-MUST-NOT-RENDER@example.invalid",
      payload,
      scheduledAt,
      expiresAt,
      status: "DEAD",
      attemptCount: 0,
      idempotencyKey: key("partial-email"),
      terminalAt,
      terminalFailureCode: "SIMULATED_PERMANENT_FAILURE",
    });

    await page.goto(`/dashboard?date=${date}`);
    await expect(page.getByText("Notifica non consegnata", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Notifica consegnata soltanto su un canale", { exact: true })).toHaveCount(1);
    await expect(page.getByText("M12-PROVIDER-REFERENCE-MUST-NOT-RENDER")).toHaveCount(0);
    await expect(page.getByText("M12-DESTINATION-MUST-NOT-RENDER@example.invalid")).toHaveCount(0);
  });
});
