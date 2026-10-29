import "dotenv/config";
import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { e2eReservationFirstName, e2eRestaurantId, e2eRunId } from "./e2e-run";

const target = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname)) throw new Error("T08_TEMPORARY_DATABASE_REQUIRED");
const database = new Pool({ connectionString: process.env.DATABASE_URL });
test.afterAll(async () => database.end());
// Each case starts with a fresh quota in this run-owned temporary tenant.
// The production limits and the canonical rate-limit tests remain unchanged.
test.beforeEach(async () => { await database.query("DELETE FROM public_reservation_rate_limits WHERE restaurant_id=$1", [e2eRestaurantId]); });
const day = "2099-11-18";
const section = (page: Page, number: number) => page.locator("section[aria-labelledby=booking-section-" + number + "]");
async function chooseTime(page: Page, english = false) {
  const preview = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/public/availability");
  await page.getByLabel(english ? "Date" : "Data", { exact: true }).fill(day);
  const available = await preview;
  expect(available.status()).toBe(200);
  const result = await available.json();
  expect(result.isOpen).toBe(true);
  expect(result.slots.some((slot: { time: string; available: boolean }) => slot.time === "19:00" && slot.available)).toBe(true);
  const slot = page.getByLabel(english ? "Available time" : "Orario disponibile", { exact: true });
  await expect(slot.locator("option[value='19:00']")).toHaveCount(1);
  await slot.selectOption("19:00");
  await section(page, 1).getByRole("button", { name: english ? "Continue" : "Continua", exact: true }).click();
}
async function chooseParty(page: Page, count = 0, games = false, english = false) {
  await page.getByRole("radio", { name: count ? english ? "Yes, there are children" : "Sì, ci sono bambini" : english ? "No, we are all adults" : "No, siamo tutti adulti", exact: true }).check();
  if (count) {
    await page.getByLabel(english ? "How many children are there?" : "Quanti bambini ci sono?", { exact: true }).fill(String(count));
    await page.getByRole("group", { name: english ? "Would you prefer a table in the Room with Games?" : "Preferite un tavolo nella Sala con i Giochi?", exact: true })
      .getByRole("radio", { name: games ? english ? "Yes" : "Sì" : "No", exact: true }).check();
  }
  await section(page, 2).getByRole("button", { name: english ? "Continue" : "Continua", exact: true }).click();
}
async function contacts(page: Page, suffix: string, english = false) {
  await page.getByLabel(english ? "First name" : "Nome", { exact: true }).fill(e2eReservationFirstName);
  await page.getByLabel(english ? "Last name" : "Cognome", { exact: true }).fill("T08 " + suffix + " " + e2eRunId);
  await page.getByLabel(english ? "Phone" : "Telefono", { exact: true }).fill("+390000000808");
  await page.getByLabel(english ? /I accept the technical demo privacy/ : /Accetto l.informativa privacy/u).check();
  await page.getByLabel(english ? /I accept the technical demo booking/ : /Accetto le condizioni/u).check();
}
async function fill(page: Page, suffix = "synthetic") {
  await page.goto("/prenota"); await chooseTime(page); await chooseParty(page); await contacts(page, suffix);
}
const body = (time = "19:00") => ({ isOpen: true, slots: [{ time, available: true }] });

for (const language of ["it", "en"] as const) for (const scenario of [{ count: 0, games: false }, { count: 1, games: true }, { count: 1, games: false }]) {
  test("E01 real Public " + language + " children=" + scenario.count + " games=" + scenario.games, async ({ page }) => {
    const english = language === "en";
    const suffix = language + "-" + scenario.count + "-" + scenario.games;
    await page.goto("/prenota?lang=" + language);
    await chooseTime(page, english); await chooseParty(page, scenario.count, scenario.games, english); await contacts(page, suffix, english);
    await page.getByLabel(english ? "Notes (optional)" : "Note (facoltative)", { exact: true }).fill("T08_NC_MARKER");
    await expect(page.getByRole("region", { name: english ? "Booking summary" : "Riepilogo della prenotazione", exact: true })).toContainText("19:00");
    const completed = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/public/reservations");
    await page.getByRole("button", { name: english ? "Confirm booking" : "Conferma prenotazione", exact: true }).click();
    const response = await completed;
    expect(response.status()).toBe(201);
    const submitted = response.request().postDataJSON();
    expect(submitted).toMatchObject({ childrenCount: scenario.count, gameRoomPreference: scenario.count ? scenario.games : null, notes: "T08_NC_MARKER", language });
    for (const field of ["roomCode", "children", "privateNotes", "tenantId", "version"]) expect(submitted).not.toHaveProperty(field);
    const saved = await database.query("SELECT id,party_size,children_count,game_room_preference,notes,private_notes FROM reservations WHERE restaurant_id=$1 AND customer_first_name=$2 AND customer_last_name=$3", [e2eRestaurantId, e2eReservationFirstName, "T08 " + suffix + " " + e2eRunId]);
    expect(saved.rowCount).toBe(1);
    expect(saved.rows[0]).toMatchObject({ party_size: 2, children_count: scenario.count, game_room_preference: scenario.count ? scenario.games : null, notes: "T08_NC_MARKER", private_notes: null });
    expect((await database.query("SELECT 1 FROM reservation_assignments WHERE reservation_id=$1", [saved.rows[0].id])).rowCount).toBe(0);
    await database.query("UPDATE reservations SET private_notes=$2 WHERE id=$1", [saved.rows[0].id, "T08_NI_PRIVATE_MARKER"]);
    const link = page.getByRole("link", { name: english ? "Open your personal link" : "Apri il tuo link personale", exact: true });
    await expect(link).toHaveAttribute("href", new RegExp("\\?lang=" + language + "$"));
    await link.click();
    await expect(page.getByRole("textbox", { name: "Note", exact: true }).or(page.getByRole("textbox", { name: "Notes", exact: true }))).toHaveValue("T08_NC_MARKER");
    await expect(page.getByText(/T08_NI_PRIVATE_MARKER/)).toHaveCount(0);
    const endpoint = "/api/public/reservations/" + new URL(page.url()).pathname.split("/").at(-1);
    const dto = await page.request.get(endpoint);
    expect(JSON.stringify(await dto.json())).not.toContain("T08_NI_PRIVATE_MARKER");
    const cancelled = await page.request.delete(endpoint, { headers: { origin: "http://localhost:4000" }, data: {} });
    expect(cancelled.ok()).toBe(true);
  });
}

test("E02 loading, obsolete query, invalidation and language do not reuse stale slots", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  await page.route("**/api/public/availability?**", async route => {
    ++calls;
    if (calls === 1) { await held; await route.fulfill({ json: body("19:00") }).catch(() => undefined); }
    else await route.fulfill({ json: body("20:00") });
  });
  await page.goto("/prenota"); await page.getByLabel("Data", { exact: true }).fill(day);
  await expect(page.locator("[data-availability-state]")).toHaveAttribute("data-availability-state", "LOADING");
  await expect(section(page, 1).getByRole("button", { name: "Continua", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  expect(calls).toBe(1);
  await page.getByLabel("How many are you? (total covers)", { exact: true }).fill("3");
  await expect(page.getByLabel("Available time").locator("option[value='20:00']")).toHaveCount(1);
  release();
  await expect(page.getByLabel("Available time").locator("option[value='19:00']")).toHaveCount(0);
  await page.getByLabel("Available time").selectOption("20:00");
  await page.getByLabel("Date", { exact: true }).fill("");
  await expect(page.getByLabel("Available time")).toHaveValue("");
  await expect(page.getByLabel("Available time")).toBeDisabled();
  await section(page, 1).getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator("#booking-errors")).toBeVisible();
  await expect(page.locator("#booking-localDate")).toBeFocused();
  await expect(section(page, 3)).toHaveCount(0);
});
for (const mode of ["EMPTY", "NETWORK", "HTTP", "MALFORMED"] as const) test("E02 " + mode + " is explicit; retry is manual", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/public/availability?**", async route => {
    if (++calls > 1) return route.fulfill({ json: body() });
    if (mode === "NETWORK") return route.abort("failed");
    if (mode === "HTTP") return route.fulfill({ status: 500, json: { error: "Synthetic" } });
    return route.fulfill({ json: mode === "EMPTY" ? { isOpen: false, slots: [] } : {} });
  });
  await page.goto("/prenota"); await page.getByLabel("Data", { exact: true }).fill(day);
  await expect(page.locator("[data-availability-state]")).toHaveAttribute("data-availability-state", mode === "EMPTY" ? "EMPTY" : "ERROR");
  await expect(page.getByLabel("Orario disponibile")).toBeDisabled();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  expect(calls).toBe(1);
  if (mode === "EMPTY") { await expect(page.getByText("No available times", { exact: true })).toBeVisible(); }
  else { await page.getByRole("button", { name: "Try again", exact: true }).click(); await expect(page.getByLabel("Available time")).toBeEnabled(); expect(calls).toBe(2); }
});

test("E03 early Notes, canonical errors, responsive keyboard and retained values", async ({ page }, info) => {
  await page.goto("/prenota");
  await page.getByRole("button", { name: "Scrivi una nota", exact: true }).click();
  const notes = page.getByLabel("Note (facoltative)", { exact: true });
  await expect(notes).toBeFocused(); await notes.fill("T08_EARLY_NOTES");
  await section(page, 2).getByRole("button", { name: "Continua", exact: true }).click();
  await expect(page.locator("#booking-localDate")).toBeFocused();
  await expect(section(page, 3)).toHaveCount(0);
  await chooseTime(page);
  await page.getByRole("radio", { name: "Sì, ci sono bambini", exact: true }).check();
  const count = page.locator('input[name="childrenCount"]');
  await section(page, 2).getByRole("button", { name: "Continua", exact: true }).click();
  await expect(section(page, 3)).toHaveCount(0);
  await expect(count).toBeFocused();
  await count.fill("3");
  await section(page, 2).getByRole("button", { name: "Continua", exact: true }).click();
  await expect(count).toBeFocused(); await expect(count).toHaveAttribute("aria-invalid", "true");
  await count.fill("1");
  await page.getByRole("group", { name: "Preferite un tavolo nella Sala con i Giochi?", exact: true }).getByRole("radio", { name: "No", exact: true }).check();
  await section(page, 2).getByRole("button", { name: "Continua", exact: true }).click();
  await contacts(page, "responsive");
  await page.getByLabel("Cognome", { exact: true }).fill("T".repeat(80));
  await notes.fill("T08_EARLY_NOTES " + "N".repeat(950));
  const metrics = [];
  for (const width of [320, 390, 820, 1280, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(notes).toHaveValue("T08_EARLY_NOTES " + "N".repeat(950));
    metrics.push(await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })));
    await page.screenshot({ path: info.outputPath("public-" + width + ".png"), fullPage: true });
  }
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByLabel("Notes (optional)", { exact: true })).toHaveValue("T08_EARLY_NOTES " + "N".repeat(950));
  await expect(count).toHaveValue("1");
  const activeLanguage = page.getByRole("button", { name: "EN", exact: true });
  const contrast = await activeLanguage.evaluate(element => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const parts = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3).map(n => { const c = n / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
      return parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722;
    };
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  const persistence = await page.evaluate(() => JSON.stringify({ url: location.href, history: history.state, local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(persistence).not.toContain("T08_EARLY_NOTES");
  const engineeringPath = info.outputPath("public-engineering-metrics.json");
  writeFileSync(engineeringPath, JSON.stringify({ browser: page.context().browser()?.version(), viewports: metrics, activeLanguageContrast: contrast, markerInPersistentLocations: false, nativeZoomCertified: false, fullWCAGCertification: false }, null, 2));
  await info.attach("engineering-metrics", { path: engineeringPath, contentType: "application/json" });
  await page.getByRole("button", { name: "IT", exact: true }).click();
  await page.getByLabel("Nome", { exact: true }).fill("");
  await page.getByRole("button", { name: "Conferma prenotazione", exact: true }).click();
  await expect(page.locator("#booking-customerFirstName")).toBeFocused();
  await expect(page.locator("#booking-customerFirstName")).toHaveAttribute("aria-describedby", "error-customerFirstName");
  await page.locator("#booking-errors a").filter({ hasText: "Nome" }).focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#booking-customerFirstName")).toBeFocused();
  await page.setViewportSize({ width: 640, height: 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await info.attach("zoom-limit", { body: JSON.stringify({ method: "640 CSSpx reflow simulation", nativeBrowserZoomCertified: false, WCAGCertification: false }), contentType: "application/json" });
  const touchTargets = await page.locator('[data-party-composition] label:has(input[type="radio"]), [data-party-composition] input[type="number"]').evaluateAll(elements => elements.map(element => ({ tag: element.tagName, height: element.getBoundingClientRect().height })));
  expect(touchTargets.length).toBeGreaterThanOrEqual(3);
  expect(touchTargets.every(target => target.height >= 44)).toBe(true);
  const touchPath = info.outputPath("public-touch-metrics.json");
  writeFileSync(touchPath, JSON.stringify(touchTargets, null, 2));
  await info.attach("touch-metrics", { path: touchPath, contentType: "application/json" });
  await section(page, 3).getByRole("button", { name: "Indietro", exact: true }).click();
  await expect(page.locator("#booking-section-2")).toBeFocused();
  await expect(notes).toHaveValue("T08_EARLY_NOTES " + "N".repeat(950));
});

test("E04 synchronous double submit freezes fields and language into one POST", async ({ page }) => {
  const requests: Array<{ key: string; raw: string | null }> = [];
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/public/reservations", async route => {
    requests.push({ key: route.request().headers()["idempotency-key"], raw: route.request().postData() });
    await held; await route.fulfill({ status: 201, json: { managementPath: "/p/t08-synthetic" } });
  });
  await fill(page);
  await page.locator("form").evaluate(form => { (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit(); });
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByLabel("Nome", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  expect(JSON.parse(requests[0].raw!).language).toBe("it");
  release(); await expect(page.getByRole("link", { name: "Open your personal link" })).toBeVisible();
  expect(requests).toHaveLength(1);
});
for (const mode of ["NETWORK", "MALFORMED"] as const) test("E04 uncertain " + mode + " retry preserves exact original payload and key after language switch", async ({ page }) => {
  const requests: Array<{ key: string; raw: string | null }> = [];
  await page.route("**/api/public/reservations", async route => {
    requests.push({ key: route.request().headers()["idempotency-key"], raw: route.request().postData() });
    if (requests.length === 1) return mode === "NETWORK" ? route.abort("failed") : route.fulfill({ status: 200, contentType: "text/plain", body: "malformed" });
    return route.fulfill({ status: 200, json: { managementPath: "/p/t08-synthetic" } });
  });
  await fill(page); await page.getByRole("button", { name: "Conferma prenotazione", exact: true }).click();
  await expect(page.getByText("Non abbiamo ricevuto una conferma.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Nome", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.getByText("We didn't receive confirmation.", { exact: false })).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.getByRole("button", { name: "Retry with the same details", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open your personal link" })).toBeVisible();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
});
test("E04 explicit editing after uncertainty warns and never dispatches automatically", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/public/reservations", route => { ++calls; return route.abort("failed"); });
  await fill(page); await page.getByRole("button", { name: "Conferma prenotazione", exact: true }).click();
  await page.getByRole("button", { name: "Modifica i dati", exact: true }).click();
  await expect(page.getByText("Una richiesta precedente potrebbe essere già stata registrata.", { exact: false })).toBeVisible();
  await page.getByLabel("Note (facoltative)", { exact: true }).fill("T08_CHANGED_AFTER_UNCERTAIN");
  expect(calls).toBe(1);
  await expect(page.getByRole("link", { name: "Apri il tuo link personale" })).toHaveCount(0);
});
