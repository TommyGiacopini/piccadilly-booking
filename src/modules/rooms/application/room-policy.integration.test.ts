import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as adminGet } from "@/app/api/admin/room-configuration/route";
import { POST as adminPreview } from "@/app/api/admin/room-configuration/preview/route";
import { POST as adminApply } from "@/app/api/admin/room-configuration/apply/route";
import { DELETE, GET, PUT } from "@/app/api/staff/reservations/[id]/assignment/route";
import { DAY_OF_WEEK_VALUES, DEFAULT_SERVICE_TIMES, DEMO_ROOMS, SERVICE_TYPE_VALUES } from "@/modules/configuration/domain/defaults";
import { localDateToDatabase, operationalTimeToDatabase } from "@/modules/configuration/domain/operational-time";
import { getDashboardDay } from "@/modules/dashboard/application/dashboard-query";
import { updateStaffReservation } from "@/modules/reservations/application/staff-reservation-service";
import { roomOperationalPresentation } from "@/modules/rooms/domain/room-operational-presentation";
import type { RoomConfigurationProposal } from "@/modules/rooms/domain/room-configuration";
import { createSessionForUser } from "@/server/auth/session";
import { getSessionCookieName } from "@/server/auth/session-token";
import { getAppEnvironment } from "@/shared/config/app-environment";
import { prisma } from "@/server/db/prisma";
import { deleteReservationAssignment, getReservationAssignmentContext, putReservationAssignment } from "./reservation-assignment-service";
import { applyRoomConfigurationChange, getAdminRoomConfiguration, previewRoomConfigurationChange } from "./room-configuration-service";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const adminId = randomUUID();
const staffId = randomUUID();
const otherStaffId = randomUUID();
const passwordId = randomUUID();
const actor = { id: staffId, restaurantId };
const admin = { id: adminId, restaurantId };
const date = "2099-07-10";
const now = new Date("2099-07-09T10:00:00.000Z");
const tenant = { in: [restaurantId, otherRestaurantId] };
let cookies: Record<string, string> = {};
const httpEvidence: Array<{ route: string; method: string; status: number; code?: string; bodyKeys: string[]; noStore: true }> = [];

async function room(code: string, target = restaurantId) {
  return prisma.room.findFirstOrThrow({ where: { restaurantId: target, code } });
}
async function table(code: string) {
  return prisma.diningTable.findFirstOrThrow({ where: { room: { restaurantId, code } } });
}
async function reservation(input: { childrenCount?: number | null; gameRoomPreference?: boolean | null; children?: boolean; localDate?: string; restaurantId?: string } = {}) {
  return prisma.reservation.create({ data: {
    restaurantId: input.restaurantId ?? restaurantId, localDate: localDateToDatabase(input.localDate ?? date), serviceType: "DINNER", arrivalTime: operationalTimeToDatabase("19:00"), partySize: 4, origin: "STAFF",
    customerFirstName: "T05 Fake", customerLastName: "Policy Fixture", customerPhone: "+39000000105", customerEmail: "t05@example.test",
    childrenCount: input.childrenCount ?? null, gameRoomPreference: input.gameRoomPreference ?? null, arrivedAt: now, notes: "Synthetic note",
    preferences: JSON.stringify({ roomCode: "sala-3", highChair: false, stroller: false, accessibility: false, children: input.children ?? false, celebration: null, animals: false, legacyText: "Legacy synthetic" }),
    allergies: JSON.stringify({ celiac: false, allergies: null, intolerances: null, legacyText: "Legacy synthetic" }),
    privacyPolicyVersion: "t05-fake", privacyConsentAt: now, privacyConsentMethod: "STAFF_RECORDED", createdByUserId: input.restaurantId ? otherStaffId : staffId,
  } });
}
async function assign(id: string, code: string, version = 1, tableIds: string[] = [], internalNotes: string | null = "T05 synthetic internal note") {
  return putReservationAssignment({ actor, reservationId: id, rawPayload: { version, roomId: (await room(code)).id, tableIds, internalNotes }, now });
}
async function configure(proposal: RoomConfigurationProposal) {
  const preview = await previewRoomConfigurationChange(admin, proposal, { now });
  return applyRoomConfigurationChange(admin, { proposal, fingerprint: preview.fingerprint }, { now });
}
async function availability(code: string, isAvailable: boolean, localDate = date, serviceType: "LUNCH" | "DINNER" = "DINNER") {
  return configure({ kind: "SERVICE_ROOM_AVAILABILITY", roomId: (await room(code)).id, localDate, serviceType, isAvailable });
}
async function global(code: string, isActive: boolean) {
  const current = await room(code);
  return configure({ kind: "ROOM_CATALOG", roomId: current.id, displayOrder: current.displayOrder, isActive });
}
async function snapshot() {
  const where = { restaurantId: tenant };
  const [reservations, assignments, links, instances, availability, rooms, tables, audits, adminAudits, tokens, outbox] = await Promise.all([
    prisma.reservation.findMany({ where, orderBy: { id: "asc" } }),
    prisma.reservationAssignment.findMany({ where, orderBy: { id: "asc" } }),
    prisma.reservationAssignmentTable.findMany({ where, orderBy: [{ assignmentId: "asc" }, { diningTableId: "asc" }] }),
    prisma.serviceInstance.findMany({ where, orderBy: { id: "asc" } }),
    prisma.serviceRoomAvailability.findMany({ where, orderBy: { id: "asc" } }),
    prisma.room.findMany({ where, orderBy: { id: "asc" } }),
    prisma.diningTable.findMany({ where: { room: where }, orderBy: { id: "asc" } }),
    prisma.reservationAuditEvent.findMany({ where, orderBy: { id: "asc" } }),
    prisma.auditEvent.findMany({ where, orderBy: { id: "asc" } }),
    prisma.reservationManagementToken.findMany({ where: { reservation: where }, orderBy: { id: "asc" } }),
    prisma.notificationOutbox.findMany({ where, orderBy: { id: "asc" } }),
  ]);
  return { reservations, assignments, links, instances, availability, rooms, tables, audits, adminAudits, tokens, outbox };
}
async function clean() {
  const where = { restaurantId: tenant };
  await prisma.notificationSimulationReceipt.deleteMany({ where });
  await prisma.notificationAttempt.deleteMany({ where });
  await prisma.notificationOutbox.deleteMany({ where });
  await prisma.reservationAssignmentTable.deleteMany({ where });
  await prisma.reservationAssignment.deleteMany({ where });
  await prisma.reservationAuditEvent.deleteMany({ where });
  await prisma.auditEvent.deleteMany({ where });
  await prisma.reservationIdempotencyKey.deleteMany({ where });
  await prisma.reservation.deleteMany({ where });
  await prisma.serviceRoomAvailability.deleteMany({ where });
  await prisma.serviceInstance.deleteMany({ where });
  await prisma.specialDateOverride.deleteMany({ where });
  await prisma.weeklyServiceSchedule.updateMany({ where, data: { isEnabled: true } });
  await prisma.room.updateMany({ where, data: { isActive: true } });
  await prisma.diningTable.updateMany({ where: { room: where }, data: { isActive: true } });
}
async function http(method: "GET" | "PUT" | "DELETE", id: string, options: { cookie?: string; origin?: string; body?: unknown; contentType?: string; invalidJson?: boolean } = {}) {
  const headers = { cookie: options.cookie ?? cookies.staff, origin: options.origin ?? "http://localhost:4000", "content-type": options.contentType ?? "application/json" };
  const response = await { GET, PUT, DELETE }[method](new Request(`http://localhost:4000/api/staff/reservations/${id}/assignment`, { method, headers, ...(method === "GET" ? {} : { body: options.invalidJson ? "{" : JSON.stringify(options.body) }) }), { params: Promise.resolve({ id }) });
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json();
  httpEvidence.push({ route: "staff-assignment", method, status: response.status, code: body.code, bodyKeys: Object.keys(body), noStore: true });
  return { status: response.status, body };
}
async function adminHttp(kind: "GET" | "PREVIEW" | "APPLY", options: { cookie?: string; origin?: string; body?: unknown; contentType?: string } = {}) {
  const method = kind === "GET" ? "GET" : "POST";
  const url = `http://localhost:4000/api/admin/room-configuration${kind === "GET" ? `?date=${date}&service=DINNER` : kind === "PREVIEW" ? "/preview" : "/apply"}`;
  const response = await { GET: adminGet, PREVIEW: adminPreview, APPLY: adminApply }[kind](new Request(url, { method, headers: { cookie: options.cookie ?? cookies.admin, origin: options.origin ?? "http://localhost:4000", "content-type": options.contentType ?? "application/json" }, ...(method === "POST" ? { body: JSON.stringify(options.body) } : {}) }));
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json();
  httpEvidence.push({ route: "admin-room-configuration", method: kind, status: response.status, code: body.code, bodyKeys: Object.keys(body), noStore: true });
  return { status: response.status, body };
}

describe.sequential("T05 room policy: real PostgreSQL and canonical HTTP P01–P18", () => {
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? "");
    if (!/^\/piccadilly_(?:vitest|e2e)_[0-9a-f]{32}$/u.test(target.pathname) || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) throw new Error("T05_TEMPORARY_DATABASE_REQUIRED");
    await prisma.restaurant.createMany({ data: [{ id: restaurantId, name: "T05 synthetic", timezone: "Europe/Rome" }, { id: otherRestaurantId, name: "T05 other synthetic", timezone: "Europe/Rome" }] });
    await prisma.user.createMany({ data: [{ id: adminId, restaurantId, role: "ADMIN", username: `t05.admin.${adminId}`, passwordHash: "synthetic" }, { id: staffId, restaurantId, role: "STAFF", username: `t05.staff.${staffId}`, passwordHash: "synthetic" }, { id: otherStaffId, restaurantId: otherRestaurantId, role: "STAFF", username: `t05.other.${otherStaffId}`, passwordHash: "synthetic" }, { id: passwordId, restaurantId, role: "ADMIN", username: `t05.password.${passwordId}`, passwordHash: "synthetic", mustChangePassword: true }] });
    for (const id of [restaurantId, otherRestaurantId]) {
      await prisma.restaurantBookingSettings.create({ data: { restaurantId: id, rollingCapacityCovers: 30, rollingWindowMinutes: 30, lunchModificationCutoff: operationalTimeToDatabase("10:30"), dinnerModificationCutoff: operationalTimeToDatabase("17:30") } });
      await prisma.restaurantNotificationSettings.create({ data: { restaurantId: id, strategy: "WHATSAPP_ONLY" } });
      await prisma.weeklyServiceSchedule.createMany({ data: DAY_OF_WEEK_VALUES.flatMap((dayOfWeek) => SERVICE_TYPE_VALUES.map((serviceType) => ({ restaurantId: id, dayOfWeek, serviceType, isEnabled: true, startTime: operationalTimeToDatabase(DEFAULT_SERVICE_TIMES[serviceType].startTime), endTime: operationalTimeToDatabase(DEFAULT_SERVICE_TIMES[serviceType].endTime), slotIntervalMinutes: 15 }))) });
      await prisma.room.createMany({ data: DEMO_ROOMS.map((value) => ({ restaurantId: id, ...value })) });
      for (const value of DEMO_ROOMS) await prisma.diningTable.create({ data: { roomId: (await room(value.code, id)).id, name: `T05 ${value.code}`, minimumSeats: 1, maximumSeats: 2, displayOrder: 1 } });
    }
    for (const [name, id] of Object.entries({ staff: staffId, admin: adminId, other: otherStaffId, password: passwordId })) cookies[name] = `${getSessionCookieName(getAppEnvironment())}=${(await createSessionForUser(id)).token}`;
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await prisma.session.deleteMany({ where: { user: { restaurantId: tenant } } });
    await prisma.diningTable.deleteMany({ where: { room: { restaurantId: tenant } } });
    await prisma.room.deleteMany({ where: { restaurantId: tenant } });
    await prisma.weeklyServiceSchedule.deleteMany({ where: { restaurantId: tenant } });
    await prisma.restaurantBookingSettings.deleteMany({ where: { restaurantId: tenant } });
    await prisma.restaurantNotificationSettings.deleteMany({ where: { restaurantId: tenant } });
    await prisma.user.deleteMany({ where: { restaurantId: tenant } });
    await prisma.restaurant.deleteMany({ where: { id: tenant } });
    expect(await prisma.restaurant.count({ where: { id: tenant } })).toBe(0);
    console.info("T05_HTTP_POSTGRESQL_EVIDENCE", JSON.stringify({ database: new URL(process.env.DATABASE_URL!).pathname.slice(1), http: httpEvidence, fixtureTenantRowsAfter: 0 }));
    cookies = {};
    await prisma.$disconnect();
  });

  it("P01 virtual policy, GET/preview/no-op never materialize", async () => {
    const before = await snapshot();
    const configuration = await getAdminRoomConfiguration(admin, { localDate: date, serviceType: "DINNER", now });
    expect(configuration.service.lifecycle).toBe("VIRTUAL");
    expect(configuration.service.rooms.map((value) => value.isAvailable)).toEqual([true, true, true, false, false]);
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: "DINNER", roomId: (await room("sala-3")).id, isAvailable: true } as const;
    const preview = await previewRoomConfigurationChange(admin, proposal, { now });
    expect(preview.changed).toBe(false);
    expect(await configure(proposal)).toEqual({ changed: false });
    expect((await adminHttp("GET")).status).toBe(200);
    expect((await adminHttp("PREVIEW", { body: proposal })).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });
  it("P02 local explicit enable is isolated by date/service and materializes five rows", async () => {
    await availability("galleria", true, date, "LUNCH");
    const lunch = await getAdminRoomConfiguration(admin, { localDate: date, serviceType: "LUNCH", now });
    const dinner = await getAdminRoomConfiguration(admin, { localDate: date, serviceType: "DINNER", now });
    const otherDate = await getAdminRoomConfiguration(admin, { localDate: "2099-07-11", serviceType: "LUNCH", now });
    expect(lunch.service.rooms.map((value) => value.isAvailable)).toEqual([true, true, true, true, false]);
    expect(dinner.service.rooms.map((value) => value.isAvailable)).toEqual([true, true, true, false, false]);
    expect(otherDate.service.rooms.map((value) => value.isAvailable)).toEqual([true, true, true, false, false]);
    expect((await snapshot()).instances).toHaveLength(1);
    expect((await snapshot()).availability).toHaveLength(5);
    expect((await snapshot()).instances[0].version).toBe(2);
    expect((await snapshot()).adminAudits.map((value) => value.action)).toEqual(["ROOM_AVAILABILITY_UPDATED"]);
  });
  it("P03 main local disable and closed service cannot be overridden by category", async () => {
    const value = await reservation();
    await availability("sala-3", false);
    await expect(assign(value.id, "sala-3")).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
    await prisma.weeklyServiceSchedule.updateMany({ where: { restaurantId, serviceType: "DINNER" }, data: { isEnabled: false } });
    const configuration = await getAdminRoomConfiguration(admin, { localDate: date, serviceType: "DINNER", now });
    expect(configuration.service.service.isOpen).toBe(false);
    expect(configuration.service.rooms.every((item) => !item.isAvailable)).toBe(true);
    await expect(assign(value.id, "sala-1")).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
    await prisma.weeklyServiceSchedule.updateMany({ where: { restaurantId, serviceType: "DINNER" }, data: { isEnabled: true } });
  });
  it("P04 global disable/re-enable preserves configured availability and assignment", async () => {
    await availability("galleria", true);
    const value = await reservation(); await assign(value.id, "galleria");
    const before = await snapshot();
    await global("galleria", false);
    const disabled = await getAdminRoomConfiguration(admin, { localDate: date, serviceType: "DINNER", now });
    expect(disabled.service.rooms.find((item) => item.id === (before.rooms.find((item) => item.restaurantId === restaurantId && item.code === "galleria")?.id))).toMatchObject({ configuredAvailable: true, isAvailable: false });
    await global("galleria", true);
    const after = await snapshot();
    expect(after.availability).toEqual(before.availability);
    expect(after.assignments).toEqual(before.assignments); expect(after.reservations).toEqual(before.reservations);
    expect((await getAdminRoomConfiguration(admin, { localDate: date, serviceType: "DINNER", now })).service.rooms.find((item) => item.id === after.assignments[0].roomId)?.isAvailable).toBe(true);
  });
  it.each(["sala-3", "galleria"])("P05 room-only %s preserves raw identity and audit count0", async (code) => {
    if (code === "galleria") await availability(code, true);
    const value = await reservation(); const raw = await room(code);
    await assign(value.id, code);
    const state = await snapshot();
    expect(state.reservations[0].version).toBe(2); expect(state.links).toEqual([]);
    expect(state.assignments[0]).toMatchObject({ roomId: raw.id, clearedAt: null });
    expect(state.audits).toHaveLength(1); expect(state.audits[0].action).toBe("ASSIGNED");
    expect(state.audits[0].newState).toMatchObject({ assignment: { tableIds: [], tableCount: 0 } });
    expect(await room(code)).toEqual(raw);
  });
  it("P06 disabled legacy stale identical no-op preserves both timestamps, links, audit and raw bytes", async () => {
    await availability("galleria", true);
    const value = await reservation(); await assign(value.id, "galleria"); await global("galleria", false);
    const before = await snapshot();
    const context = await getReservationAssignmentContext({ actor, reservationId: value.id, now });
    expect(context.assignment?.room.isActive).toBe(false);
    expect(await assign(value.id, "galleria", 1)).toMatchObject({ changed: false, reservationVersion: 2 });
    expect(await snapshot()).toEqual(before);
  });
  it("P07 grandfathered room is retained; new inactive/mismatched tables remain invalid", async () => {
    await availability("galleria", true); const value = await reservation(); const retained = await table("galleria");
    await assign(value.id, "galleria", 1, [retained.id]); await global("galleria", false);
    await prisma.diningTable.update({ where: { id: retained.id }, data: { isActive: false } });
    expect(await assign(value.id, "galleria", 2, [retained.id], "Changed notes")).toMatchObject({ changed: true, reservationVersion: 3 });
    const foreign = await table("sala-3");
    await expect(assign(value.id, "galleria", 3, [foreign.id])).rejects.toMatchObject({ code: "VALIDATION" });
    const newInactive = await prisma.diningTable.create({ data: { roomId: retained.roomId, name: "T05 inactive", minimumSeats: 1, maximumSeats: 2, displayOrder: 2, isActive: false } });
    try { await expect(assign(value.id, "galleria", 3, [newInactive.id])).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" }); } finally { await prisma.diningTable.delete({ where: { id: newInactive.id } }); }
  });
  it("P08 cleared legacy cannot reactivate while unavailable", async () => {
    await availability("galleria", true); const value = await reservation(); await assign(value.id, "galleria"); await availability("galleria", false);
    await deleteReservationAssignment({ actor, reservationId: value.id, rawPayload: { version: 2 }, now });
    const before = await snapshot(); await expect(assign(value.id, "galleria", 3)).rejects.toMatchObject({ code: "ROOM_UNAVAILABLE" });
    expect(await snapshot()).toEqual(before); expect(before.assignments[0].clearedAt).not.toBeNull();
  });
  it("P09 all derived states, add/remove tables, change room, clear/reactivate and summary", async () => {
    const value = await reservation();
    await assign(value.id, "sala-3"); const identity = (await snapshot()).assignments[0];
    await assign(value.id, "sala-3", 2, [(await table("sala-3")).id]);
    expect((await snapshot()).links).toHaveLength(1);
    await assign(value.id, "sala-3", 3); expect((await snapshot()).links).toHaveLength(0);
    await assign(value.id, "sala-2", 4, [(await table("sala-2")).id]);
    await assign(value.id, "sala-1", 5); expect((await snapshot()).links).toHaveLength(0);
    const dashboard = await getDashboardDay({ restaurantId, rawDate: date, now });
    expect(dashboard.summary).toMatchObject({ assignedReservations: 1, unassignedReservations: 0, confirmedCovers: 4 });
    expect(dashboard.summary.finalRoomCovers.find((item) => item.code === "sala-1")?.covers).toBe(4);
    await deleteReservationAssignment({ actor, reservationId: value.id, rawPayload: { version: 6 }, now });
    const cleared = await snapshot();
    expect(await deleteReservationAssignment({ actor, reservationId: value.id, rawPayload: { version: 1 }, now })).toMatchObject({ changed: false, reservationVersion: 7 });
    expect(await snapshot()).toEqual(cleared);
    await assign(value.id, "sala-3", 7);
    expect((await snapshot()).assignments[0]).toMatchObject({ id: identity.id, assignedByUserId: identity.assignedByUserId, clearedAt: null });
  });
  it.each([{ childrenCount: 1, gameRoomPreference: true }, { childrenCount: 0, gameRoomPreference: null }, { childrenCount: null, gameRoomPreference: null, children: true }])("P10 composition/games/unknown/arrival/raw legacy remain independent (%j)", async (composition) => {
    const value = await reservation(composition); await availability("galleria", true);
    for (const [index, code] of ["sala-1", "sala-3", "galleria"].entries()) await assign(value.id, code, index + 1);
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id: value.id } });
    expect({ ...after, version: value.version, updatedAt: value.updatedAt }).toEqual(value);
    expect((await snapshot()).outbox).toEqual([]);
  });
  it("P11 real reschedule clears atomically and cancelled history rejects PUT/DELETE409", async () => {
    const value = await reservation({ childrenCount: 1, gameRoomPreference: true }); await assign(value.id, "sala-3");
    await updateStaffReservation({ actor: { ...actor, role: "STAFF" }, reservationId: value.id, now, rawPayload: { version: 2, localDate: date, serviceType: "DINNER", arrivalTime: "19:15", partySize: 4, childrenCount: 1, gameRoomPreference: true, customerFirstName: value.customerFirstName, customerLastName: value.customerLastName, customerPhone: value.customerPhone, customerEmail: value.customerEmail, highChair: false, stroller: false, accessibility: false, celiac: false, allergies: null, intolerances: null, celebration: null, animals: false, notes: value.notes, capacityOverride: false, capacityOverrideReason: null } });
    expect((await snapshot()).assignments[0].clearedAt).not.toBeNull();
    const events = (await snapshot()).audits; expect(events.map((item) => item.action)).toContain("UNASSIGNED");
    const unassigned = events.find((item) => item.action === "UNASSIGNED")!; expect(JSON.stringify(unassigned)).toContain("RESERVATION_SCHEDULE_CHANGED");
    expect(unassigned.correlationId).toBe(events.find((item) => item.action === "UPDATED")?.correlationId);
    await assign(value.id, "sala-3", 3);
    await prisma.reservation.update({ where: { id: value.id }, data: { status: "CANCELLED", cancelledAt: now } });
    const before = await snapshot(); expect((await http("GET", value.id)).status).toBe(200);
    for (const method of ["PUT", "DELETE"] as const) expect(await http(method, value.id, { body: method === "PUT" ? { version: 4, roomId: (await room("sala-3")).id, tableIds: [], internalNotes: "T05 synthetic internal note" } : { version: 4 } })).toMatchObject({ status: 409, body: { code: "RESERVATION_CANCELLED" } });
    expect(await snapshot()).toEqual(before);
    const historical = await reservation({ localDate: "2020-01-01" });
    await availability("sala-3", false); await assign(historical.id, "sala-3");
    expect((await snapshot()).instances).toHaveLength(1);
  });
  it("P12 genuinely concurrent identical/different PUTs preserve single write/version/audit", async () => {
    const identical = await reservation();
    const result = await Promise.all([assign(identical.id, "sala-3"), assign(identical.id, "sala-3")]);
    expect(result.map((item) => item.changed).sort()).toEqual([false, true]);
    expect((await snapshot()).audits).toHaveLength(1);
    const different = await reservation();
    const race = await Promise.allSettled([assign(different.id, "sala-1"), assign(different.id, "sala-3")]);
    expect(race.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(race.find((item) => item.status === "rejected")).toMatchObject({ reason: { code: "VERSION_CONFLICT" } });
    expect((await snapshot()).reservations.map((item) => item.version)).toEqual([2, 2]);
    expect((await snapshot()).audits).toHaveLength(2);
    console.info("T05_CONCURRENCY_EVIDENCE", JSON.stringify({ identical: result.map((item) => item.changed), different: race.map((item) => item.status === "fulfilled" ? "MUTATION" : item.reason.code), finalVersions: [2, 2], assignmentAuditCount: 2 }));
  });
  it("P13 Admin disable / Staff assignment real race admits only serialized outcomes", async () => {
    await availability("galleria", true); const value = await reservation();
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: "DINNER", roomId: (await room("galleria")).id, isAvailable: false } as const;
    const preview = await previewRoomConfigurationChange(admin, proposal, { now });
    const race = await Promise.allSettled([applyRoomConfigurationChange(admin, { proposal, fingerprint: preview.fingerprint }, { now }), assign(value.id, "galleria")]);
    if (race[0].status === "rejected") { expect(race[0].reason).toMatchObject({ code: "IMPACT_CHANGED" }); await configure(proposal); }
    if (race[1].status === "rejected") expect(race[1].reason).toMatchObject({ code: "ROOM_UNAVAILABLE" });
    else expect((await getReservationAssignmentContext({ actor, reservationId: value.id, now })).assignment).toMatchObject({ hasUnavailableRoomReference: true });
    expect((await getAdminRoomConfiguration(admin, { localDate: date, serviceType: "DINNER", now })).service.rooms.find((item) => item.id === proposal.roomId)?.isAvailable).toBe(false);
    console.info("T05_ADMIN_STAFF_RACE_EVIDENCE", JSON.stringify({ outcomes: race.map((item) => item.status === "fulfilled" ? "MUTATION" : item.reason.code), finalEffectiveAvailable: false, serializedOutcomesVerified: true }));
  });
  it("P14 preview changed by assignment yields IMPACT_CHANGED before any write; games is not physical impact", async () => {
    const value = await reservation({ childrenCount: 1, gameRoomPreference: true });
    await prisma.reservation.update({ where: { id: value.id }, data: { preferences: JSON.stringify({ highChair: false, stroller: false, accessibility: false, children: true, celebration: null, animals: false }) } });
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: "DINNER", roomId: (await room("sala-3")).id, isAvailable: false } as const;
    const preview = await previewRoomConfigurationChange(admin, proposal, { now });
    expect(preview.impact.reservationCount).toBe(0);
    await assign(value.id, "sala-3"); const before = await snapshot();
    await expect(applyRoomConfigurationChange(admin, { proposal, fingerprint: preview.fingerprint }, { now })).rejects.toMatchObject({ code: "IMPACT_CHANGED" });
    expect(await snapshot()).toEqual(before);
    const real = await adminHttp("PREVIEW", { body: proposal }); expect(real.status).toBe(200);
    await assign(value.id, "sala-1", 2);
    expect(await adminHttp("APPLY", { body: { proposal, fingerprint: real.body.preview.fingerprint } })).toMatchObject({ status: 409, body: { code: "IMPACT_CHANGED" } });
  });
  it.each(["config", "assignment"] as const)("P15 %s real audit failure safely rolls back entire transaction", async (kind) => {
    const value = await reservation(); if (kind === "assignment") await assign(value.id, "sala-3", 1, [(await table("sala-3")).id]);
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate: date, serviceType: "DINNER", roomId: (await room("galleria")).id, isAvailable: true } as const;
    const preview = await adminHttp("PREVIEW", { body: proposal }); expect(preview.status).toBe(200);
    await prisma.reservationManagementToken.create({ data: { reservationId: value.id, tokenHash: randomUUID().replaceAll("-", "").repeat(2), viewExpiresAt: new Date("2099-07-11T17:00:00.000Z") } });
    const before = await snapshot(); const auditTable = kind === "config" ? "audit_events" : "reservation_audit_events";
    await prisma.$executeRawUnsafe(`CREATE FUNCTION t05_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.restaurant_id='${restaurantId}'::uuid THEN RAISE EXCEPTION 'synthetic private T05 audit failure'; END IF; RETURN NEW; END; $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER t05_failure BEFORE INSERT ON ${auditTable} FOR EACH ROW EXECUTE FUNCTION t05_failure()`);
    try {
      const response = kind === "config" ? await adminHttp("APPLY", { body: { proposal, fingerprint: preview.body.preview.fingerprint } }) : await http("PUT", value.id, { body: { version: 2, roomId: (await room("sala-1")).id, tableIds: [], internalNotes: "Changed" } });
      expect(response.status).toBe(500); expect(Object.keys(response.body)).toEqual(["error"]);
      expect(JSON.stringify(response.body)).not.toMatch(/synthetic|private|Prisma|stack|query/u);
      expect(await snapshot()).toEqual(before);
      console.info("T05_ROLLBACK_EVIDENCE", JSON.stringify({ kind, realAuditTriggerFailure: true, httpStatus: response.status, entireFixtureSnapshotUnchanged: true, managementTokenPreserved: true, outboxUnchanged: true }));
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER t05_failure ON ${auditTable}`); await prisma.$executeRawUnsafe("DROP FUNCTION t05_failure()");
    }
  });
  it("P16 same-table reuse remains valid without capacity/outbox side effects", async () => {
    const first = await reservation(), second = await reservation(); const selected = await table("sala-3");
    await Promise.all([assign(first.id, "sala-3", 1, [selected.id]), assign(second.id, "sala-3", 1, [selected.id])]);
    expect((await snapshot()).links.map((item) => item.diningTableId)).toEqual([selected.id, selected.id]);
    expect((await snapshot()).outbox).toEqual([]);
  });
  it("P17 real HTTP auth/origin/password/tenant/strict/status/no-store contracts", async () => {
    const value = await reservation(); const payload = { version: 1, roomId: (await room("sala-3")).id, tableIds: [], internalNotes: null };
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const body = method === "DELETE" ? { version: 1 } : payload;
      expect(await http(method, value.id, { cookie: "", body })).toMatchObject({ status: 401, body: { error: "Unauthorized" } });
      expect(await http(method, value.id, { cookie: cookies.password, body })).toMatchObject({ status: 403, body: { error: "PASSWORD_CHANGE_REQUIRED" } });
      const missing = await http(method, randomUUID(), { body });
      expect(missing).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
      expect(await http(method, value.id, { cookie: cookies.other, body })).toEqual(missing);
    }
    for (const method of ["PUT", "DELETE"] as const) {
      expect((await http(method, value.id, { origin: "https://cross-origin.invalid", body: payload })).status).toBe(403);
      expect((await http(method, value.id, { invalidJson: true })).status).toBe(400);
      expect((await http(method, value.id, { contentType: "text/plain", body: payload })).status).toBe(400);
      expect((await http(method, value.id, { body: method === "PUT" ? { ...payload, tenant: restaurantId } : { version: 1, extra: true } })).status).toBe(400);
    }
    for (const body of [{ ...payload, roomId: (await room("sala-3", otherRestaurantId)).id }, { ...payload, tableIds: [(await table("sala-1")).id] }, { ...payload, version: 0 }, { ...payload, tableIds: ["invalid"] }, { ...payload, roomId: undefined }]) expect(await http("PUT", value.id, { body })).toMatchObject({ status: 400, body: { code: "VALIDATION" } });
    expect((await http("PUT", value.id, { body: payload })).status).toBe(200);
    expect(await http("PUT", value.id, { body: { ...payload, internalNotes: "Changed stale" } })).toMatchObject({ status: 409, body: { code: "VERSION_CONFLICT" } });
    expect((await http("DELETE", value.id, { body: { version: 2 } })).status).toBe(200);
    expect((await http("PUT", value.id, { body: { ...payload, version: 3, roomId: (await room("terrazzo")).id } })).status).toBe(409);
    const proposal = { kind: "ROOM_CATALOG", roomId: (await room("sala-3")).id, isActive: true, displayOrder: 3 };
    for (const kind of ["GET", "PREVIEW", "APPLY"] as const) {
      expect((await adminHttp(kind, { cookie: "", body: proposal })).status).toBe(401);
      expect((await adminHttp(kind, { cookie: cookies.staff, body: proposal })).status).toBe(403);
      expect((await adminHttp(kind, { cookie: cookies.password, body: proposal })).status).toBe(403);
    }
    expect((await adminHttp("PREVIEW", { origin: "https://cross-origin.invalid", body: proposal })).status).toBe(403);
    expect((await adminHttp("PREVIEW", { contentType: "text/plain", body: proposal })).status).toBe(415);
    expect((await adminHttp("PREVIEW", { body: { ...proposal, rename: "Not allowed" } })).status).toBe(400);
    expect((await adminHttp("PREVIEW", { body: { ...proposal, roomId: (await room("sala-3", otherRestaurantId)).id } })).status).toBe(404);
  });
  it("P18 DTO/API raw stay canonical; display adapter does not write or serialize Prisma", async () => {
    const value = await reservation(); await assign(value.id, "sala-3"); const before = await snapshot();
    const response = await http("GET", value.id);
    expect(response.status).toBe(200); expect(response.body.assignment.room).toMatchObject({ id: (await room("sala-3")).id, code: "sala-3", name: "Sala 3" });
    expect(roomOperationalPresentation(response.body.assignment.room)).toEqual({ label: "Sala 3 — Giochi", category: "MAIN" });
    expect(response.body).not.toHaveProperty("restaurantId"); expect(response.body.assignment).not.toHaveProperty("createdByUserId"); expect(response.body.assignment).not.toHaveProperty("reservationId");
    expect((await adminHttp("GET")).body.configuration.rooms.find((item: { code: string }) => item.code === "sala-3").name).toBe("Sala 3");
    expect(await snapshot()).toEqual(before);
  });
});
