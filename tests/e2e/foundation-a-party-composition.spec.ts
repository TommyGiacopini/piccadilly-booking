import "dotenv/config";
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { e2eReservationFirstName, e2eRestaurantId, e2eRunId, e2eStaffUsername } from "./e2e-run";

const database = new Pool({ connectionString: process.env.DATABASE_URL });
test.afterAll(async () => database.end());
const totalLabel = "In quanti siete? (coperti totali)";
const gamesLabel = "Preferite un tavolo nella Sala con i Giochi?";
const day = "2099-10-25";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(e2eStaffUsername);
  await page.getByLabel("Password", { exact: true }).fill(process.env.AUTH_DEMO_STAFF_PASSWORD!);
  await page.getByRole("button", { name: "Accedi", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard/u);
}

async function fillPublic(page: Page, suffix: string) {
  await page.goto("/prenota");
  await page.getByLabel("Data", { exact: true }).fill(day);
  await page.getByLabel(totalLabel).fill("6");
  await expect(page.getByLabel("Orario disponibile").locator("option[value='19:00']")).toHaveCount(1);
  await page.getByLabel("Orario disponibile").selectOption("19:00");
  await page.getByLabel("Nome", { exact: true }).fill(e2eReservationFirstName);
  await page.getByLabel("Cognome", { exact: true }).fill(`Foundation ${suffix} ${e2eRunId}`);
  await page.getByLabel("Telefono", { exact: true }).fill("+390000009515");
  await page.getByLabel(/Accetto l.informativa privacy/u).check();
  await page.getByLabel(/Accetto le condizioni di prenotazione/u).check();
  await expect(page.locator('select[name="roomCode"]')).toHaveCount(0);
}

async function stored(suffix: string) {
  const result = await database.query("SELECT id,version,party_size,children_count,game_room_preference,preferences,allergies,arrived_at FROM reservations WHERE restaurant_id=$1 AND customer_first_name=$2 AND customer_last_name=$3", [e2eRestaurantId, e2eReservationFirstName, `Foundation ${suffix} ${e2eRunId}`]);
  expect(result.rowCount).toBe(1);
  return result.rows[0];
}

async function submitPublic(page: Page) {
  const response = page.waitForResponse((candidate) => candidate.request().method() === "POST" && new URL(candidate.url()).pathname === "/api/public/reservations");
  await page.getByRole("button", { name: "Conferma prenotazione", exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(page.getByRole("link", { name: "Apri il tuo link personale" })).toBeVisible();
}

test.describe("Foundation A party composition", () => {
  for (const scenario of [
    { suffix: "adults", count: 0, games: null },
    { suffix: "games-yes", count: 2, games: true },
    { suffix: "games-no", count: 2, games: false },
  ]) {
    test(`Public ${scenario.suffix} persists explicit composition without a physical room`, async ({ page }) => {
      await fillPublic(page, scenario.suffix);
      if (scenario.count === 0) {
        await page.getByRole("radio", { name: "No, siamo tutti adulti", exact: true }).check();
        await expect(page.getByRole("group", { name: gamesLabel, exact: true })).toHaveCount(0);
      } else {
        await page.getByRole("radio", { name: "Sì, ci sono bambini", exact: true }).check();
        await page.getByLabel("Quanti bambini ci sono?", { exact: true }).fill("2");
        await page.getByRole("group", { name: gamesLabel, exact: true }).getByRole("radio", { name: scenario.games ? "Sì" : "No", exact: true }).check();
        await expect(page.getByRole("status").filter({ hasText: "2 su 6 coperti" })).toBeVisible();
        await expect(page.getByText(/La richiesta per la Sala con i Giochi non è garantita/u)).toBeVisible();
      }
      if (scenario.suffix === "games-no") {
        await page.getByLabel("Allergie (facoltative)", { exact: true }).fill('"'.repeat(300));
        await page.getByLabel("Intolleranze (facoltative)", { exact: true }).fill("\\".repeat(300));
      }
      await submitPublic(page);
      expect(await stored(scenario.suffix)).toMatchObject({ party_size: 6, children_count: scenario.count, game_room_preference: scenario.games, arrived_at: null });
      const row = await stored(scenario.suffix);
      if (scenario.suffix === "games-no") {
        expect(row.allergies).toHaveLength(1249);
        expect(JSON.parse(row.allergies)).toMatchObject({ allergies: '"'.repeat(300), intolerances: "\\".repeat(300) });
      }
      expect(JSON.parse(row.preferences).roomCode).toBe("");
      const audits = await database.query("SELECT action,new_state FROM reservation_audit_events WHERE restaurant_id=$1 AND reservation_id=$2", [e2eRestaurantId, row.id]);
      expect(audits.rows).toEqual([{ action: "CREATED", new_state: expect.objectContaining({ childrenCount: scenario.count, gameRoomPreference: scenario.games }) }]);
      await page.getByRole("link", { name: "Apri il tuo link personale" }).click();
      await expect(page.getByRole("heading", { name: "Gestisci la prenotazione dimostrativa" })).toBeVisible();
      await expect(page.locator('[data-party-composition]')).toBeVisible();
      await expect(page.getByLabel(totalLabel)).toHaveValue("6");
      await expect(page.locator('select[name="roomCode"]')).toHaveCount(0);
      if (scenario.games === true) {
        await page.getByRole("group", { name: gamesLabel }).getByRole("radio", { name: "No", exact: true }).check();
        const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.startsWith("/api/public/reservations/"));
        await page.getByRole("button", { name: "Salva modifiche", exact: true }).click();
        expect((await saved).status()).toBe(200);
        expect(await stored(scenario.suffix)).toMatchObject({ children_count: 2, game_room_preference: false, version: row.version + 1 });
      }
    });
  }

  test("invalid count blocks submission, switching clears hidden state, and reflow/keyboard remain usable", async ({ page }, testInfo) => {
    await fillPublic(page, "switch");
    await page.getByRole("radio", { name: "Sì, ci sono bambini", exact: true }).check();
    const count = page.getByLabel("Quanti bambini ci sono?", { exact: true });
    await count.fill("7");
    await page.getByRole("group", { name: gamesLabel }).getByRole("radio", { name: "Sì", exact: true }).check();
    await expect(count).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert").filter({ hasText: "Il numero di bambini" })).toBeVisible();
    let requests = 0;
    page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/public/reservations") requests += 1; });
    await page.getByRole("button", { name: "Conferma prenotazione", exact: true }).click();
    expect(requests).toBe(0);
    await page.getByRole("radio", { name: "No, siamo tutti adulti", exact: true }).check();
    await expect(count).toHaveCount(0);
    await expect(page.getByRole("group", { name: gamesLabel })).toHaveCount(0);
    await page.getByRole("radio", { name: "Sì, ci sono bambini", exact: true }).check();
    await expect(count).toHaveValue("");
    await expect(page.getByRole("group", { name: gamesLabel }).getByRole("radio", { checked: true })).toHaveCount(0);
    await count.fill("2");
    await page.getByRole("group", { name: gamesLabel }).getByRole("radio", { name: "No", exact: true }).check();
    await page.getByLabel(totalLabel).fill("1");
    await expect(count).toHaveValue("2");
    await expect(count).toHaveAttribute("aria-invalid", "true");
    await page.getByLabel(totalLabel).fill("6");
    const metrics = [];
    for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      metrics.push(await page.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth })));
      await page.screenshot({ path: testInfo.outputPath(`foundation-public-${viewport.width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 640, height: 900 });
    // 1280px desktop at 200% browser zoom reflows into a 640 CSS-pixel viewport.
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const zoomMetrics = await page.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    const metricsPath = testInfo.outputPath("foundation-responsive-metrics.json");
    writeFileSync(metricsPath, JSON.stringify({ metrics, zoom200: { method: "1280 physical pixels / 200% = 640 CSS pixels", ...zoomMetrics } }, null, 2));
    await testInfo.attach("responsive-metrics", { path: metricsPath, contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath("foundation-public-zoom200.png"), fullPage: true });
    await page.getByRole("button", { name: "EN", exact: true }).click();
    await expect(page.getByRole("group", { name: "Are there children?" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Would you prefer a table in the Room with Games?" })).toBeVisible();
    await expect(page.getByText("The request for the Room with Games is not guaranteed. Where possible, we will give priority to requests in booking order.")).toBeVisible();
    await page.getByRole("button", { name: "IT", exact: true }).click();
    const adults = page.getByRole("radio", { name: "No, siamo tutti adulti", exact: true });
    await adults.focus();
    await page.keyboard.press("Space");
    await expect(adults).toBeChecked();
    expect(await adults.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
    const targets = await page.locator('[data-party-composition] label').evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().height));
    expect(targets.every((height) => height >= 44)).toBe(true);
    await submitPublic(page);
    expect(requests).toBe(1);
    expect(await stored("switch")).toMatchObject({ children_count: 0, game_room_preference: null });
  });

  test("legacy management preserves unknown and requires a fresh declaration for a new total", async ({ page }, testInfo) => {
    await fillPublic(page, "legacy");
    await page.getByRole("radio", { name: "No, siamo tutti adulti", exact: true }).check();
    await submitPublic(page);
    const row = await stored("legacy");
    const legacyText = "Preferenza storica sintetica Management — città\nSeconda riga".padEnd(1000, "P");
    const originalPreferences = legacyText;
    const legacy = await database.query("UPDATE reservations SET children_count=NULL,game_room_preference=NULL,preferences=$4,allergies=$5 WHERE id=$1 AND restaurant_id=$2 AND customer_first_name=$3", [row.id, e2eRestaurantId, e2eReservationFirstName, originalPreferences, "H".repeat(1000)]);
    expect(legacy.rowCount).toBe(1);
    await page.getByRole("link", { name: "Apri il tuo link personale" }).click();
    await expect(page.getByRole("radio", { name: "Non specificato", exact: true })).toBeChecked();
    await page.getByLabel("Note", { exact: true }).fill("Nota legacy sintetica Foundation");
    const first = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.startsWith("/api/public/reservations/"));
    await page.getByRole("button", { name: "Salva modifiche", exact: true }).click();
    const firstResponse = await first;
    expect(firstResponse.status()).toBe(200);
    expect(firstResponse.request().postDataJSON()).not.toHaveProperty("legacyText");
    expect(await stored("legacy")).toMatchObject({ children_count: null, game_room_preference: null, version: row.version + 1 });
    expect((await stored("legacy")).preferences).toBe(originalPreferences);
    expect((await stored("legacy")).allergies).toBe("H".repeat(1000));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("foundation-management-390.png"), fullPage: true });
    await page.getByLabel(totalLabel).fill("5");
    await expect(page.getByRole("radio", { name: "Non specificato", exact: true })).toHaveCount(0);
    expect(await page.locator("form").evaluate((form) => (form as HTMLFormElement).checkValidity())).toBe(false);
    await page.getByRole("radio", { name: "Sì, ci sono bambini", exact: true }).check();
    await page.getByLabel("Quanti bambini ci sono?", { exact: true }).fill("1");
    await page.getByRole("group", { name: gamesLabel }).getByRole("radio", { name: "Sì", exact: true }).check();
    await page.getByLabel("Allergie", { exact: true }).fill('"'.repeat(300));
    await page.getByLabel("Intolleranze", { exact: true }).fill("\\".repeat(300));
    const second = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.startsWith("/api/public/reservations/"));
    await page.getByRole("button", { name: "Salva modifiche", exact: true }).click();
    expect((await second).status()).toBe(200);
    expect(await stored("legacy")).toMatchObject({ party_size: 5, children_count: 1, game_room_preference: true, version: row.version + 2 });
    expect(JSON.parse((await stored("legacy")).preferences)).toMatchObject({ children: true, roomCode: "", legacyText });
    expect(JSON.parse((await stored("legacy")).allergies)).toMatchObject({ allergies: '"'.repeat(300), intolerances: "\\".repeat(300), legacyText: "H".repeat(1000) });
    expect(await database.query("SELECT 1 FROM reservation_assignments WHERE restaurant_id=$1 AND reservation_id=$2", [e2eRestaurantId, row.id])).toMatchObject({ rowCount: 0 });
  });

  test("PHONE unknown is explicit and Staff edit requires declaration when changing legacy group size", async ({ page }, testInfo) => {
    await login(page);
    const phoneDay = "2099-10-26";
    await page.goto(`/dashboard/reservations/new?date=${phoneDay}`);
    await page.getByLabel(totalLabel).fill("6");
    await page.getByLabel("Slot configurato").selectOption("19:00");
    await page.getByLabel("Nome", { exact: true }).fill(e2eReservationFirstName);
    await page.getByLabel("Cognome", { exact: true }).fill(`Foundation phone ${e2eRunId}`);
    await page.getByLabel("Telefono", { exact: true }).fill("+390000009515");
    await page.getByRole("radio", { name: "Non specificato", exact: true }).check();
    await expect(page.locator('select[name="roomCode"]')).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 640 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("foundation-phone-320.png"), fullPage: true });
    await page.getByLabel(/Confermo di avere acquisito verbalmente/u).check();
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/staff/reservations");
    await page.getByRole("button", { name: "Salva prenotazione telefonica" }).click();
    expect((await created).status()).toBe(201);
    const row = await stored("phone");
    expect(row).toMatchObject({ children_count: null, game_room_preference: null });
    const legacyText = "Preferenza storica sintetica Staff — città\nSeconda riga".padEnd(1000, "P");
    const legacyAllergy = "H".repeat(1000);
    expect(await database.query("UPDATE reservations SET preferences=$4,allergies=$5 WHERE id=$1 AND restaurant_id=$2 AND customer_first_name=$3", [row.id, e2eRestaurantId, e2eReservationFirstName, legacyText, legacyAllergy])).toMatchObject({ rowCount: 1 });
    await page.goto(`/dashboard/reservations/${row.id}/edit`);
    const history = page.getByRole("region", { name: "Allergia storica", exact: true });
    await expect(history).toContainText("Sola lettura");
    await expect(history.locator("p").first()).toHaveText(legacyAllergy);
    await expect(history.locator("input,textarea")).toHaveCount(0);
    await expect(page.getByLabel("Allergie dichiarate", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("Allergie dichiarate", { exact: true })).toHaveAttribute("maxlength", "300");
    expect(await page.locator("form").filter({ has: page.getByLabel("Allergie dichiarate", { exact: true }) }).evaluate((form) => Array.from(new FormData(form as HTMLFormElement).values()).includes("H".repeat(1000)))).toBe(false);
    const beforeSave = (await database.query("SELECT allergies,version,updated_at,(SELECT count(*)::int FROM reservation_audit_events WHERE reservation_id=$1) AS audits FROM reservations WHERE id=$1", [row.id])).rows[0];
    const noop = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/staff/reservations/${row.id}`);
    await page.getByRole("button", { name: "Salva modifiche", exact: true }).click();
    const noopResponse = await noop;
    expect(noopResponse.status()).toBe(200);
    expect((await noopResponse.json()).changed).toBe(false);
    expect(noopResponse.request().postDataJSON()).toMatchObject({ allergies: "", intolerances: "" });
    expect(noopResponse.request().postDataJSON()).not.toHaveProperty("legacyAllergy");
    expect(JSON.stringify(noopResponse.request().postDataJSON())).not.toContain(legacyAllergy);
    expect((await database.query("SELECT allergies,version,updated_at,(SELECT count(*)::int FROM reservation_audit_events WHERE reservation_id=$1) AS audits FROM reservations WHERE id=$1", [row.id])).rows[0]).toEqual(beforeSave);
    await expect(page.getByText(/Preferenza storica: Preferenza storica sintetica Staff/u)).toBeVisible();
    await expect(page.getByRole("radio", { name: "Non specificato", exact: true })).toBeChecked();
    await page.getByLabel("Note", { exact: true }).fill("Nota Foundation sintetica aggiornata");
    const noteResponsePromise = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/staff/reservations/${row.id}`);
    await page.getByRole("button", { name: "Salva modifiche", exact: true }).click();
    const noteResponse = await noteResponsePromise;
    expect(noteResponse.status()).toBe(200);
    const notePayload = noteResponse.request().postDataJSON();
    expect(notePayload.allergies).toBe("");
    expect(notePayload).not.toHaveProperty("legacyAllergy");
    expect(notePayload).not.toHaveProperty("legacyText");
    expect(JSON.stringify(notePayload)).not.toContain(legacyAllergy);
    await expect(page.getByRole("status").filter({ hasText: "Prenotazione aggiornata" })).toBeVisible();
    expect(await stored("phone")).toMatchObject({ children_count: null, game_room_preference: null, version: row.version + 1 });
    expect((await stored("phone")).preferences).toBe(legacyText);
    expect((await stored("phone")).allergies).toBe(legacyAllergy);
    await page.reload();
    await expect(history.locator("p").first()).toHaveText(legacyAllergy);
    await expect(page.getByLabel("Allergie dichiarate", { exact: true })).toHaveValue("");
    await expect(page.locator('textarea[name="notes"]')).toHaveValue("Nota Foundation sintetica aggiornata");
    const allergyMetrics = [];
    for (const viewport of [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 640, height: 450 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(history.locator("p").first()).toHaveText(legacyAllergy);
      const metrics = await history.evaluate((element) => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth, textLength: element.querySelector("p")?.textContent?.length, overflowWrap: getComputedStyle(element).overflowWrap }));
      expect(metrics.textLength).toBe(1000);
      expect(metrics.overflowWrap).toBe("anywhere");
      allergyMetrics.push({ ...viewport, ...metrics, zoomEquivalent: viewport.width === 640 ? "200% of 1280px desktop, CSS reflow equivalent" : null });
      await page.screenshot({ path: testInfo.outputPath(`foundation-legacy-allergy-${viewport.width}.png`), fullPage: true });
    }
    const allergyProofPath = testInfo.outputPath("foundation-legacy-allergy-proof.json");
    writeFileSync(allergyProofPath, JSON.stringify({ historyLength: 1000, editableAllergyEmpty: true, historyInFormData: false, requests: [noopResponse, noteResponse].map((response) => ({ status: response.status(), payload: response.request().postDataJSON() })), neutralSaveChanged: false, rawPersistedUnchanged: true, metrics: allergyMetrics }, null, 2));
    await testInfo.attach("legacy-allergy-proof", { path: allergyProofPath, contentType: "application/json" });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.getByLabel(totalLabel).fill("7");
    await expect(page.getByRole("radio", { name: "Non specificato", exact: true })).toHaveCount(0);
    await page.getByRole("radio", { name: "Sì, ci sono bambini", exact: true }).check();
    await page.getByLabel("Quanti bambini ci sono?", { exact: true }).fill("2");
    await page.getByRole("group", { name: gamesLabel }).getByRole("radio", { name: "Sì", exact: true }).check();
    const boundaryMetrics = await page.evaluate(() => ({
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overflowingElements: Array.from(document.querySelectorAll("body *"))
        .filter((element) => element.getBoundingClientRect().right > innerWidth || element.scrollWidth > element.clientWidth)
        .map((element) => {
          const style = getComputedStyle(element);
          const parent = element.parentElement;
          return {
            tag: element.tagName,
            className: element.className,
            width: style.width,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            minWidth: style.minWidth,
            maxWidth: style.maxWidth,
            whiteSpace: style.whiteSpace,
            overflow: style.overflow,
            overflowWrap: style.overflowWrap,
            wordBreak: style.wordBreak,
            parentDisplay: parent ? getComputedStyle(parent).display : null,
            textLength: element.textContent?.length ?? 0,
            containsLegacyPreference: element.textContent?.includes("Preferenza storica sintetica Staff") ?? false,
          };
        }),
    }));
    const boundaryMetricsPath = testInfo.outputPath("foundation-staff-storage-boundary-metrics.json");
    writeFileSync(boundaryMetricsPath, JSON.stringify(boundaryMetrics, null, 2));
    await testInfo.attach("staff-storage-boundary-metrics", { path: boundaryMetricsPath, contentType: "application/json" });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("foundation-staff-edit-320.png"), fullPage: true });
    await page.getByRole("button", { name: "Salva modifiche", exact: true }).click();
    await expect.poll(async () => (await stored("phone")).version).toBe(row.version + 2);
    expect(JSON.parse((await stored("phone")).preferences).legacyText).toBe(legacyText);
    expect((await stored("phone")).allergies).toBe(legacyAllergy);
    await page.reload();
    await expect(history.locator("p").first()).toHaveText(legacyAllergy);
    await expect(page.getByLabel("Allergie dichiarate", { exact: true })).toHaveValue("");
    await page.getByLabel("Allergie dichiarate", { exact: true }).fill("Arachidi");
    await page.getByRole("button", { name: "Salva modifiche", exact: true }).click();
    await expect.poll(async () => (await stored("phone")).version).toBe(row.version + 3);
    expect(JSON.parse((await stored("phone")).allergies)).toMatchObject({ allergies: "Arachidi", legacyText: legacyAllergy });
    await page.reload();
    await expect(page.locator('textarea[name="allergies"]')).toHaveValue("Arachidi");
    await expect(history.locator("p").first()).toHaveText(legacyAllergy);
    await page.goto(`/dashboard?date=${phoneDay}&service=DINNER`);
    const card = page.locator(`article[data-reservation-id="${row.id}"]`);
    await expect(card).toContainText("7 coperti · 2 bambini");
    await expect(card).toContainText("SALA GIOCHI RICHIESTA");
    await expect(card.getByTestId("unassigned-badge")).toHaveText("DA ASSEGNARE");
    expect(await stored("phone")).toMatchObject({ arrived_at: null, game_room_preference: true });
  });
});
