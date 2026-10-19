import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/server/db/prisma";
import { operationalTimeToDatabase, localDateToDatabase } from "@/modules/configuration/domain/operational-time";
import { DAY_OF_WEEK_VALUES, DEFAULT_SLOT_INTERVAL_MINUTES } from "@/modules/configuration/domain/defaults";
import { readRoomAssignmentWorkspace } from "@/modules/rooms/infrastructure/room-assignment-workspace-repository";
import { getRoomAssignmentWorkspace } from "./room-assignment-workspace-query";
import { assignReservationRoom } from "./reservation-assignment-service";

const tenant = randomUUID(), actor = randomUUID(), roomId = randomUUID(), secondary = randomUUID();
const date = "2099-10-19", now = new Date("2099-10-18T10:00:00Z");
const query = { date, service: "DINNER" as const, room: "ALL" as const, order: "ARRIVAL" as const };
const owner = { id: actor, restaurantId: tenant };
async function reservation(extra = {}) {
  return prisma.reservation.create({ data: { restaurantId: tenant, localDate: localDateToDatabase(date), serviceType: "DINNER", arrivalTime: operationalTimeToDatabase("19:00"), partySize: 4, childrenCount: 1, gameRoomPreference: false, createdByUserId: actor, origin: "PHONE", status: "CONFIRMED", customerFirstName: "Synthetic", customerLastName: "Workspace", customerPhone: "+390000009999", notes: "NC_PRIVACY_MARKER", privateNotes: "NI_PRIVACY_MARKER", privacyPolicyVersion: "synthetic", privacyConsentAt: now, privacyConsentMethod: "VERBAL", cancelledAt: "status" in extra && extra.status === "CANCELLED" ? now : null, preferences: JSON.stringify({ roomCode: "", highChair: false, stroller: false, accessibility: true, children: true, celebration: null, animals: false }), ...extra } });
}
describe.sequential("T06-C snapshot, presence projection and bounded queries", () => {
  beforeAll(async () => {
    await prisma.restaurant.create({ data: { id: tenant, name: "Synthetic T06-C", timezone: "Europe/Rome" } });
    await prisma.user.create({ data: { id: actor, restaurantId: tenant, username: "t06c-" + actor, passwordHash: "not-a-password", role: "STAFF" } });
    await prisma.restaurantBookingSettings.create({ data: { restaurantId: tenant, rollingCapacityCovers: 100, rollingWindowMinutes: 30, lunchModificationCutoff: operationalTimeToDatabase("10:00"), dinnerModificationCutoff: operationalTimeToDatabase("18:00"), managementLinkDurationHours: 24 } });
    await prisma.weeklyServiceSchedule.createMany({ data: DAY_OF_WEEK_VALUES.map(dayOfWeek => ({ restaurantId: tenant, dayOfWeek, serviceType: "DINNER", isEnabled: true, startTime: operationalTimeToDatabase("19:00"), endTime: operationalTimeToDatabase("22:00"), slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES })) });
    await prisma.room.createMany({ data: [{ id: roomId, restaurantId: tenant, code: "sala-1", name: "Sala 1", serviceAvailabilityPolicy: "DEFAULT_AVAILABLE" }, { id: secondary, restaurantId: tenant, code: "galleria", name: "Galleria", serviceAvailabilityPolicy: "EXPLICIT_ONLY" }] });
  });
  afterAll(async () => {
    await prisma.reservationAuditEvent.deleteMany({ where: { restaurantId: tenant } });
    await prisma.reservationAssignment.deleteMany({ where: { restaurantId: tenant } });
    await prisma.reservation.deleteMany({ where: { restaurantId: tenant } });
    await prisma.weeklyServiceSchedule.deleteMany({ where: { restaurantId: tenant } });
    await prisma.restaurantBookingSettings.deleteMany({ where: { restaurantId: tenant } });
    await prisma.room.deleteMany({ where: { restaurantId: tenant } });
    await prisma.user.deleteMany({ where: { restaurantId: tenant } });
    await prisma.restaurant.delete({ where: { id: tenant } });
  });
  it("exposes presence only, counts confirmed records and preserves EXPLICIT_ONLY", async () => {
    const r = await reservation(); await reservation({ status: "CANCELLED" }); await reservation({ localDate: localDateToDatabase("2099-10-20") });
    await assignReservationRoom({ actor: owner, reservationId: r.id, rawPayload: { version: 1, roomId, expectedLocalDate: date, expectedServiceType: "DINNER" }, now });
    const data = await getRoomAssignmentWorkspace({ actor: owner, rawQuery: query, now });
    expect(data.reservations).toHaveLength(1); expect(data.reservations[0]).toMatchObject({ notesPresent: true, privateNotesPresent: true, legacyNotesPresent: false, roomAssignedAt: now.toISOString() });
    expect(data.rooms.find(r => r.id === roomId)).toMatchObject({ reservations: 1, covers: 4, isAvailable: true });
    expect(data.rooms.find(r => r.id === secondary)?.isAvailable).toBe(false);
    const serialized = JSON.stringify(data); for (const forbidden of ["NI_PRIVACY_MARKER", "NC_PRIVACY_MARKER", "+390000009999", "privateNotes\"", "internalNotes\""]) expect(serialized).not.toContain(forbidden);
    expect(await prisma.serviceInstance.count({ where: { restaurantId: tenant } })).toBe(0);
  });
  it("keeps query count constant as reservations grow, without logging parameters", async () => {
    const measured = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }), log: [{ emit: "event", level: "query" }] });
    let count = 0; measured.$on("query", () => { count++; });
    try {
      await readRoomAssignmentWorkspace({ actor: owner, query, now }, measured); const first = count;
      for (let i = 0; i < 5; i++) await reservation(); count = 0;
      await readRoomAssignmentWorkspace({ actor: owner, query, now }, measured); expect(count).toBe(first);
    } finally { await measured.$disconnect(); }
  });
  it("rejects mismatched tenant and invalid query without broadening reads", async () => {
    await expect(getRoomAssignmentWorkspace({ actor: { id: actor, restaurantId: randomUUID() }, rawQuery: query, now })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getRoomAssignmentWorkspace({ actor: owner, rawQuery: { ...query, q: "PII" }, now })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
