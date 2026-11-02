import { expect, type APIResponse, type Page, type Request } from "@playwright/test";

export interface BookingFixture {
  localDate: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  notes: string;
  childrenCount: number | null;
  gameRoomPreference: boolean | null;
}
interface StaffReservation { id: string; version: number; status: string; arrivalTime: string; childrenCount: number | null; gameRoomPreference: boolean | null; notes: string | null }
const bindingHeader = "X-Piccadilly-Draft-Session-Binding";
const origin = (page: Page) => new URL(page.url()).origin;
const section = (page: Page, number: number) => page.locator("section[aria-labelledby=booking-section-" + number + "]");
const isCreate = (request: Request, path: string) => request.method() === "POST" && new URL(request.url()).pathname === path;

export async function sessionProof(page: Page, role: "STAFF" | "ADMIN") {
  const challenge = await page.evaluate(() => crypto.randomUUID());
  const response = await page.request.post("/api/auth/draft-context", { headers: { origin: origin(page) }, data: { challenge } });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const body = await response.json() as { role: string; challenge: string; sessionBinding: string };
  expect(body.role).toBe(role); expect(body.challenge).toBe(challenge);
  expect(body.sessionBinding).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  return body.sessionBinding;
}

async function party(page: Page, fixture: BookingFixture) {
  await expect(page.locator('select[name="roomCode"]')).toHaveCount(0);
  await page.getByRole("radio", { name: fixture.childrenCount === null ? "Non specificato" : fixture.childrenCount === 0 ? "No, siamo tutti adulti" : "Sì, ci sono bambini", exact: true }).check();
  if (fixture.childrenCount !== null && fixture.childrenCount > 0) {
    await page.getByLabel("Quanti bambini ci sono?", { exact: true }).fill(String(fixture.childrenCount));
    const games = page.getByRole("group", { name: "Preferite un tavolo nella Sala con i Giochi?", exact: true });
    await games.getByRole("radio", { name: fixture.gameRoomPreference ? "Sì" : "No", exact: true }).check();
    await expect(games).toContainText("non è garantita");
  }
}
async function contacts(page: Page, fixture: BookingFixture) {
  await page.getByLabel("Nome", { exact: true }).fill(fixture.firstName);
  await page.getByLabel("Cognome", { exact: true }).fill(fixture.lastName);
  await page.getByLabel("Telefono", { exact: true }).fill(fixture.phone);
  await page.getByLabel("Email (facoltativa)", { exact: true }).fill(fixture.email);
}
function assertPayload(payload: Record<string, unknown>, fixture: BookingFixture) {
  expect(payload).toMatchObject({ partySize: 2, childrenCount: fixture.childrenCount, gameRoomPreference: fixture.gameRoomPreference, notes: fixture.notes });
  for (const field of ["roomCode", "children", "privateNotes", "restaurantId", "tenantId"]) expect(payload).not.toHaveProperty(field);
}
export async function readNamedStaffReservation(page: Page, fixture: BookingFixture) {
  await page.goto("/dashboard?date=" + fixture.localDate);
  const article = page.locator("article[data-reservation-id]").filter({ hasText: fixture.lastName });
  await expect(article).toHaveCount(1);
  const id = await article.getAttribute("data-reservation-id"); expect(id).toBeTruthy();
  const response = await page.request.get("/api/staff/reservations/" + id);
  expect(response.status()).toBe(200);
  const body = await response.json() as { reservation: StaffReservation };
  expect(body.reservation.id).toBe(id);
  return body.reservation;
}
async function publicRead(page: Page, path: string) {
  const response = await page.request.get(path); expect(response.status()).toBe(200);
  const body = await response.json();
  for (const field of ["privateNotes", "internalNotes", "assignment", "id", "version"]) expect(body.reservation).not.toHaveProperty(field);
  return body.reservation as StaffReservation;
}

export async function publicBookingAndManagement(page: Page, staffPage: Page, fixture: BookingFixture) {
  expect(fixture.childrenCount).not.toBeNull();
  let publicCreatePostCount = 0;
  const count = (request: Request) => { if (isCreate(request, "/api/public/reservations")) publicCreatePostCount++; };
  page.on("request", count);
  try {
    await page.goto("/prenota?lang=it");
    await expect(section(page, 3)).toHaveCount(0);
    await page.getByLabel("Servizio", { exact: true }).selectOption("DINNER");
    await page.getByLabel("In quanti siete? (coperti totali)", { exact: true }).fill("2");
    // Set the query inputs before the date starts availability. Re-selecting an
    // unchanged value after dispatch would synthesize an unnecessary change.
    await page.getByLabel("Data", { exact: true }).fill(fixture.localDate);
    await expect(page.locator("[data-availability-state]")).toHaveAttribute("data-availability-state", "READY");
    const slot = page.getByLabel("Orario disponibile", { exact: true });
    const time = await slot.locator("option:not([value=''])").first().getAttribute("value");
    expect(time).toBeTruthy(); await slot.selectOption(time!);
    await section(page, 1).getByRole("button", { name: "Continua", exact: true }).click();
    await party(page, fixture);
    await page.getByLabel("Seggiolone", { exact: true }).check();
    await page.getByLabel("Passeggino", { exact: true }).check();
    await page.getByLabel("Note (facoltative)", { exact: true }).fill(fixture.notes);
    await section(page, 2).getByRole("button", { name: "Continua", exact: true }).click();
    await contacts(page, fixture);
    await page.getByLabel(/Accetto l.informativa privacy/u).check();
    await page.getByLabel(/Accetto le condizioni di prenotazione/u).check();
    const pending = page.waitForResponse(response => isCreate(response.request(), "/api/public/reservations"));
    await page.getByRole("button", { name: "Conferma prenotazione" }).click();
    const created = await pending; expect(created.status()).toBe(201);
    expect(publicCreatePostCount).toBe(1);
    const payload = created.request().postDataJSON() as Record<string, unknown>;
    assertPayload(payload, fixture);
    const hasSessionCookie = /(?:^|;\s*)(?:__Host-)?piccadilly_session=/u.test((await created.request().allHeaders())["cookie"] ?? "");
    expect(hasSessionCookie).toBe(false);
    const key = created.request().headers()["idempotency-key"]; expect(key).toBeTruthy();
    const result = await created.json() as { managementPath: string; replayed: boolean };
    expect(result.replayed).toBe(false);
    expect(result.managementPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);
    await expect(page.getByRole("link", { name: "Apri il tuo link personale" })).toHaveAttribute("href", result.managementPath + "?lang=it");
    const before = await readNamedStaffReservation(staffPage, fixture);
    expect(before).toMatchObject({ childrenCount: fixture.childrenCount, gameRoomPreference: fixture.gameRoomPreference });
    const assignment = await staffPage.request.get("/api/staff/reservations/" + before.id + "/assignment");
    expect(assignment.status()).toBe(200); expect((await assignment.json()).assignment).toBeNull();
    const replay = await page.request.fetch("/api/public/reservations", { method: "POST", headers: { origin: origin(page), "Idempotency-Key": key }, data: payload });
    expect(replay.status()).toBe(200); expect(await replay.json()).toMatchObject({ managementPath: result.managementPath, replayed: true });
    const conflict = await page.request.fetch("/api/public/reservations", { method: "POST", headers: { origin: origin(page), "Idempotency-Key": key }, data: { ...payload, notes: fixture.notes + "-different" } });
    expect(conflict.status()).toBe(409);
    const management = await page.goto(result.managementPath);
    expect(management?.status()).toBe(200); expect(management?.headers()["x-robots-tag"]).toContain("noindex");
    const endpoint = "/api/public/reservations/" + result.managementPath.slice(3);
    const availability = await page.request.get("/api/public/availability", { params: { date: fixture.localDate, service: "DINNER", partySize: "2" } });
    expect(availability.status()).toBe(200);
    const slots = await availability.json() as { isOpen: boolean; slots: { time: string; available: boolean }[] };
    expect(slots.isOpen).toBe(true);
    const next = slots.slots.find(item => item.available && item.time !== time); expect(next).toBeTruthy();
    const fields = ["localDate", "serviceType", "partySize", "childrenCount", "gameRoomPreference", "highChair", "stroller", "accessibility", "celiac", "allergies", "intolerances", "celebration", "animals", "notes"];
    const update = { ...Object.fromEntries(fields.map(field => [field, payload[field]])), arrivalTime: next!.time };
    const invalid = await page.request.patch(endpoint, { headers: { origin: origin(page) }, data: { ...update, roomCode: "sala-1", children: false } });
    expect(invalid.status()).toBe(400);
    const updated = await page.request.patch(endpoint, { headers: { origin: origin(page) }, data: update });
    expect(updated.status()).toBe(200);
    expect(await publicRead(page, endpoint)).toMatchObject({ arrivalTime: next!.time, status: "CONFIRMED", childrenCount: fixture.childrenCount, gameRoomPreference: fixture.gameRoomPreference });
    expect(await readNamedStaffReservation(staffPage, fixture)).toMatchObject({ id: before.id, version: before.version + 1, arrivalTime: next!.time });
    const cancelled = await page.request.delete(endpoint, { headers: { origin: origin(page) }, data: {} });
    expect(cancelled.status()).toBe(200);
    expect(await publicRead(page, endpoint)).toMatchObject({ status: "CANCELLED", canModify: false, canCancel: false });
    const final = await readNamedStaffReservation(staffPage, fixture);
    expect(final).toMatchObject({ id: before.id, version: before.version + 2, status: "CANCELLED" });
    expect(publicCreatePostCount).toBe(1);
    return { id: before.id, version: final.version, originalVersion: before.version };
  } finally { page.off("request", count); }
}

export async function phoneBooking(page: Page, fixture: BookingFixture) {
  await sessionProof(page, "STAFF");
  let phoneCreatePostCount = 0;
  const count = (request: Request) => { if (isCreate(request, "/api/staff/reservations")) phoneCreatePostCount++; };
  page.on("request", count);
  try {
    const localDate = fixture.localDate;
    await page.goto(`/dashboard/reservations/new?date=${localDate}`);
    await page.getByLabel("Data", { exact: true }).fill(localDate);
    await page.getByLabel("Servizio", { exact: true }).selectOption("DINNER");
    await page.getByLabel("In quanti siete? (coperti totali)", { exact: true }).fill("2");
    await party(page, fixture);
    const slot = page.getByRole("combobox", { name: /^Slot configurato/u });
    await expect(slot.locator("option:not([value=''])").first()).toHaveCount(1);
    const time = await slot.locator("option:not([value=''])").first().getAttribute("value"); expect(time).toBeTruthy(); await slot.selectOption(time!);
    await contacts(page, fixture);
    await page.getByLabel("Seggiolone", { exact: true }).check();
    await page.getByLabel("Passeggino", { exact: true }).check();
    await page.getByLabel("Accessibilità", { exact: true }).check();
    await page.getByLabel("Allergie dichiarate", { exact: true }).fill("M13 synthetic allergy");
    await page.getByLabel("Note", { exact: true }).fill(fixture.notes);
    const whatsapp = page.getByRole("checkbox", { name: /^Invia conferma WhatsApp/u });
    await expect(whatsapp).toBeChecked(); await whatsapp.uncheck();
    await page.getByLabel(/Confermo di avere acquisito verbalmente/u).check();
    const pending = page.waitForResponse(response => isCreate(response.request(), "/api/staff/reservations"));
    await page.getByRole("button", { name: "Salva prenotazione telefonica" }).click();
    const response = await pending; expect(response.status()).toBe(201); expect(phoneCreatePostCount).toBe(1);
    const payload = response.request().postDataJSON() as Record<string, unknown>;
    assertPayload(payload, fixture);
    expect(payload).toMatchObject({ sendWhatsAppConfirmation: false, verbalConsentConfirmed: true, highChair: true, stroller: true, accessibility: true });
    const originalBinding = response.request().headers()[bindingHeader.toLowerCase()];
    expect(originalBinding).toBe(await sessionProof(page, "STAFF"));
    const key = response.request().headers()["idempotency-key"]; expect(key).toBeTruthy();
    await expect(page.getByText("Prenotazione telefonica salvata e capacità aggiornata.", { exact: true })).toBeVisible();
    const created = await response.json() as { reservation: StaffReservation; replayed: boolean };
    const replay = await page.request.fetch("/api/staff/reservations", { method: "POST", headers: { origin: origin(page), [bindingHeader]: originalBinding, "Idempotency-Key": key }, data: payload });
    expect(replay.status()).toBe(200); expect(await replay.json()).toMatchObject({ replayed: true, reservation: { id: created.reservation.id } });
    const conflict = await page.request.fetch("/api/staff/reservations", { method: "POST", headers: { origin: origin(page), [bindingHeader]: originalBinding, "Idempotency-Key": key }, data: { ...payload, notes: fixture.notes + "-different" } });
    expect(conflict.status()).toBe(409);
    expect(await readNamedStaffReservation(page, fixture)).toMatchObject({ id: created.reservation.id, version: created.reservation.version, childrenCount: fixture.childrenCount, gameRoomPreference: fixture.gameRoomPreference });
    expect(phoneCreatePostCount).toBe(1);
    return { id: created.reservation.id, binding: originalBinding };
  } finally { page.off("request", count); }
}

export async function assignmentAndExports(page: Page, fixture: BookingFixture, created: { id: string; binding: string }) {
  const path = "/api/staff/reservations/" + created.id + "/assignment";
  const context = await page.request.get(path); expect(context.status()).toBe(200);
  const state = await context.json() as { reservation: { version: number }; assignment: unknown; rooms: { id: string; code: string; isActive: boolean; isAvailableForService: boolean | null; tables: { id: string; isActive: boolean }[] }[] };
  expect(state.assignment).toBeNull();
  const room = state.rooms.find(item => item.code === "sala-1" && item.isActive && item.isAvailableForService === true);
  expect(room).toBeTruthy(); const table = room!.tables.find(item => item.isActive); expect(table).toBeTruthy();
  const payload = { version: state.reservation.version, roomId: room!.id, tableIds: [table!.id], internalNotes: fixture.notes + "-ASSIGNMENT" };
  const assigned = await page.request.put(path, { headers: { origin: origin(page) }, data: payload }); expect(assigned.status()).toBe(200);
  const reread = await page.request.get(path); expect(reread.status()).toBe(200);
  const current = await reread.json();
  expect(current.reservation.version).toBe(state.reservation.version + 1);
  expect(current.assignment).toMatchObject({ room: { id: room!.id }, tables: [expect.objectContaining({ id: table!.id })] });
  const conflict = await page.request.put(path, { headers: { origin: origin(page) }, data: { ...payload, internalNotes: fixture.notes + "-conflict" } });
  expect(conflict.status()).toBe(409);
  const unchanged = await page.request.get(path); expect((await unchanged.json()).reservation.version).toBe(current.reservation.version);

  const localDate = fixture.localDate;
  async function file(response: APIResponse, mime: string, filename: string, magic: string) {
    expect(response.status()).toBe(200); const headers = response.headers();
    expect(headers["content-type"]).toBe(mime);
    expect(headers["content-disposition"]).toBe('attachment; filename="' + filename + '"');
    expect(headers["cache-control"]).toContain("private"); expect(headers["cache-control"]).toContain("no-store");
    expect(headers["pragma"]).toBe("no-cache"); expect(headers["x-content-type-options"]).toBe("nosniff");
    const bytes = await response.body(); expect(bytes.subarray(0, magic.length).toString()).toBe(magic);
    expect(Number(headers["content-length"])).toBe(bytes.length);
  }
  const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  await file(await page.request.post("/api/staff/exports/pdf", { headers: { origin: origin(page) }, data: { date: localDate } }), "application/pdf", `piccadilly-prenotazioni-${localDate}.pdf`, "%PDF-");
  await file(await page.request.post("/api/staff/exports/excel", { headers: { origin: origin(page) }, data: { mode: "DAY", date: localDate } }), mime, `piccadilly-prenotazioni-${localDate}.xlsx`, "PK");
  const wrongOrigin = await page.request.post("/api/staff/exports/pdf", { headers: { origin: "https://evil.example" }, data: { date: localDate } });
  expect(wrongOrigin.status()).toBe(403);
  for (const [target, suffix, contentType, magic] of [["PDF", "pdf", "application/pdf", "%PDF-"], ["EXCEL", "xlsx", mime, "PK"]]) {
    const endpoint = "/api/staff/exports/" + (target === "PDF" ? "pdf-v2" : "excel-v2");
    const data = { version: 2, target, period: { mode: "DAY", date: localDate }, service: "DINNER", room: "ALL", order: "CREATED_ASC" };
    const headers = { origin: origin(page), [bindingHeader]: created.binding };
    await file(await page.request.post(endpoint, { headers, data }), contentType, `piccadilly-operativo-v2-${localDate}-dinner-all-created-asc.${suffix}`, magic);
    const absent = await page.request.post(endpoint, { headers: { origin: origin(page) }, data }); expect(absent.status()).toBe(400);
    const invalid = await page.request.post(endpoint, { headers: { ...headers, [bindingHeader]: "invalid" }, data }); expect(invalid.status()).toBe(400);
    const different = (created.binding[0] === "A" ? "B" : "A") + created.binding.slice(1);
    const mismatch = await page.request.post(endpoint, { headers: { ...headers, [bindingHeader]: different }, data }); expect(mismatch.status()).toBe(403);
    const denied = await page.request.post(endpoint, { headers: { ...headers, origin: "https://evil.example" }, data }); expect(denied.status()).toBe(403);
    expect(denied.headers()["cache-control"]).toContain("no-store");
  }
  const admin = await page.request.get("/api/admin/notification-settings"); expect(admin.status()).toBe(403);
}
