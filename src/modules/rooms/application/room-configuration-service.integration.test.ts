import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DAY_OF_WEEK_VALUES, DEFAULT_SERVICE_TIMES, DEMO_ROOMS, SERVICE_TYPE_VALUES } from "@/modules/configuration/domain/defaults";
import { operationalTimeToDatabase } from "@/modules/configuration/domain/operational-time";
import { createReservation } from "@/modules/reservations/application/reservation-service";
import { applyRoomConfigurationChange, getAdminRoomConfiguration, mutateDiningTable, previewRoomConfigurationChange, RoomConfigurationImpactChangedError } from "@/modules/rooms/application/room-configuration-service";
import { readEffectiveServiceRooms } from "@/modules/rooms/infrastructure/service-instance-repository";
import { prisma } from "@/server/db/prisma";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const adminId = randomUUID();
const secondAdminId = randomUUID();
const staffId = randomUUID();
const mustChangeId = randomUUID();
const now = new Date("2099-01-01T10:00:00.000Z");
const localDate = "2099-01-05";
const actor = { id: adminId, restaurantId };

async function cleanRuntime() {
  await prisma.auditEvent.deleteMany({ where: { restaurantId } });
  await prisma.reservationIdempotencyKey.deleteMany({ where: { restaurantId } });
  await prisma.reservation.deleteMany({ where: { restaurantId } });
  await prisma.serviceRoomAvailability.deleteMany({ where: { restaurantId } });
  await prisma.serviceInstance.deleteMany({ where: { restaurantId } });
  await prisma.diningTable.deleteMany({ where: { room: { restaurantId } } });
  for (const room of DEMO_ROOMS) {
    await prisma.room.updateMany({
      where: { restaurantId, code: room.code },
      data: { isActive: true, displayOrder: room.displayOrder },
    });
  }
}

describe.sequential("M9-D service rooms and table lifecycle", () => {
  beforeAll(async () => {
    await prisma.restaurant.createMany({ data: [
      { id: restaurantId, name: "M9-D Fake", timezone: "Europe/Rome" },
      { id: otherRestaurantId, name: "M9-D Other", timezone: "Europe/Rome" },
    ] });
    await prisma.user.createMany({ data: [
      { id: adminId, restaurantId, username: `m9d.admin.${adminId}`, passwordHash: "fake", role: "ADMIN" },
      { id: secondAdminId, restaurantId, username: `m9d.admin2.${secondAdminId}`, passwordHash: "fake", role: "ADMIN" },
      { id: staffId, restaurantId, username: `m9d.staff.${staffId}`, passwordHash: "fake", role: "STAFF" },
      { id: mustChangeId, restaurantId, username: `m9d.change.${mustChangeId}`, passwordHash: "fake", role: "ADMIN", mustChangePassword: true },
    ] });
    await prisma.restaurantBookingSettings.create({ data: { restaurantId, rollingCapacityCovers: 30, rollingWindowMinutes: 30, lunchModificationCutoff: operationalTimeToDatabase("10:30"), dinnerModificationCutoff: operationalTimeToDatabase("17:30") } });
    await prisma.weeklyServiceSchedule.createMany({ data: DAY_OF_WEEK_VALUES.flatMap((dayOfWeek) => SERVICE_TYPE_VALUES.map((serviceType) => ({ restaurantId, dayOfWeek, serviceType, isEnabled: true, startTime: operationalTimeToDatabase(DEFAULT_SERVICE_TIMES[serviceType].startTime), endTime: operationalTimeToDatabase(DEFAULT_SERVICE_TIMES[serviceType].endTime), slotIntervalMinutes: 15 }))) });
    await prisma.room.createMany({ data: DEMO_ROOMS.map((room) => ({ restaurantId, ...room })) });
  });

  beforeEach(cleanRuntime);

  afterAll(async () => {
    await cleanRuntime();
    await prisma.room.deleteMany({ where: { restaurantId } });
    await prisma.weeklyServiceSchedule.deleteMany({ where: { restaurantId } });
    await prisma.restaurantBookingSettings.deleteMany({ where: { restaurantId } });
    await prisma.user.deleteMany({ where: { restaurantId: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.restaurant.deleteMany({ where: { id: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.$disconnect();
  });

  it("keeps GET virtual and applies fixed default policies without writes", async () => {
    const result = await getAdminRoomConfiguration(actor, { localDate, serviceType: "DINNER", now });
    expect(result.service.lifecycle).toBe("VIRTUAL");
    expect(result.rooms.map((room) => room.name)).toEqual(["Sala 1", "Sala 2", "Sala 3", "Galleria", "Terrazzo"]);
    expect(result.service.rooms.map((room) => room.configuredAvailable)).toEqual([true, true, true, false, false]);
    expect(result.rooms.some((room) => room.name === "DA ASSEGNARE")).toBe(false);
    await expect(prisma.serviceInstance.count({ where: { restaurantId } })).resolves.toBe(0);
  });

  it("keeps preview and no-op apply free of writes and audit", async () => {
    const room = await prisma.room.findFirstOrThrow({ where: { restaurantId, code: "sala-1" } });
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate, serviceType: "DINNER", roomId: room.id, isAvailable: true } as const;
    const preview = await previewRoomConfigurationChange(actor, proposal, { now });
    expect(preview.changed).toBe(false);
    await expect(applyRoomConfigurationChange(actor, { proposal, fingerprint: preview.fingerprint }, { now })).resolves.toEqual({ changed: false });
    await expect(prisma.serviceInstance.count({ where: { restaurantId } })).resolves.toBe(0);
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
  });

  it("derives historical lifecycle and rejects changes without materializing", async () => {
    const historicalDate = "2098-12-31";
    const room = await prisma.room.findFirstOrThrow({ where: { restaurantId, code: "sala-1" } });
    const state = await getAdminRoomConfiguration(actor, {
      localDate: historicalDate,
      serviceType: "DINNER",
      now,
    });

    expect(state.service.lifecycle).toBe("HISTORICAL");
    await expect(
      previewRoomConfigurationChange(
        actor,
        {
          kind: "SERVICE_ROOM_AVAILABILITY",
          localDate: historicalDate,
          serviceType: "DINNER",
          roomId: room.id,
          isAvailable: false,
        },
        { now },
      ),
    ).rejects.toMatchObject({ code: "HISTORICAL" });
    await expect(prisma.serviceInstance.count({ where: { restaurantId } })).resolves.toBe(0);
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
  });

  it("materializes all rooms atomically on the first effective Admin change", async () => {
    const room = await prisma.room.findFirstOrThrow({ where: { restaurantId, code: "galleria" } });
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate, serviceType: "DINNER", roomId: room.id, isAvailable: true } as const;
    const preview = await previewRoomConfigurationChange(actor, proposal, { now });
    await applyRoomConfigurationChange(actor, { proposal, fingerprint: preview.fingerprint }, { now });
    const instance = await prisma.serviceInstance.findFirstOrThrow({ where: { restaurantId }, include: { roomAvailabilities: { orderBy: { room: { displayOrder: "asc" } } } } });
    expect(instance.roomAvailabilities).toHaveLength(5);
    expect(instance.version).toBe(2);
    expect(instance.roomAvailabilities.map((row) => row.isAvailable)).toEqual([true, true, true, true, false]);
    await expect(prisma.auditEvent.count({ where: { restaurantId, action: "ROOM_AVAILABILITY_UPDATED" } })).resolves.toBe(1);
  });

  it("rolls back materialization and availability when audit persistence fails", async () => {
    const room = await prisma.room.findFirstOrThrow({ where: { restaurantId, code: "galleria" } });
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate, serviceType: "DINNER", roomId: room.id, isAvailable: true } as const;
    const preview = await previewRoomConfigurationChange(actor, proposal, { now });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION m9d_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'ROOM_AVAILABILITY_UPDATED' AND NEW.restaurant_id = '${restaurantId}'::uuid THEN RAISE EXCEPTION 'synthetic M9-D audit failure'; END IF; RETURN NEW; END; $$;`);
    await prisma.$executeRawUnsafe("CREATE TRIGGER m9d_test_reject_audit_trigger BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION m9d_test_reject_audit()");

    try {
      await expect(
        applyRoomConfigurationChange(
          actor,
          { proposal, fingerprint: preview.fingerprint },
          { now },
        ),
      ).rejects.toThrow("synthetic M9-D audit failure");
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS m9d_test_reject_audit_trigger ON audit_events");
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS m9d_test_reject_audit()");
    }

    await expect(prisma.serviceInstance.count({ where: { restaurantId } })).resolves.toBe(0);
    await expect(prisma.serviceRoomAvailability.count({ where: { restaurantId } })).resolves.toBe(0);
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
  });

  it("materializes once with the first successful reservation", async () => {
    await createReservation({
      actor: { id: adminId, restaurantId, role: "ADMIN" },
      rawIdempotencyKey: randomUUID(),
      rawPayload: { localDate, serviceType: "LUNCH", arrivalTime: "12:00", partySize: 2, origin: "PHONE", customerFirstName: "Mario", customerLastName: "Finto", customerPhone: "+39000000000", customerEmail: "mario@example.invalid", notes: null, preferences: null, allergies: null, privacyConsentMethod: "VERBAL", capacityOverride: false, capacityOverrideReason: null },
      now,
      config: { privacyPolicyVersion: "privacy-fake-v1", termsVersion: "terms-fake-v1", idempotencyTtlMs: 86_400_000 },
    });
    const instances = await prisma.serviceInstance.findMany({ where: { restaurantId }, include: { roomAvailabilities: true } });
    expect(instances).toHaveLength(1);
    expect(instances[0]?.roomAvailabilities).toHaveLength(5);
    await expect(prisma.auditEvent.count({ where: { restaurantId, action: "ROOM_AVAILABILITY_UPDATED" } })).resolves.toBe(0);
  });

  it("aggregates only pertinent preferences and rejects a stale fingerprint before materialization", async () => {
    const room = await prisma.room.findFirstOrThrow({ where: { restaurantId, code: "sala-1" } });
    await prisma.reservation.createMany({ data: [
      { restaurantId, localDate: new Date(`${localDate}T00:00:00.000Z`), serviceType: "DINNER", arrivalTime: operationalTimeToDatabase("19:00"), partySize: 4, status: "CONFIRMED", origin: "PHONE", customerFirstName: "Fake", customerLastName: "One", customerPhone: "+39000000000", preferences: JSON.stringify({ roomCode: "sala-1", highChair: false, stroller: false, accessibility: false, children: false, celebration: null, animals: false }), privacyPolicyVersion: "fake", privacyConsentAt: now, privacyConsentMethod: "VERBAL", createdByUserId: adminId },
      { restaurantId, localDate: new Date(`${localDate}T00:00:00.000Z`), serviceType: "DINNER", arrivalTime: operationalTimeToDatabase("19:15"), partySize: 9, status: "CONFIRMED", origin: "PHONE", customerFirstName: "Fake", customerLastName: "Other", customerPhone: "+39000000000", preferences: JSON.stringify({ roomCode: "sala-2", highChair: false, stroller: false, accessibility: false, children: false, celebration: null, animals: false }), privacyPolicyVersion: "fake", privacyConsentAt: now, privacyConsentMethod: "VERBAL", createdByUserId: adminId },
    ] });
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate, serviceType: "DINNER", roomId: room.id, isAvailable: false } as const;
    const preview = await previewRoomConfigurationChange(actor, proposal, { now });
    expect(preview.impact).toMatchObject({ reservationCount: 1, covers: 4 });
    await prisma.room.update({ where: { id: room.id }, data: { isActive: false } });
    await expect(applyRoomConfigurationChange(actor, { proposal, fingerprint: preview.fingerprint }, { now })).rejects.toBeInstanceOf(RoomConfigurationImpactChangedError);
    await expect(prisma.serviceInstance.count({ where: { restaurantId } })).resolves.toBe(0);
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
  });

  it("preserves local availability through global disable and re-enable", async () => {
    const room = await prisma.room.findFirstOrThrow({ where: { restaurantId, code: "galleria" } });
    const enable = { kind: "SERVICE_ROOM_AVAILABILITY", localDate, serviceType: "DINNER", roomId: room.id, isAvailable: true } as const;
    const enablePreview = await previewRoomConfigurationChange(actor, enable, { now });
    await applyRoomConfigurationChange(actor, { proposal: enable, fingerprint: enablePreview.fingerprint }, { now });
    for (const isActive of [false, true]) {
      const proposal = { kind: "ROOM_CATALOG", roomId: room.id, displayOrder: room.displayOrder, isActive } as const;
      const preview = await previewRoomConfigurationChange(actor, proposal, { now });
      await applyRoomConfigurationChange(actor, { proposal, fingerprint: preview.fingerprint }, { now });
    }
    const state = await readEffectiveServiceRooms(prisma, { restaurantId, localDate, serviceType: "DINNER", now });
    expect(state.rooms.find((candidate) => candidate.id === room.id)).toMatchObject({ configuredAvailable: true, isAvailable: true });
    await expect(prisma.serviceRoomAvailability.count({ where: { restaurantId } })).resolves.toBe(5);
  });

  it("serializes two Admin confirmations without duplicate instances, rows or audit", async () => {
    const room = await prisma.room.findFirstOrThrow({ where: { restaurantId, code: "terrazzo" } });
    const proposal = { kind: "SERVICE_ROOM_AVAILABILITY", localDate, serviceType: "LUNCH", roomId: room.id, isAvailable: true } as const;
    const preview = await previewRoomConfigurationChange(actor, proposal, { now });
    const results = await Promise.allSettled([
      applyRoomConfigurationChange(actor, { proposal, fingerprint: preview.fingerprint }, { now }),
      applyRoomConfigurationChange({ id: secondAdminId, restaurantId }, { proposal, fingerprint: preview.fingerprint }, { now }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(prisma.serviceInstance.count({ where: { restaurantId } })).resolves.toBe(1);
    await expect(prisma.serviceRoomAvailability.count({ where: { restaurantId } })).resolves.toBe(5);
    await expect(prisma.auditEvent.count({ where: { restaurantId, action: "ROOM_AVAILABILITY_UPDATED" } })).resolves.toBe(1);
  });

  it("creates, updates, disables and re-enables a table without moving it", async () => {
    const room = await prisma.room.findFirstOrThrow({ where: { restaurantId, code: "sala-2" } });
    const created = await mutateDiningTable(actor, { action: "CREATE_TABLE", roomId: room.id, name: "T-FAKE", minimumSeats: 2, maximumSeats: 6, displayOrder: 1 }, { now });
    await mutateDiningTable(actor, { action: "UPDATE_TABLE", id: created.id, name: "T-FAKE", minimumSeats: 1, maximumSeats: 8, displayOrder: 2, isActive: false }, { now });
    await mutateDiningTable(actor, { action: "UPDATE_TABLE", id: created.id, name: "T-FAKE", minimumSeats: 1, maximumSeats: 8, displayOrder: 2, isActive: true }, { now });
    await expect(mutateDiningTable(actor, { action: "UPDATE_TABLE", id: created.id, roomId: randomUUID(), name: "T-FAKE", minimumSeats: 1, maximumSeats: 8, displayOrder: 2, isActive: true }, { now })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(prisma.diningTable.findUniqueOrThrow({ where: { id: created.id } })).resolves.toMatchObject({ roomId: room.id, isActive: true, maximumSeats: 8 });
  });

  it("rejects invalid capacity, duplicate names, staff, forced password change and cross-tenant identifiers", async () => {
    const room = await prisma.room.findFirstOrThrow({ where: { restaurantId, code: "sala-3" } });
    await expect(mutateDiningTable(actor, { action: "CREATE_TABLE", roomId: room.id, name: "Bad", minimumSeats: 4, maximumSeats: 2, displayOrder: 1 }, { now })).rejects.toMatchObject({ code: "VALIDATION" });
    await mutateDiningTable(actor, { action: "CREATE_TABLE", roomId: room.id, name: "Duplicate", minimumSeats: 2, maximumSeats: 4, displayOrder: 1 }, { now });
    await expect(mutateDiningTable(actor, { action: "CREATE_TABLE", roomId: room.id, name: "Duplicate", minimumSeats: 2, maximumSeats: 4, displayOrder: 2 }, { now })).rejects.toMatchObject({ code: "VALIDATION" });
    const proposal = { kind: "ROOM_CATALOG", roomId: room.id, displayOrder: 1, isActive: false } as const;
    await expect(previewRoomConfigurationChange({ id: staffId, restaurantId }, proposal, { now })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(previewRoomConfigurationChange({ id: mustChangeId, restaurantId }, proposal, { now })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(previewRoomConfigurationChange({ id: secondAdminId, restaurantId: otherRestaurantId }, proposal, { now })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
