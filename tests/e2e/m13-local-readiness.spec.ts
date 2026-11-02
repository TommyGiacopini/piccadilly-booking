import { Pool } from "pg";
import { expect, test, type Page } from "@playwright/test";
import { assignmentAndExports, phoneBooking, publicBookingAndManagement, sessionProof, type BookingFixture } from "../staging/m13-booking-scenarios";
import { e2eReservationFirstName, e2eRestaurantId, e2eRunId, e2eStaffUsername, e2eAdminUsername } from "./e2e-run";

const target = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
  !/^\/piccadilly_e2e_[0-9a-f]{32}$/u.test(target.pathname)) throw Error("M13_TEMPORARY_DATABASE_REQUIRED");
const database = new Pool({ connectionString: target.href });
const day = "2099-11-25";
function fixture(label: string, childrenCount: number | null, gameRoomPreference: boolean | null): BookingFixture {
  return { localDate: day, firstName: e2eReservationFirstName, lastName: "M13 " + label + " " + e2eRunId,
    phone: "+390000001302", email: "m13-local@example.test", notes: "M13 synthetic NC " + label, childrenCount, gameRoomPreference };
}
async function login(page: Page, role: "STAFF" | "ADMIN" = "STAFF") {
  await page.goto("/login");
  await page.getByLabel("Username").fill(role === "STAFF" ? e2eStaffUsername : e2eAdminUsername);
  await page.getByLabel("Password").fill(process.env[role === "STAFF" ? "AUTH_DEMO_STAFF_PASSWORD" : "AUTH_DEMO_ADMIN_PASSWORD"] ?? "");
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/login" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Accedi", exact: true }).click();
  expect((await pending).status()).toBe(303); await expect(page).toHaveURL(/\/dashboard/u);
  await sessionProof(page, role);
}
test.beforeEach(async () => {
  await database.query("DELETE FROM public_reservation_rate_limits WHERE restaurant_id=$1", [e2eRestaurantId]);
});
test.afterAll(async () => { await database.end(); });
test("M13 shared Public T08, Foundation, replay and effective management update/cancel", async ({ page, browser }) => {
  const staffContext = await browser.newContext({ baseURL: "http://localhost:4000" });
  const staff = await staffContext.newPage(); await login(staff);
  try {
    const input = fixture("PUBLIC", 1, true);
    const result = await publicBookingAndManagement(page, staff, input);
    const stored = await database.query("SELECT id,version,status,children_count,game_room_preference,private_notes,cancelled_at FROM reservations WHERE restaurant_id=$1 AND customer_first_name=$2 AND customer_last_name=$3", [e2eRestaurantId, input.firstName, input.lastName]);
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]).toMatchObject({ id: result.id, version: result.originalVersion + 2, status: "CANCELLED", children_count: 1, game_room_preference: true, private_notes: null });
    expect(stored.rows[0].cancelled_at).not.toBeNull();
    const audits = await database.query("SELECT action FROM reservation_audit_events WHERE restaurant_id=$1 AND reservation_id=$2 ORDER BY created_at", [e2eRestaurantId, result.id]);
    expect(audits.rows.map(row => row.action)).toEqual(["CREATED", "UPDATED", "CANCELLED"]);
  } finally { await staffContext.close(); }
});
for (const scenario of [{ label: "unknown", count: null, games: null }, { label: "adults", count: 0, games: null }, { label: "children-no", count: 1, games: false }]) {
  test("M13 shared PHONE " + scenario.label + ", assignment conflict, M11/V2 exports and simulated opt-out", async ({ page }) => {
    await login(page);
    const input = fixture(scenario.label, scenario.count, scenario.games), created = await phoneBooking(page, input);
    await assignmentAndExports(page, input, created);
    const stored = await database.query("SELECT id,origin,party_size,children_count,game_room_preference,private_notes FROM reservations WHERE restaurant_id=$1 AND customer_first_name=$2 AND customer_last_name=$3", [e2eRestaurantId, input.firstName, input.lastName]);
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]).toMatchObject({ id: created.id, origin: "PHONE", party_size: 2, children_count: scenario.count, game_room_preference: scenario.games, private_notes: null });
    const outbox = await database.query("SELECT event_type,channel,status FROM notification_outbox WHERE restaurant_id=$1 AND reservation_id=$2", [e2eRestaurantId, created.id]);
    expect(outbox.rows.filter(row => row.event_type === "RESERVATION_CONFIRMED" && row.channel === "WHATSAPP")).toEqual([]);
    expect(outbox.rows).toEqual(expect.arrayContaining([expect.objectContaining({ event_type: "RESERVATION_REMINDER", channel: "WHATSAPP", status: "PENDING" })]));
    const attempts = await database.query("SELECT count(*)::int AS n FROM notification_attempts a JOIN notification_outbox o ON o.id=a.outbox_id WHERE o.restaurant_id=$1 AND o.reservation_id=$2", [e2eRestaurantId, created.id]);
    expect(attempts.rows[0].n).toBe(0);
    const loggedOut = await page.request.post("/api/auth/logout", { headers: { origin: "http://localhost:4000" }, maxRedirects: 0 });
    expect(loggedOut.status()).toBe(303);
    const denied = await page.request.get("/api/staff/reservations/" + created.id + "/assignment"); expect(denied.status()).toBe(401);
  });
}
test("M13 Admin current presentation and simulated notification strategy", async ({ page }) => {
  await login(page, "ADMIN");
  const response = await page.goto("/admin/configuration"); expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Impostazioni operative", exact: true, level: 1 })).toBeVisible();
  const settings = await page.request.get("/api/admin/notification-settings");
  expect(settings.status()).toBe(200); expect(await settings.json()).toMatchObject({ configuration: { strategy: "WHATSAPP_ONLY" } });
});
