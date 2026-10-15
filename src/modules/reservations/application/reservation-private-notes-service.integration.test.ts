import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "@/app/api/staff/reservations/[id]/private-notes/route";
import { getReservationPrivateNotes, putReservationPrivateNotes } from "./reservation-private-notes-service";
import { operationalTimeToDatabase } from "@/modules/configuration/domain/operational-time";
import { createSessionForUser } from "@/server/auth/session";
import { getSessionCookieName } from "@/server/auth/session-token";
import { prisma } from "@/server/db/prisma";

const restaurantId = randomUUID(), otherRestaurantId = randomUUID();
const staffId = randomUUID(), adminId = randomUUID(), otherStaffId = randomUUID();
const disabledId = randomUUID(), changeId = randomUUID(), roomId = randomUUID();
const actor = { id: staffId, restaurantId };
const now = new Date("2026-10-14T10:00:00.123Z");
const marker = "T06_AUTONOMOUS_NI_PRIVACY_MARKER";
const legacyMarker = "T06_LEGACY_NI_PRIVACY_MARKER";
let cookie = "", adminCookie = "", changeCookie = "";

async function reservation(input: { status?: "CONFIRMED" | "CANCELLED"; historical?: boolean; other?: boolean; privateNotes?: string | null } = {}) {
  return prisma.reservation.create({ data: {
    restaurantId: input.other ? otherRestaurantId : restaurantId,
    localDate: new Date(input.historical ? "2020-01-01" : "2099-10-14"),
    serviceType: "DINNER", arrivalTime: operationalTimeToDatabase("19:00"), partySize: 2,
    status: input.status ?? "CONFIRMED", origin: "STAFF",
    customerFirstName: "T06", customerLastName: "Synthetic", customerPhone: "+390000000600",
    notes: "T06_NC_SHARED_MARKER", privateNotes: input.privateNotes ?? null,
    privacyPolicyVersion: "t06-fake-v1", privacyConsentAt: now, privacyConsentMethod: "STAFF_RECORDED",
    createdByUserId: input.other ? otherStaffId : staffId,
    cancelledAt: input.status === "CANCELLED" ? now : null,
  } });
}
function put(id: string, text: string | null, version = 1, selectedActor = actor) {
  return putReservationPrivateNotes({ actor: selectedActor, reservationId: id, rawPayload: { version, privateNotes: text }, now });
}
async function read(id: string) { return prisma.reservation.findUniqueOrThrow({ where: { id } }); }
async function call(id: string, input: { method?: "GET" | "PUT"; cookie?: string; origin?: string; body?: unknown; rawBody?: string; contentType?: string } = {}) {
  const method = input.method ?? "PUT";
  const request = new Request(`http://localhost:4000/api/staff/reservations/${id}/private-notes`, {
    method, headers: { cookie: input.cookie ?? cookie, origin: input.origin ?? "http://localhost:4000",
      "content-type": input.contentType ?? "application/json" },
    ...(method === "PUT" ? { body: input.rawBody ?? JSON.stringify(input.body ?? { version: 1, privateNotes: marker }) } : {}),
  });
  return (method === "GET" ? GET : PUT)(request, { params: Promise.resolve({ id }) });
}
async function clearReservations() {
  const tenant = { in: [restaurantId, otherRestaurantId] };
  await prisma.reservationAssignmentTable.deleteMany({ where: { restaurantId: tenant } });
  await prisma.reservationAssignment.deleteMany({ where: { restaurantId: tenant } });
  await prisma.reservationAuditEvent.deleteMany({ where: { restaurantId: tenant } });
  await prisma.reservation.deleteMany({ where: { restaurantId: tenant } });
}

describe.sequential("T06 private notes PostgreSQL and HTTP", () => {
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? "");
    expect(target.pathname).toMatch(/^\/piccadilly_vitest_[0-9a-f]{32}$/u);
    await prisma.restaurant.createMany({ data: [
      { id: restaurantId, name: "T06 synthetic", timezone: "Europe/Rome" },
      { id: otherRestaurantId, name: "T06 other synthetic", timezone: "Europe/Rome" },
    ] });
    await prisma.user.createMany({ data: [
      { id: staffId, restaurantId, username: "t06.staff." + staffId, passwordHash: "unused", role: "STAFF" },
      { id: adminId, restaurantId, username: "t06.admin." + adminId, passwordHash: "unused", role: "ADMIN" },
      { id: otherStaffId, restaurantId: otherRestaurantId, username: "t06.other." + otherStaffId, passwordHash: "unused", role: "STAFF" },
      { id: disabledId, restaurantId, username: "t06.disabled." + disabledId, passwordHash: "unused", role: "STAFF", isActive: false, disabledAt: now },
      { id: changeId, restaurantId, username: "t06.change." + changeId, passwordHash: "unused", role: "STAFF", mustChangePassword: true },
    ] });
    await prisma.room.create({ data: { id: roomId, restaurantId, code: "sala-1", name: "Sala 1", displayOrder: 1 } });
    const cookieName = getSessionCookieName("development");
    cookie = cookieName + "=" + (await createSessionForUser(staffId)).token;
    adminCookie = cookieName + "=" + (await createSessionForUser(adminId)).token;
    changeCookie = cookieName + "=" + (await createSessionForUser(changeId)).token;
  });
  beforeEach(clearReservations);
  afterAll(async () => {
    await clearReservations();
    await prisma.session.deleteMany({ where: { userId: { in: [staffId, adminId, otherStaffId, disabledId, changeId] } } });
    await prisma.user.deleteMany({ where: { restaurantId: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.room.deleteMany({ where: { restaurantId } });
    await prisma.restaurant.deleteMany({ where: { id: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.$disconnect();
  });

  it.each([staffId, adminId])("writes without a room for Staff/Admin %s, with one version and minimized audit", async (id) => {
    const row = await reservation();
    expect(await put(row.id, marker, 1, { id, restaurantId })).toEqual({ changed: true, reservationVersion: 2, privateNotes: marker });
    expect(await read(row.id)).toEqual({ ...row, privateNotes: marker, version: 2, updatedAt: now });
    const audit = await prisma.reservationAuditEvent.findFirstOrThrow({ where: { reservationId: row.id } });
    expect(audit).toMatchObject({ action: "PRIVATE_NOTES_UPDATED", actorUserId: id, actorRole: id === staffId ? "STAFF" : "ADMIN",
      previousState: { privateNotes: { present: false }, version: 1 },
      newState: { privateNotes: { present: true }, version: 2 } });
    expect(JSON.stringify(audit)).not.toContain(marker);
    expect(await prisma.reservationAssignment.count({ where: { reservationId: row.id } })).toBe(0);
    expect(await prisma.notificationOutbox.count({ where: { reservationId: row.id } })).toBe(0);
    expect(await prisma.reservationManagementToken.count({ where: { reservationId: row.id } })).toBe(0);
    expect(await prisma.serviceInstance.count({ where: { restaurantId } })).toBe(0);
  });
  it("keeps identical and stale identical no-ops entirely unchanged, including null/empty", async () => {
    const row = await reservation();
    expect(await put(row.id, "")).toMatchObject({ changed: false, reservationVersion: 1 });
    expect(await read(row.id)).toEqual(row);
    await put(row.id, marker);
    const before = await read(row.id);
    expect(await put(row.id, marker, 1)).toMatchObject({ changed: false, reservationVersion: 2 });
    expect(await read(row.id)).toEqual(before);
    expect(await prisma.reservationAuditEvent.count({ where: { reservationId: row.id } })).toBe(1);
    expect(await put(row.id, "", 2)).toMatchObject({ changed: true, reservationVersion: 3, privateNotes: null });
  });
  it("rejects a real version conflict without note/error/audit disclosure", async () => {
    const row = await reservation(); await put(row.id, marker);
    const before = await read(row.id);
    const response = await call(row.id, { body: { version: 1, privateNotes: "T06_OTHER_PRIVATE_MARKER" } });
    expect(response.status).toBe(409); expect(await response.text()).not.toContain(marker);
    expect(await read(row.id)).toEqual(before);
  });
  it.each([true, false])("serializes two operators with identical=%s", async (identical) => {
    const row = await reservation();
    const results = await Promise.allSettled([put(row.id, marker), put(row.id, identical ? marker : "T06_SECOND_NI", 1, { id: adminId, restaurantId })]);
    expect(results.filter((r) => r.status === "fulfilled" && r.value.changed)).toHaveLength(1);
    if (identical) expect(results.filter((r) => r.status === "fulfilled" && !r.value.changed)).toHaveLength(1);
    else expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
    expect((await read(row.id)).version).toBe(2);
    expect(await prisma.reservationAuditEvent.count({ where: { reservationId: row.id } })).toBe(1);
  });
  it("edits historical CONFIRMED but reads CANCELLED before rejecting even identical PUT", async () => {
    expect(await put((await reservation({ historical: true })).id, marker)).toMatchObject({ changed: true });
    const row = await reservation({ status: "CANCELLED", privateNotes: marker });
    expect(await getReservationPrivateNotes({ actor, reservationId: row.id })).toMatchObject({ privateNotes: marker, reservation: { status: "CANCELLED" } });
    await expect(put(row.id, marker)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(await read(row.id)).toEqual(row);
  });
  it.each([null, now])("separately reads legacy notes without promoting or mutating assignment clearedAt=%s", async (clearedAt) => {
    const row = await reservation();
    const assignment = await prisma.reservationAssignment.create({ data: { restaurantId, reservationId: row.id, roomId,
      internalNotes: legacyMarker, assignedByUserId: staffId, updatedByUserId: staffId, clearedAt } });
    const context = await getReservationPrivateNotes({ actor, reservationId: row.id });
    expect(context).toMatchObject({ privateNotes: null, privateNotesPresent: false,
      legacyAssignment: { internalNotes: legacyMarker, state: clearedAt ? "CLEARED" : "ACTIVE" } });
    await put(row.id, marker);
    expect(await prisma.reservationAssignment.findUniqueOrThrow({ where: { id: assignment.id } })).toEqual(assignment);
  });
  it("isolates tenants and rereads active/password-change authorization before no-op", async () => {
    const row = await reservation({ privateNotes: marker }), other = await reservation({ other: true });
    await expect(put(other.id, marker)).rejects.toMatchObject({ code: "NOT_FOUND" });
    for (const id of [disabledId, changeId, otherStaffId]) {
      await expect(put(row.id, marker, 1, { id, restaurantId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect((await call(row.id, { cookie: "", method: "GET" })).status).toBe(401);
    expect((await call(row.id, { cookie: "" })).status).toBe(401);
    expect((await call(row.id, { cookie: changeCookie })).status).toBe(403);
    expect((await call(row.id, { cookie: changeCookie, method: "GET" })).status).toBe(403);
    expect((await call(other.id, { method: "GET" })).status).toBe(404);
    expect((await call(row.id, { cookie: adminCookie })).status).toBe(200);
  });
  it.each([
    { body: { version: 1, privateNotes: marker, tenant: "extra" } },
    { body: { version: 1 } }, { body: { version: 0, privateNotes: marker } },
    { body: { version: 1, privateNotes: marker.repeat(100) } },
    { body: { version: 1, privateNotes: "\u0000" } }, { rawBody: "{" }, { contentType: "text/plain" },
  ])("rejects strict invalid HTTP bodies without leaking text", async (input) => {
    const row = await reservation();
    const response = await call(row.id, input);
    expect(response.status).toBe(400); expect(await response.text()).not.toContain(marker);
    expect(await read(row.id)).toEqual(row);
  });
  it("preserves same-origin/no-store and Unicode HTTP contracts", async () => {
    const row = await reservation();
    expect((await call(row.id, { origin: "https://foreign.example.test" })).status).toBe(403);
    const response = await call(row.id, { body: { version: 1, privateNotes: "😀".repeat(1000) } });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await response.json()).privateNotes).toBe("😀".repeat(1000));
    expect((await call(row.id, { method: "GET" })).headers.get("cache-control")).toContain("no-store");
  });
  it.each(["audit", "write"] as const)("rolls back %s failure and keeps NI out of Prisma diagnostics, application logs and HTTP errors", async (kind) => {
    const row = await reservation(), table = kind === "audit" ? "reservation_audit_events" : "reservations";
    const operation = kind === "audit" ? "INSERT" : "UPDATE";
    const stdout = vi.spyOn(process.stdout, "write"), stderr = vi.spyOn(process.stderr, "write");
    const log = vi.spyOn(console, "error");
    await prisma.$executeRawUnsafe(`CREATE FUNCTION t06_fail_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic T06 private failure'; END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER t06_fail_note BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION t06_fail_note()`);
    try {
      const response = await call(row.id);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(marker);
      const logs = JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls, ...log.mock.calls]);
      expect(logs).not.toContain(marker);
      expect(await read(row.id)).toEqual(row);
      expect(await prisma.reservationAuditEvent.count({ where: { reservationId: row.id } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER t06_fail_note ON ${table}`);
      await prisma.$executeRawUnsafe("DROP FUNCTION t06_fail_note()");
      stdout.mockRestore(); stderr.mockRestore(); log.mockRestore();
    }
  });
});
