import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getDashboardDay } from "@/modules/dashboard/application/dashboard-query";
import {
  DAY_OF_WEEK_VALUES,
  DEFAULT_BOOKING_CUTOFFS,
  DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
  DEFAULT_SERVICE_TIMES,
  DEFAULT_SLOT_INTERVAL_MINUTES,
  FIXED_ROLLING_WINDOW_MINUTES,
  SERVICE_TYPE_VALUES,
} from "@/modules/configuration/domain/defaults";
import {
  localDateToDatabase,
  operationalTimeToDatabase,
} from "@/modules/configuration/domain/operational-time";
import { ReservationApplicationError } from "@/modules/reservations/application/reservation-errors";
import {
  cancelManagedPublicReservation,
  createPublicReservation,
  readPublicReservation,
} from "@/modules/reservations/application/public-reservation-service";
import {
  cancelStaffReservation,
  createPhoneReservation,
  getStaffReservation,
  updateStaffReservation,
} from "@/modules/reservations/application/staff-reservation-service";
import { managementViewExpiry } from "@/modules/reservations/domain/management-time";
import {
  parsePublicAllergies,
  parsePublicPreferences,
} from "@/modules/reservations/domain/public-validation";
import { prisma } from "@/server/db/prisma";
import { hashLegacyPhoneReservationRequest } from "@/modules/reservations/domain/idempotency";
import { legacyPhoneReservationSchema } from "@/modules/reservations/domain/staff-validation";
import { serializePublicPreferences, serializePublicAllergies } from "@/modules/reservations/domain/public-validation";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const staffId = randomUUID();
const adminId = randomUUID();
const otherStaffId = randomUUID();
const roomId = randomUUID();
const otherRoomId = randomUUID();
const standardDate = "2099-08-10";
const movedDate = "2099-08-11";
const concurrencyDate = "2099-08-12";
const cancellationDate = "2099-08-13";
const overrideDate = "2099-08-14";
const publicDate = "2099-08-15";
const publicMovedDate = "2099-08-16";
const now = new Date("2099-01-10T10:00:00.000Z");
const managementSecret = "m8-public-management-secret-with-at-least-32-characters";
const config = {
  privacyPolicyVersion: "m8-test-privacy-v1",
  termsVersion: "m8-test-terms-v1",
  idempotencyTtlMs: 86_400_000,
};

const staffActor = { id: staffId, restaurantId, role: "STAFF" } as const;
const adminActor = { id: adminId, restaurantId, role: "ADMIN" } as const;
const otherStaffActor = {
  id: otherStaffId,
  restaurantId: otherRestaurantId,
  role: "STAFF",
} as const;

function bookingSettingsData(capacity = 4) {
  return {
    rollingCapacityCovers: capacity,
    rollingWindowMinutes: FIXED_ROLLING_WINDOW_MINUTES,
    lunchModificationCutoff: operationalTimeToDatabase(
      DEFAULT_BOOKING_CUTOFFS.lunchModificationCutoff,
    ),
    dinnerModificationCutoff: operationalTimeToDatabase(
      DEFAULT_BOOKING_CUTOFFS.dinnerModificationCutoff,
    ),
    managementLinkDurationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
  };
}

function weeklySchedules(targetRestaurantId: string) {
  return DAY_OF_WEEK_VALUES.flatMap((dayOfWeek) =>
    SERVICE_TYPE_VALUES.map((serviceType) => ({
      restaurantId: targetRestaurantId,
      dayOfWeek,
      serviceType,
      isEnabled: true,
      startTime: operationalTimeToDatabase(
        DEFAULT_SERVICE_TIMES[serviceType].startTime,
      ),
      endTime: operationalTimeToDatabase(
        DEFAULT_SERVICE_TIMES[serviceType].endTime,
      ),
      slotIntervalMinutes: DEFAULT_SLOT_INTERVAL_MINUTES,
    })),
  );
}

function phonePayload(overrides: Record<string, unknown> = {}) {
  return {
    localDate: standardDate,
    serviceType: "DINNER",
    arrivalTime: "19:00",
    partySize: 2,
    childrenCount: 1,
    gameRoomPreference: false,
    customerFirstName: "Cliente",
    customerLastName: "Telefonico Fittizio",
    customerPhone: "+39 000 000 0800",
    customerEmail: "m8@example.invalid",
    highChair: true,
    stroller: false,
    accessibility: false,
    celiac: false,
    allergies: "Dato fittizio",
    intolerances: null,
    celebration: null,
    animals: false,
    notes: "Nota esclusivamente fittizia M8",
    verbalConsentConfirmed: true,
    sendWhatsAppConfirmation: true,
    capacityOverride: false,
    capacityOverrideReason: null,
    ...overrides,
  };
}

function createPhone(
  actor: typeof staffActor | typeof adminActor | typeof otherStaffActor,
  overrides: Record<string, unknown> = {},
  key = randomUUID(),
) {
  return createPhoneReservation({
    actor,
    rawPayload: phonePayload(overrides),
    rawIdempotencyKey: key,
    now,
    config,
  });
}

async function withRejectedStaffNotificationInsert(
  callback: () => Promise<void>,
): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION m12_test_reject_staff_notification() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'synthetic M12 staff notification failure';
    END;
    $$
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER m12_test_reject_staff_notification_trigger
    BEFORE INSERT ON notification_outbox
    FOR EACH ROW EXECUTE FUNCTION m12_test_reject_staff_notification()
  `);
  try {
    await callback();
  } finally {
    await prisma.$executeRawUnsafe(
      "DROP TRIGGER IF EXISTS m12_test_reject_staff_notification_trigger ON notification_outbox",
    );
    await prisma.$executeRawUnsafe(
      "DROP FUNCTION IF EXISTS m12_test_reject_staff_notification()",
    );
  }
}

function updatePayload(
  reservation: Awaited<ReturnType<typeof createPhone>>["reservation"],
  overrides: Record<string, unknown> = {},
) {
  return {
    version: reservation.version,
    localDate: reservation.localDate,
    serviceType: reservation.serviceType,
    arrivalTime: reservation.arrivalTime,
    partySize: reservation.partySize,
    childrenCount: reservation.childrenCount,
    gameRoomPreference: reservation.gameRoomPreference,
    customerFirstName: reservation.customer.firstName,
    customerLastName: reservation.customer.lastName,
    customerPhone: reservation.customer.phone,
    customerEmail: reservation.customer.email,
    highChair: reservation.highChair,
    stroller: reservation.stroller,
    accessibility: reservation.accessibility,
    celiac: reservation.celiac,
    allergies: reservation.allergies,
    intolerances: reservation.intolerances,
    celebration: reservation.celebration,
    animals: reservation.animals,
    notes: reservation.notes,
    capacityOverride: false,
    capacityOverrideReason: null,
    ...overrides,
  };
}

function publicPayload(overrides: Record<string, unknown> = {}) {
  return {
    localDate: publicDate,
    serviceType: "DINNER",
    arrivalTime: "19:15",
    partySize: 2,
    childrenCount: 0,
    gameRoomPreference: null,
    customerFirstName: "Cliente",
    customerLastName: "Pubblico Fittizio",
    customerPhone: "+39 000 000 0801",
    customerEmail: null,
    highChair: false,
    stroller: false,
    accessibility: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: null,
    language: "it",
    privacyAccepted: true,
    termsAccepted: true,
    ...overrides,
  };
}

describe.sequential("M8 Staff reservation workflow with real PostgreSQL", () => {
  it.each([1000, 200])("R4 fresh Staff DTO preserves raw legacy allergy %i through no-op, note-only and composition", async (length) => {
    const created = await createPhone(staffActor, { childrenCount: null, gameRoomPreference: null, allergies: null });
    const id = created.reservation.id;
    const legacy = "H".repeat(length);
    await prisma.reservation.update({ where: { id }, data: { allergies: legacy, arrivedAt: now } });
    const table = await prisma.diningTable.create({ data: { roomId, name: "R4 synthetic", minimumSeats: 1, maximumSeats: 8 } });
    const assignment = await prisma.reservationAssignment.create({ data: { restaurantId, reservationId: id, roomId, assignedByUserId: staffId, updatedByUserId: staffId } });
    await prisma.reservationAssignmentTable.create({ data: { restaurantId, assignmentId: assignment.id, roomId, diningTableId: table.id } });
    try {
      const before = await prisma.reservation.findUniqueOrThrow({ where: { id } });
      const assignmentBefore = await prisma.reservationAssignment.findUniqueOrThrow({ where: { id: assignment.id }, include: { tables: true } });
      const auditCount = await prisma.reservationAuditEvent.count({ where: { reservationId: id } });
      const read = () => getStaffReservation({ actor: staffActor, reservationId: id });
      const fresh = await read();
      expect(fresh).toMatchObject({ allergies: null, intolerances: null, legacyAllergy: legacy });
      const payload = updatePayload(fresh);
      expect(payload.allergies).toBeNull();
      expect(payload).not.toHaveProperty("legacyAllergy");
      expect(JSON.stringify(payload)).not.toContain(legacy);
      const update = async (overrides: Record<string, unknown> = {}) => updateStaffReservation({ actor: staffActor, reservationId: id, rawPayload: updatePayload(await read(), overrides), now: new Date(now.getTime() + 10_000) });
      expect((await update()).changed).toBe(false);
      expect(await prisma.reservation.findUniqueOrThrow({ where: { id } })).toEqual(before);
      expect(await prisma.reservationAuditEvent.count({ where: { reservationId: id } })).toBe(auditCount);
      await expect(update({ legacyAllergy: legacy })).rejects.toMatchObject({ code: "VALIDATION" });
      expect((await update({ notes: "R4 note-only synthetic update" })).changed).toBe(true);
      expect(await prisma.reservation.findUniqueOrThrow({ where: { id } })).toMatchObject({ notes: "R4 note-only synthetic update", version: before.version + 1, allergies: legacy, arrivedAt: now });
      expect((await update({ childrenCount: 1, gameRoomPreference: true })).changed).toBe(true);
      const after = await prisma.reservation.findUniqueOrThrow({ where: { id } });
      expect(after).toMatchObject({ childrenCount: 1, gameRoomPreference: true, version: before.version + 2, allergies: legacy, arrivedAt: now });
      expect(await read()).toMatchObject({ allergies: null, legacyAllergy: legacy });
      expect(await prisma.reservationAssignment.findUniqueOrThrow({ where: { id: assignment.id }, include: { tables: true } })).toEqual(assignmentBefore);
      expect((await update()).changed).toBe(false);
      expect(await prisma.reservation.findUniqueOrThrow({ where: { id } })).toEqual(after);
      const audits = await prisma.reservationAuditEvent.findMany({ where: { reservationId: id, action: "UPDATED" } });
      expect(audits).toHaveLength(2);
      expect(JSON.stringify(audits)).not.toContain(legacy);
      expect(await prisma.reservationAuditEvent.count({ where: { reservationId: id } })).toBe(auditCount + 2);
    } finally {
      await prisma.reservationAssignmentTable.deleteMany({ where: { assignmentId: assignment.id } });
      await prisma.reservationAssignment.delete({ where: { id: assignment.id } });
      await prisma.diningTable.delete({ where: { id: table.id } });
    }
  });

  it.each([null, "Arachidi"])("R4 fresh Staff DTO preserves JSON allergy history separately from structured %s", async (structured) => {
    const created = await createPhone(staffActor, { allergies: null });
    const id = created.reservation.id;
    const history = "Segnalazione storica sintetica";
    const raw = JSON.stringify({ celiac: false, allergies: structured, intolerances: null, legacyText: history });
    await prisma.reservation.update({ where: { id }, data: { allergies: raw } });
    const read = () => getStaffReservation({ actor: staffActor, reservationId: id });
    const fresh = await read();
    expect(fresh).toMatchObject({ allergies: structured, legacyAllergy: history });
    const before = await prisma.reservation.findUniqueOrThrow({ where: { id } });
    const count = await prisma.reservationAuditEvent.count({ where: { reservationId: id } });
    expect((await updateStaffReservation({ actor: staffActor, reservationId: id, rawPayload: updatePayload(fresh), now })).changed).toBe(false);
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect(await prisma.reservationAuditEvent.count({ where: { reservationId: id } })).toBe(count);
    const changed = await updateStaffReservation({ actor: staffActor, reservationId: id, rawPayload: updatePayload(await read(), { allergies: "Nuova allergia sintetica" }), now });
    expect(changed.changed).toBe(true);
    const after = await prisma.reservation.findUniqueOrThrow({ where: { id } });
    expect(after.version).toBe(before.version + 1);
    expect(parsePublicAllergies(after.allergies)).toMatchObject({ allergies: "Nuova allergia sintetica" });
    expect(parsePublicAllergies(after.allergies).legacyText).toBe(history);
    expect(await read()).toMatchObject({ allergies: "Nuova allergia sintetica", legacyAllergy: history });
    expect(await prisma.reservationAuditEvent.count({ where: { reservationId: id, action: "UPDATED" } })).toBe(1);
  });

  it.each(['"\\\nX'.repeat(250), "P".repeat(1000)])("R3 preserves exact 1000-character legacy envelopes through Staff no-op, note-only and composition", async (legacy) => {
    expect(legacy).toHaveLength(1000);
    const created = await createPhone(staffActor, { childrenCount: null, gameRoomPreference: null, highChair: false, allergies: null, sendWhatsAppConfirmation: false });
    const id = created.reservation.id;
    await prisma.reservation.update({ where: { id }, data: { preferences: legacy, allergies: legacy, arrivedAt: now } });
    const table = await prisma.diningTable.create({ data: { roomId, name: "Storage R3", minimumSeats: 1, maximumSeats: 8 } });
    const assignment = await prisma.reservationAssignment.create({ data: { restaurantId, reservationId: id, roomId, assignedByUserId: staffId, updatedByUserId: staffId } });
    await prisma.reservationAssignmentTable.create({ data: { restaurantId, assignmentId: assignment.id, roomId, diningTableId: table.id } });
    try {
      const before = await prisma.reservation.findUniqueOrThrow({ where: { id } });
      const assignmentBefore = await prisma.reservationAssignment.findUniqueOrThrow({ where: { id: assignment.id }, include: { tables: true } });
      const auditsBefore = await prisma.reservationAuditEvent.count({ where: { reservationId: id } });
      const update = (reservation: typeof created.reservation, overrides: Record<string, unknown> = {}) => updateStaffReservation({ actor: staffActor, reservationId: id, rawPayload: updatePayload(reservation, overrides), now });
      expect((await update(created.reservation)).changed).toBe(false);
      expect(await prisma.reservation.findUniqueOrThrow({ where: { id } })).toEqual(before);
      const noteOnly = await update(created.reservation, { notes: "Storage boundary synthetic note" });
      const afterNote = await prisma.reservation.findUniqueOrThrow({ where: { id } });
      expect(afterNote.preferences).toBe(legacy);
      expect(afterNote.allergies).toBe(legacy);
      const changed = await update(noteOnly.reservation, { childrenCount: 1, gameRoomPreference: true, allergies: '"'.repeat(300), intolerances: "\\".repeat(300) });
      const stored = await prisma.reservation.findUniqueOrThrow({ where: { id } });
      expect(stored).toMatchObject({ childrenCount: 1, gameRoomPreference: true, version: afterNote.version + 1, arrivedAt: before.arrivedAt });
      expect(parsePublicPreferences(stored.preferences).legacyText).toBe(legacy);
      expect(parsePublicAllergies(stored.allergies)).toMatchObject({ allergies: '"'.repeat(300), intolerances: "\\".repeat(300) });
      expect(parsePublicAllergies(stored.allergies).legacyText).toBe(legacy);
      expect(stored.preferences!.length).toBeGreaterThan(1000);
      expect(stored.allergies!.length).toBeGreaterThan(1249);
      expect(await prisma.reservationAssignment.findUniqueOrThrow({ where: { id: assignment.id }, include: { tables: true } })).toEqual(assignmentBefore);
      expect(await prisma.reservationAuditEvent.count({ where: { reservationId: id, action: "UPDATED" } })).toBe(2);
      expect((await update(changed.reservation)).changed).toBe(false);
      expect(await prisma.reservation.findUniqueOrThrow({ where: { id } })).toEqual(stored);
      expect(await prisma.reservationAuditEvent.count({ where: { reservationId: id } })).toBe(auditsBefore + 2);
      expect(await prisma.notificationOutbox.count({ where: { restaurantId, reservationId: id, eventType: "RESERVATION_CONFIRMED" } })).toBe(0);
      const audit = await prisma.reservationAuditEvent.findFirstOrThrow({ where: { reservationId: id, action: "UPDATED" } });
      expect(JSON.stringify(audit)).not.toContain(legacy);
    } finally {
      await prisma.reservationAssignmentTable.deleteMany({ where: { assignmentId: assignment.id } });
      await prisma.reservationAssignment.delete({ where: { id: assignment.id } });
      await prisma.diningTable.delete({ where: { id: table.id } });
    }
  });

  it.each([
    { allergies: '"'.repeat(300), intolerances: "\\".repeat(300) },
    { allergies: "A\n".repeat(149) + "AA", intolerances: "I\t".repeat(149) + "II" },
  ])("R3 PHONE persists bounded escaping and preserves idempotency", async (fields) => {
    const key = randomUUID();
    const first = await createPhone(staffActor, { ...fields, sendWhatsAppConfirmation: false }, key);
    const row = await prisma.reservation.findUniqueOrThrow({ where: { id: first.reservation.id } });
    expect(parsePublicAllergies(row.allergies)).toMatchObject(fields);
    expect(JSON.parse(row.allergies!)).not.toHaveProperty("legacyText");
    expect((await createPhone(staffActor, { ...fields, sendWhatsAppConfirmation: false }, key)).replayed).toBe(true);
    await expect(createPhone(staffActor, { ...fields, allergies: "changed", sendWhatsAppConfirmation: false }, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const updated = await updateStaffReservation({ actor: staffActor, reservationId: row.id, rawPayload: updatePayload(first.reservation, { customerFirstName: "Storage Updated" }), now });
    expect(updated.changed).toBe(true);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: row.id } })).allergies).toBe(row.allergies);
    expect(await prisma.notificationOutbox.count({ where: { reservationId: row.id } })).toBe(3);
  });

  it.each(["plain", "structured"] as const)("F-01 preserves %s legacy text through Staff edit, composition change and no-op", async (format) => {
    const created = await createPhone(staffActor, { childrenCount: null, gameRoomPreference: null, highChair: false, allergies: null });
    const text = "Richiesta storica sintetica Staff — città\n".repeat(10);
    const initial = await prisma.reservation.findUniqueOrThrow({ where: { id: created.reservation.id } });
    const original = format === "plain" ? text.trim() : JSON.stringify({ ...JSON.parse(initial.preferences!), legacyText: text }, null, 2);
    await prisma.reservation.update({ where: { id: created.reservation.id }, data: { preferences: original } });
    const before = await prisma.reservation.findUniqueOrThrow({ where: { id: created.reservation.id } });
    const auditCount = await prisma.reservationAuditEvent.count({ where: { reservationId: before.id } });
    const update = (reservation: typeof created.reservation, overrides: Record<string, unknown> = {}) => updateStaffReservation({ actor: staffActor, reservationId: before.id, rawPayload: updatePayload(reservation, overrides), now: new Date(now.getTime() + 10_000) });
    expect((await update(created.reservation)).changed).toBe(false);
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await prisma.reservationAuditEvent.count({ where: { reservationId: before.id } })).toBe(auditCount);
    await expect(update(created.reservation, { legacyText: "Client replacement" })).rejects.toMatchObject({ code: "VALIDATION" });
    const edited = await update(created.reservation, { customerFirstName: "Cliente Sintetico Aggiornato" });
    expect(edited.changed).toBe(true);
    expect(edited.reservation.legacyPreference).toBe(parsePublicPreferences(original).legacyText);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: before.id } })).preferences).toBe(original);
    const composed = await update(edited.reservation, { childrenCount: 1, gameRoomPreference: true });
    const stored = await prisma.reservation.findUniqueOrThrow({ where: { id: before.id } });
    expect(parsePublicPreferences(stored.preferences).legacyText).toBe(parsePublicPreferences(original).legacyText);
    expect(parsePublicPreferences(stored.preferences).children).toBe(true);
    expect(stored.version).toBe(before.version + 2);
    const audits = await prisma.reservationAuditEvent.findMany({ where: { reservationId: before.id, action: "UPDATED" } });
    expect(audits).toHaveLength(2);
    for (const audit of audits) {
      expect(audit.newState).toMatchObject({ requests: { legacyPreferencePresent: true } });
      expect(JSON.stringify(audit)).not.toContain("Richiesta storica sintetica");
    }
    expect((await update(composed.reservation)).changed).toBe(false);
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: before.id } })).toEqual(stored);
    expect(await prisma.reservationAuditEvent.count({ where: { reservationId: before.id } })).toBe(auditCount + 2);
  });

  it("F-01 rolls back legacy text, structured state, version and timestamps when Staff update audit fails", async () => {
    const created = await createPhone(staffActor, { childrenCount: null, gameRoomPreference: null });
    await prisma.reservation.update({ where: { id: created.reservation.id }, data: { preferences: '"\\\nX'.repeat(250), allergies: "H".repeat(1000), arrivedAt: now } });
    const before = await prisma.reservation.findUniqueOrThrow({ where: { id: created.reservation.id } });
    const audits = await prisma.reservationAuditEvent.count({ where: { reservationId: before.id } });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION foundation_f01_reject_staff_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.restaurant_id='${restaurantId}'::uuid AND NEW.action='UPDATED' THEN RAISE EXCEPTION 'synthetic F01 staff audit failure'; END IF; RETURN NEW; END; $$`);
    await prisma.$executeRawUnsafe("CREATE TRIGGER foundation_f01_reject_staff_audit BEFORE INSERT ON reservation_audit_events FOR EACH ROW EXECUTE FUNCTION foundation_f01_reject_staff_audit()");
    try {
      await expect(updateStaffReservation({ actor: staffActor, reservationId: before.id, rawPayload: updatePayload(created.reservation, { childrenCount: 1, gameRoomPreference: true, allergies: '"'.repeat(300), intolerances: "\\".repeat(300) }), now })).rejects.toThrow("synthetic F01 staff audit failure");
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER foundation_f01_reject_staff_audit ON reservation_audit_events");
      await prisma.$executeRawUnsafe("DROP FUNCTION foundation_f01_reject_staff_audit()");
    }
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await prisma.reservationAuditEvent.count({ where: { reservationId: before.id } })).toBe(audits);
  });

  it.each([
    { childrenCount: null, gameRoomPreference: null },
    { childrenCount: 0, gameRoomPreference: null },
    { childrenCount: 1, gameRoomPreference: true },
    { childrenCount: 1, gameRoomPreference: false },
  ])("persists PHONE composition $childrenCount/$gameRoomPreference and minimized audit", async (composition) => {
    const result = await createPhone(staffActor, composition);
    const stored = await prisma.reservation.findUniqueOrThrow({ where: { id: result.reservation.id } });
    expect(stored).toMatchObject(composition);
    expect(result.reservation).toMatchObject(composition);
    expect(result.reservation.roomCode).toBe("");
    const audit = await prisma.reservationAuditEvent.findFirstOrThrow({ where: { reservationId: stored.id, action: "CREATED" } });
    expect(audit.newState).toMatchObject(composition);
    expect(JSON.stringify(audit.newState)).not.toContain(stored.customerPhone);
  });

  it("hashes both new PHONE fields and accepts only a matching pre-existing legacy replay", async () => {
    const key = randomUUID();
    const created = await createPhone(staffActor, { childrenCount: 1, gameRoomPreference: true }, key);
    expect((await createPhone(staffActor, { childrenCount: 1, gameRoomPreference: true }, key)).replayed).toBe(true);
    for (const change of [{ childrenCount: 2, gameRoomPreference: true }, { childrenCount: 1, gameRoomPreference: false }]) {
      await expect(createPhone(staffActor, change, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    }
    const base = Object.fromEntries(Object.entries(phonePayload()).filter(([field]) => !["childrenCount", "gameRoomPreference"].includes(field)));
    const old = legacyPhoneReservationSchema.parse({ ...base, roomCode: "sala-m8", children: true });
    const hash = hashLegacyPhoneReservationRequest({
      localDate: old.localDate, serviceType: old.serviceType, arrivalTime: old.arrivalTime, partySize: old.partySize,
      childrenCount: null, gameRoomPreference: null, origin: "PHONE", customerFirstName: old.customerFirstName,
      customerLastName: old.customerLastName, customerPhone: old.customerPhone, customerEmail: old.customerEmail,
      notes: old.notes, preferences: serializePublicPreferences(old), allergies: serializePublicAllergies(old),
      privacyConsentMethod: "VERBAL", capacityOverride: old.capacityOverride, capacityOverrideReason: old.capacityOverrideReason,
    }, old.sendWhatsAppConfirmation);
    const record = await prisma.reservationIdempotencyKey.findFirstOrThrow({ where: { restaurantId } });
    await prisma.reservationIdempotencyKey.update({ where: { id: record.id }, data: { requestHash: hash } });
    await prisma.reservation.update({ where: { id: created.reservation.id }, data: { childrenCount: null, gameRoomPreference: null, preferences: serializePublicPreferences(old) } });
    const replay = () => createPhoneReservation({ actor: staffActor, rawPayload: old, rawIdempotencyKey: key, now, config });
    expect(await replay()).toMatchObject({ replayed: true, reservation: { id: created.reservation.id, childrenCount: null, gameRoomPreference: null } });
    expect((await prisma.reservationIdempotencyKey.findUniqueOrThrow({ where: { id: record.id } })).requestHash).toBe(hash);
    await expect(createPhoneReservation({ actor: staffActor, rawPayload: old, rawIdempotencyKey: randomUUID(), now, config })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createPhoneReservation({ actor: staffActor, rawPayload: old, rawIdempotencyKey: key, now: new Date(record.expiresAt.getTime() + 1), config })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await prisma.reservation.count({ where: { restaurantId } })).toBe(1);
    expect(await prisma.reservationAuditEvent.count({ where: { restaurantId } })).toBe(1);
  });

  it("preserves unknown for unrelated Staff edits, requires composition for size change and keeps no-op immutable", async () => {
    const created = await createPhone(staffActor, { childrenCount: null, gameRoomPreference: null });
    const updated = await updateStaffReservation({ actor: staffActor, reservationId: created.reservation.id, rawPayload: updatePayload(created.reservation, { notes: "Nuova nota Foundation sintetica" }), now });
    expect(updated.reservation).toMatchObject({ childrenCount: null, gameRoomPreference: null });
    await expect(updateStaffReservation({ actor: staffActor, reservationId: created.reservation.id, rawPayload: updatePayload(updated.reservation, { partySize: 3 }), now })).rejects.toMatchObject({ code: "VALIDATION" });
    const known = await updateStaffReservation({ actor: staffActor, reservationId: created.reservation.id, rawPayload: updatePayload(updated.reservation, { partySize: 3, childrenCount: 1, gameRoomPreference: true }), now });
    const changed = await updateStaffReservation({ actor: staffActor, reservationId: created.reservation.id, rawPayload: updatePayload(known.reservation, { gameRoomPreference: false }), now });
    expect(changed.reservation).toMatchObject({ childrenCount: 1, gameRoomPreference: false });
    const before = await prisma.reservation.findUniqueOrThrow({ where: { id: created.reservation.id } });
    const count = await prisma.reservationAuditEvent.count({ where: { reservationId: before.id } });
    expect((await updateStaffReservation({ actor: staffActor, reservationId: before.id, rawPayload: updatePayload(changed.reservation), now: new Date(now.getTime() + 10_000) })).changed).toBe(false);
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
    expect(await prisma.reservationAuditEvent.count({ where: { reservationId: before.id } })).toBe(count);
    const audit = await prisma.reservationAuditEvent.findFirstOrThrow({ where: { reservationId: before.id, action: "UPDATED", newState: { path: ["gameRoomPreference"], equals: false } } });
    expect(audit.newState).toMatchObject({ childrenCount: 1, gameRoomPreference: false });
  });
  beforeAll(async () => {
    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "M8 Demo", timezone: "Europe/Rome" },
        {
          id: otherRestaurantId,
          name: "M8 Other Demo",
          timezone: "Europe/Rome",
        },
      ],
    });
    await prisma.restaurantBookingSettings.createMany({
      data: [
        { restaurantId, ...bookingSettingsData() },
        { restaurantId: otherRestaurantId, ...bookingSettingsData() },
      ],
    });
    await prisma.restaurantNotificationSettings.createMany({
      data: [
        { restaurantId, strategy: "WHATSAPP_ONLY" },
        { restaurantId: otherRestaurantId, strategy: "WHATSAPP_ONLY" },
      ],
    });
    await prisma.weeklyServiceSchedule.createMany({
      data: [
        ...weeklySchedules(restaurantId),
        ...weeklySchedules(otherRestaurantId),
      ],
    });
    await prisma.room.createMany({
      data: [
        {
          id: roomId,
          restaurantId,
          code: "sala-m8",
          name: "Sala M8",
          displayOrder: 1,
          isActive: true,
        },
        {
          id: otherRoomId,
          restaurantId: otherRestaurantId,
          code: "sala-m8-other",
          name: "Sala M8 Other",
          displayOrder: 1,
          isActive: true,
        },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: staffId,
          restaurantId,
          username: `m8.staff.${restaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m8-tests",
          role: "STAFF",
        },
        {
          id: adminId,
          restaurantId,
          username: `m8.admin.${restaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m8-tests",
          role: "ADMIN",
        },
        {
          id: otherStaffId,
          restaurantId: otherRestaurantId,
          username: `m8.other.${otherRestaurantId.slice(0, 8)}`,
          passwordHash: "not-used-in-m8-tests",
          role: "STAFF",
        },
      ],
    });
  });

  beforeEach(async () => {
    await prisma.notificationSimulationReceipt.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.notificationAttempt.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.notificationOutbox.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservationAuditEvent.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservation.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.serviceRoomAvailability.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.serviceInstance.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurantBookingSettings.update({
      where: { restaurantId },
      data: {
        managementLinkDurationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
      },
    });
    await prisma.restaurantNotificationSettings.update({
      where: { restaurantId },
      data: { strategy: "WHATSAPP_ONLY" },
    });
  });

  afterAll(async () => {
    await prisma.notificationSimulationReceipt.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.notificationAttempt.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.notificationOutbox.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservationAuditEvent.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.reservation.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.serviceRoomAvailability.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.serviceInstance.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.session.deleteMany({
      where: { userId: { in: [staffId, adminId, otherStaffId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [staffId, adminId, otherStaffId] } },
    });
    await prisma.restaurantNotificationSettings.deleteMany({
      where: { restaurantId: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.restaurant.deleteMany({
      where: { id: { in: [restaurantId, otherRestaurantId] } },
    });
    await prisma.$disconnect();
  });

  it("has the authenticated audit constraints, foreign key and index applied", async () => {
    const metadata = await prisma.$queryRaw<
      Array<{ constraints: bigint; indexes: bigint }>
    >`
      SELECT
        (
          SELECT COUNT(*)
          FROM pg_constraint
          WHERE conname IN (
            'reservation_audit_events_actor_check',
            'reservation_audit_events_override_check',
            'reservation_audit_events_actor_user_id_fkey'
          )
        ) AS constraints,
        (
          SELECT COUNT(*)
          FROM pg_indexes
          WHERE indexname = 'reservation_audit_events_actor_created_idx'
        ) AS indexes
    `;

    expect(metadata[0]).toEqual({ constraints: BigInt(3), indexes: BigInt(1) });
  });

  it("creates an idempotent PHONE reservation with canonical requests and authenticated audit", async () => {
    const key = randomUUID();
    const first = await createPhone(staffActor, {}, key);
    const replay = await createPhone(staffActor, {}, key);
    const stored = await prisma.reservation.findUniqueOrThrow({
      where: { id: first.reservation.id },
    });
    const audit = await prisma.reservationAuditEvent.findFirstOrThrow({
      where: { reservationId: stored.id, action: "CREATED" },
    });

    expect(replay.replayed).toBe(true);
    expect(replay.reservation.id).toBe(first.reservation.id);
    await expect(
      createPhone(staffActor, { partySize: 3 }, key),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(stored.origin).toBe("PHONE");
    expect(stored.privacyConsentMethod).toBe("VERBAL");
    expect(stored.privacyPolicyVersion).toBe(config.privacyPolicyVersion);
    expect(stored.privacyConsentAt).toEqual(now);
    expect(stored.createdByUserId).toBe(staffId);
    expect(parsePublicPreferences(stored.preferences).highChair).toBe(true);
    expect(parsePublicAllergies(stored.allergies).allergies).toBe(
      "Dato fittizio",
    );
    expect(audit).toMatchObject({
      actorOrigin: "PHONE",
      actorUserId: staffId,
      actorRole: "STAFF",
      capacityOverride: false,
      createdAt: now,
    });
    const auditState = JSON.stringify(audit.newState);
    expect(auditState).not.toContain("+39 000 000 0800");
    expect(auditState).not.toContain("m8@example.invalid");
    expect(auditState).not.toContain("Dato fittizio");
    expect(auditState).not.toContain("Nota esclusivamente fittizia M8");
    expect(await prisma.reservation.count({ where: { restaurantId } })).toBe(1);
  });

  it("rolls back PHONE materialization, reservation, idempotency and audit when the final audit fails", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION m9d_test_reject_phone_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.restaurant_id = '${restaurantId}'::uuid AND NEW.action = 'CREATED' THEN
          RAISE EXCEPTION 'synthetic M9-D phone audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER m9d_test_reject_phone_audit_trigger
      BEFORE INSERT ON reservation_audit_events
      FOR EACH ROW EXECUTE FUNCTION m9d_test_reject_phone_audit();
    `);

    try {
      await expect(createPhone(staffActor)).rejects.toThrow(
        "synthetic M9-D phone audit failure",
      );
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS m9d_test_reject_phone_audit_trigger ON reservation_audit_events",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS m9d_test_reject_phone_audit()",
      );
    }

    await expect(
      prisma.serviceInstance.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.serviceRoomAvailability.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.reservation.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.reservationIdempotencyKey.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.reservationAuditEvent.count({ where: { restaurantId } }),
    ).resolves.toBe(0);
  });

  it("requires verbal consent and rolls the idempotency record back on failure", async () => {
    const beforeKeys = await prisma.reservationIdempotencyKey.count({
      where: { restaurantId },
    });

    await expect(
      createPhone(staffActor, { verbalConsentConfirmed: false }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    expect(await prisma.reservation.count({ where: { restaurantId } })).toBe(0);
    expect(
      await prisma.reservationIdempotencyKey.count({ where: { restaurantId } }),
    ).toBe(beforeKeys);
    expect(
      await prisma.reservationAuditEvent.count({ where: { restaurantId } }),
    ).toBe(0);
  });

  it("isolates the daily dashboard by restaurant and applies filters", async () => {
    await createPhone(staffActor);
    await createPhone(otherStaffActor);
    const dashboard = await getDashboardDay({
      restaurantId,
      rawDate: standardDate,
      rawService: "DINNER",
      rawStatus: "CONFIRMED",
      rawOrigin: "PHONE",
      now,
    });

    expect(dashboard.reservations).toHaveLength(1);
    expect(dashboard.summary.confirmedReservations).toBe(1);
    expect(dashboard.reservations[0]?.customerLastName).toBe(
      "Telefonico Fittizio",
    );
  });

  it("rejects cross-restaurant Staff updates and cancellations", async () => {
    const created = await createPhone(staffActor);

    await expect(
      updateStaffReservation({
        actor: otherStaffActor,
        reservationId: created.reservation.id,
        rawPayload: updatePayload(created.reservation),
        now,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      cancelStaffReservation({
        actor: otherStaffActor,
        reservationId: created.reservation.id,
        rawPayload: { version: created.reservation.version },
        now,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: created.reservation.id },
        select: { status: true, version: true },
      }),
    ).toEqual({ status: "CONFIRMED", version: 1 });
  });

  it("allows capacity override to Staff and Admin only when capacity is exceeded", async () => {
    const staffOverride = await createPhone(staffActor, {
      localDate: overrideDate,
      partySize: 5,
      capacityOverride: true,
      capacityOverrideReason: "Autorizzazione fittizia Staff",
    });
    const adminOverride = await createPhone(adminActor, {
      localDate: movedDate,
      partySize: 5,
      capacityOverride: true,
      capacityOverrideReason: "Autorizzazione fittizia Admin",
    });

    expect(staffOverride.reservation.override.applied).toBe(true);
    expect(adminOverride.reservation.override.applied).toBe(true);
    const overrideAudits = await prisma.reservationAuditEvent.findMany({
      where: { restaurantId, capacityOverride: true },
      orderBy: { createdAt: "asc" },
    });
    expect(overrideAudits).toHaveLength(2);
    expect(overrideAudits[0]?.newState).toMatchObject({
      capacityOverrideResult: {
        capacityLimit: 4,
        totalBefore: 0,
        totalAfter: 5,
      },
    });
    expect(
      await prisma.reservationAuditEvent.count({
        where: { restaurantId, capacityOverride: true },
      }),
    ).toBe(2);
    await expect(
      createPhone(staffActor, {
        localDate: concurrencyDate,
        partySize: 2,
        capacityOverride: true,
        capacityOverrideReason: "Override non necessario",
      }),
    ).rejects.toMatchObject({ code: "OVERRIDE_NOT_REQUIRED" });
  });

  it("updates contacts without a capacity change, moves service atomically and rejects stale versions", async () => {
    const created = await createPhone(staffActor);
    const consentBefore = await prisma.reservation.findUniqueOrThrow({
      where: { id: created.reservation.id },
      select: {
        origin: true,
        createdByUserId: true,
        privacyConsentAt: true,
        privacyConsentMethod: true,
      },
    });
    const contactsUpdated = await updateStaffReservation({
      actor: staffActor,
      reservationId: created.reservation.id,
      rawPayload: updatePayload(created.reservation, {
        customerPhone: "+39 000 000 0888",
      }),
      now,
    });
    const auditCountBeforeNoOp = await prisma.reservationAuditEvent.count({
      where: { reservationId: created.reservation.id },
    });
    const noOp = await updateStaffReservation({
      actor: staffActor,
      reservationId: created.reservation.id,
      rawPayload: updatePayload(contactsUpdated.reservation),
      now,
    });
    const moved = await updateStaffReservation({
      actor: adminActor,
      reservationId: created.reservation.id,
      rawPayload: updatePayload(contactsUpdated.reservation, {
        localDate: movedDate,
        serviceType: "LUNCH",
        arrivalTime: "12:30",
        partySize: 3,
      }),
      now,
    });

    expect(contactsUpdated.reservation.version).toBe(2);
    expect(noOp).toMatchObject({ changed: false, reservation: { version: 2 } });
    expect(
      await prisma.reservationAuditEvent.count({
        where: { reservationId: created.reservation.id },
      }),
    ).toBe(auditCountBeforeNoOp + 1);
    expect(moved.reservation).toMatchObject({
      localDate: movedDate,
      serviceType: "LUNCH",
      arrivalTime: "12:30",
      partySize: 3,
      version: 3,
    });
    expect(
      await prisma.reservation.findUniqueOrThrow({
        where: { id: created.reservation.id },
        select: {
          origin: true,
          createdByUserId: true,
          privacyConsentAt: true,
          privacyConsentMethod: true,
        },
      }),
    ).toEqual(consentBefore);
    await expect(
      updateStaffReservation({
        actor: staffActor,
        reservationId: created.reservation.id,
        rawPayload: updatePayload(created.reservation),
        now,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("keeps phone create, Staff update and Staff cancellation atomic with their notification outbox", async () => {
    await withRejectedStaffNotificationInsert(async () => {
      await expect(createPhone(staffActor)).rejects.toThrow(
        "synthetic M12 staff notification failure",
      );
    });
    await expect(prisma.reservation.count({ where: { restaurantId } })).resolves.toBe(0);
    await expect(prisma.reservationAuditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
    await expect(prisma.notificationOutbox.count({ where: { restaurantId } })).resolves.toBe(0);

    const created = await createPhone(staffActor);
    const reservationBefore = await prisma.reservation.findUniqueOrThrow({ where: { id: created.reservation.id } });
    const auditsBefore = await prisma.reservationAuditEvent.findMany({ where: { reservationId: created.reservation.id }, orderBy: { createdAt: "asc" } });
    const outboxBefore = await prisma.notificationOutbox.findMany({ where: { reservationId: created.reservation.id }, orderBy: { createdAt: "asc" } });
    expect(outboxBefore).toHaveLength(2);
    expect(new Set([auditsBefore[0]?.correlationId, ...outboxBefore.map((row) => row.originCorrelationId)])).toEqual(new Set([auditsBefore[0]?.correlationId]));

    await withRejectedStaffNotificationInsert(async () => {
      await expect(updateStaffReservation({
        actor: staffActor,
        reservationId: created.reservation.id,
        rawPayload: updatePayload(created.reservation, { customerPhone: "+39 000 000 0891", gameRoomPreference: true }),
        now,
      })).rejects.toThrow("synthetic M12 staff notification failure");
    });
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: created.reservation.id } })).toEqual(reservationBefore);
    expect(await prisma.reservationAuditEvent.findMany({ where: { reservationId: created.reservation.id }, orderBy: { createdAt: "asc" } })).toEqual(auditsBefore);
    expect(await prisma.notificationOutbox.findMany({ where: { reservationId: created.reservation.id }, orderBy: { createdAt: "asc" } })).toEqual(outboxBefore);

    await withRejectedStaffNotificationInsert(async () => {
      await expect(cancelStaffReservation({
        actor: staffActor,
        reservationId: created.reservation.id,
        rawPayload: { version: created.reservation.version },
        now,
      })).rejects.toThrow("synthetic M12 staff notification failure");
    });
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: created.reservation.id } })).toEqual(reservationBefore);
    expect(await prisma.reservationAuditEvent.findMany({ where: { reservationId: created.reservation.id }, orderBy: { createdAt: "asc" } })).toEqual(auditsBefore);
    expect(await prisma.notificationOutbox.findMany({ where: { reservationId: created.reservation.id }, orderBy: { createdAt: "asc" } })).toEqual(outboxBefore);
  });

  it.each([
    ["WHATSAPP_ONLY", []],
    ["WHATSAPP_WITH_EMAIL_FALLBACK", []],
    ["WHATSAPP_AND_EMAIL_PARALLEL", ["EMAIL"]],
  ] as const)("applies phone confirmation opt-out under %s without suppressing reminders", async (strategy, confirmationChannels) => {
    await prisma.restaurantNotificationSettings.update({
      where: { restaurantId },
      data: { strategy },
    });
    const created = await createPhone(staffActor, { sendWhatsAppConfirmation: false });
    const rows = await prisma.notificationOutbox.findMany({
      where: { reservationId: created.reservation.id },
      orderBy: [{ eventType: "asc" }, { channel: "asc" }],
    });
    expect(rows.filter((row) => row.eventType === "RESERVATION_CONFIRMED").map((row) => row.channel)).toEqual(confirmationChannels);
    expect(rows.filter((row) => row.eventType === "RESERVATION_REMINDER").map((row) => row.channel).sort()).toEqual(
      strategy === "WHATSAPP_AND_EMAIL_PARALLEL" ? ["EMAIL", "WHATSAPP"] : ["WHATSAPP"],
    );
    const audit = await prisma.reservationAuditEvent.findFirstOrThrow({ where: { reservationId: created.reservation.id, action: "CREATED" } });
    expect(audit.newState).toMatchObject({ notification: { confirmationWhatsAppRequested: false } });
  });

  it("keeps updates and cancellations enabled after phone confirmation opt-out", async () => {
    const created = await createPhone(staffActor, { sendWhatsAppConfirmation: false });
    const updated = await updateStaffReservation({
      actor: staffActor,
      reservationId: created.reservation.id,
      rawPayload: updatePayload(created.reservation, { customerPhone: "+39 000 000 0892" }),
      now,
    });
    await cancelStaffReservation({
      actor: staffActor,
      reservationId: created.reservation.id,
      rawPayload: { version: updated.reservation.version },
      now,
    });
    const eventTypes = await prisma.notificationOutbox.findMany({ where: { reservationId: created.reservation.id }, select: { eventType: true } });
    expect(eventTypes.some((row) => row.eventType === "RESERVATION_CONFIRMED")).toBe(false);
    expect(eventTypes.some((row) => row.eventType === "RESERVATION_UPDATED")).toBe(true);
    expect(eventTypes.some((row) => row.eventType === "RESERVATION_CANCELLED")).toBe(true);
    expect(eventTypes.some((row) => row.eventType === "RESERVATION_REMINDER")).toBe(true);
  });

  it("treats phone opt-in true and false as different idempotency requests", async () => {
    const key = randomUUID();
    await createPhone(staffActor, { sendWhatsAppConfirmation: false }, key);
    await expect(createPhone(staffActor, { sendWhatsAppConfirmation: true }, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(prisma.reservation.count({ where: { restaurantId } })).resolves.toBe(1);
  });

  it("preserves an existing override during a contact-only update", async () => {
    const created = await createPhone(staffActor, {
      localDate: overrideDate,
      partySize: 5,
      capacityOverride: true,
      capacityOverrideReason: "Override persistente fittizio",
    });
    const updated = await updateStaffReservation({
      actor: adminActor,
      reservationId: created.reservation.id,
      rawPayload: updatePayload(created.reservation, {
        customerPhone: "+39 000 000 0899",
      }),
      now,
    });
    const updateAudit = await prisma.reservationAuditEvent.findFirstOrThrow({
      where: { reservationId: created.reservation.id, action: "UPDATED" },
    });

    expect(updated.reservation.override).toEqual({
      applied: true,
      reason: "Override persistente fittizio",
    });
    expect(updateAudit).toMatchObject({
      capacityOverride: false,
      capacityOverrideReason: null,
    });
    expect(updateAudit.newState).toMatchObject({
      capacityOverride: true,
      capacityOverrideReason: "Override persistente fittizio",
    });
  });

  it("preserves historical room preference without constraining roomless edits or cancellation", async () => {
    const created = await createPhone(staffActor);
    const persisted = await prisma.reservation.findUniqueOrThrow({ where: { id: created.reservation.id } });
    await prisma.reservation.update({
      where: { id: persisted.id },
      data: { preferences: JSON.stringify({ ...JSON.parse(persisted.preferences!), roomCode: "sala-m8" }) },
    });
    await prisma.room.update({ where: { id: roomId }, data: { isActive: false } });

    try {
      const updated = await updateStaffReservation({
        actor: staffActor,
        reservationId: created.reservation.id,
        rawPayload: updatePayload(created.reservation, {
          customerPhone: "+39 000 000 0877",
        }),
        now,
      });

      expect(updated.reservation).toMatchObject({
        roomCode: "sala-m8",
        status: "CONFIRMED",
        version: 2,
      });
      const moved = await updateStaffReservation({
          actor: staffActor,
          reservationId: created.reservation.id,
          rawPayload: updatePayload(updated.reservation, {
            localDate: movedDate,
          }),
          now,
        });
      expect(moved.reservation).toMatchObject({ localDate: movedDate, roomCode: "sala-m8", version: 3 });
      await expect(
        cancelStaffReservation({
          actor: staffActor,
          reservationId: created.reservation.id,
          rawPayload: { version: moved.reservation.version },
          now,
        }),
      ).resolves.toMatchObject({
        changed: true,
        reservation: { roomCode: "sala-m8", status: "CANCELLED" },
      });
    } finally {
      await prisma.room.update({ where: { id: roomId }, data: { isActive: true } });
    }
  });

  it("serializes concurrent PHONE creation without exceeding capacity", async () => {
    const attempts = await Promise.allSettled([
      createPhone(staffActor, {
        localDate: concurrencyDate,
        partySize: 3,
      }),
      createPhone(adminActor, {
        localDate: concurrencyDate,
        partySize: 3,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(rejected?.reason).toBeInstanceOf(ReservationApplicationError);
    expect(rejected?.reason).toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(
      await prisma.reservation.aggregate({
        where: { restaurantId, localDate: localDateToDatabase(concurrencyDate) },
        _sum: { partySize: true },
      }),
    ).toMatchObject({ _sum: { partySize: 3 } });
  });

  it("cancels logically and idempotently, audits once and frees covers", async () => {
    const created = await createPhone(staffActor, {
      localDate: cancellationDate,
      partySize: 4,
    });
    const first = await cancelStaffReservation({
      actor: staffActor,
      reservationId: created.reservation.id,
      rawPayload: { version: created.reservation.version },
      now,
    });
    const replay = await cancelStaffReservation({
      actor: adminActor,
      reservationId: created.reservation.id,
      rawPayload: { version: created.reservation.version },
      now,
    });
    const replacement = await createPhone(adminActor, {
      localDate: cancellationDate,
      partySize: 4,
    });

    expect(first).toMatchObject({ changed: true, reservation: { version: 2 } });
    expect(replay).toMatchObject({ changed: false, reservation: { version: 2 } });
    expect(replacement.reservation.status).toBe("CONFIRMED");
    expect(
      await prisma.reservationAuditEvent.count({
        where: { reservationId: created.reservation.id, action: "CANCELLED" },
      }),
    ).toBe(1);
  });

  it("rolls back a failed capacity attempt without an orphan audit", async () => {
    await createPhone(staffActor, { localDate: overrideDate, partySize: 4 });
    const auditsBefore = await prisma.reservationAuditEvent.count({
      where: { restaurantId },
    });
    const keysBefore = await prisma.reservationIdempotencyKey.count({
      where: { restaurantId },
    });

    await expect(
      createPhone(adminActor, { localDate: overrideDate, partySize: 1 }),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });

    expect(
      await prisma.reservationAuditEvent.count({ where: { restaurantId } }),
    ).toBe(auditsBefore);
    expect(
      await prisma.reservationIdempotencyKey.count({ where: { restaurantId } }),
    ).toBe(keysBefore);
  });

  it("preserves the original public token duration when Staff moves a PUBLIC reservation", async () => {
    const publicReservation = await createPublicReservation({
      restaurantId,
      managementSecret,
      rawPayload: publicPayload(),
      rawIdempotencyKey: randomUUID(),
      now,
      config,
    });
    const storedBefore = await prisma.reservation.findFirstOrThrow({
      where: {
        restaurantId,
        origin: "PUBLIC",
        localDate: localDateToDatabase(publicDate),
      },
    });
    const tokenBefore = await prisma.reservationManagementToken.findUniqueOrThrow({
      where: { reservationId: storedBefore.id },
    });
    await prisma.restaurantBookingSettings.update({
      where: { restaurantId },
      data: { managementLinkDurationHours: 6 },
    });
    const updated = await updateStaffReservation({
      actor: staffActor,
      reservationId: storedBefore.id,
      rawPayload: {
        version: storedBefore.version,
        localDate: publicMovedDate,
        serviceType: "DINNER",
        arrivalTime: "20:00",
        partySize: publicReservation.reservation.partySize,
        childrenCount: 0,
        gameRoomPreference: null,
        customerFirstName: "Cliente",
        customerLastName: "Pubblico Fittizio",
        customerPhone: "+39 000 000 0801",
        customerEmail: null,
        highChair: false,
        stroller: false,
        accessibility: false,
        celiac: false,
        allergies: null,
        intolerances: null,
        celebration: null,
        animals: false,
        notes: null,
        capacityOverride: false,
        capacityOverrideReason: null,
      },
      now,
    });
    const tokenAfter = await prisma.reservationManagementToken.findUniqueOrThrow({
      where: { reservationId: storedBefore.id },
    });
    const storedAfter = await prisma.reservation.findUniqueOrThrow({
      where: { id: storedBefore.id },
    });

    expect(tokenAfter.viewExpiresAt).not.toEqual(tokenBefore.viewExpiresAt);
    expect(tokenAfter.viewExpiresAt).toEqual(
      managementViewExpiry({
        localDate: publicMovedDate,
        arrivalTime: "20:00",
        timezone: "Europe/Rome",
        durationHours: DEFAULT_MANAGEMENT_LINK_DURATION_HOURS,
      }),
    );
    expect(storedAfter).toMatchObject({
      origin: "PUBLIC",
      createdByUserId: null,
      privacyConsentMethod: "WEB_CHECKBOX",
      termsConsentMethod: "WEB_CHECKBOX",
    });
    expect(updated.reservation.version).toBe(2);
    expect(
      await prisma.reservationAuditEvent.findFirstOrThrow({
        where: { reservationId: storedBefore.id, action: "UPDATED" },
        orderBy: { createdAt: "desc" },
      }),
    ).toMatchObject({ actorUserId: staffId, actorRole: "STAFF" });
  });

  it("keeps a Staff-cancelled PUBLIC reservation readable through its valid link", async () => {
    const created = await createPublicReservation({
      restaurantId,
      managementSecret,
      rawPayload: publicPayload(),
      rawIdempotencyKey: randomUUID(),
      now,
      config,
    });
    const stored = await prisma.reservation.findFirstOrThrow({
      where: { restaurantId, origin: "PUBLIC" },
    });
    const tokenBefore = await prisma.reservationManagementToken.findUniqueOrThrow({
      where: { reservationId: stored.id },
    });

    await cancelStaffReservation({
      actor: staffActor,
      reservationId: stored.id,
      rawPayload: { version: stored.version },
      now,
    });
    const visible = await readPublicReservation({
      restaurantId,
      rawToken: created.managementPath.slice("/p/".length),
      now,
    });
    const tokenAfter = await prisma.reservationManagementToken.findUniqueOrThrow({
      where: { reservationId: stored.id },
    });

    expect(visible.status).toBe("CANCELLED");
    expect(tokenAfter).toMatchObject({
      tokenHash: tokenBefore.tokenHash,
      revokedAt: null,
      viewExpiresAt: tokenBefore.viewExpiresAt,
    });
  });

  it("serializes concurrent public and Staff cancellation into one state change", async () => {
    const created = await createPublicReservation({
      restaurantId,
      managementSecret,
      rawPayload: publicPayload(),
      rawIdempotencyKey: randomUUID(),
      now,
      config,
    });
    const stored = await prisma.reservation.findFirstOrThrow({
      where: { restaurantId, origin: "PUBLIC" },
    });
    const rawToken = created.managementPath.slice("/p/".length);
    const attempts = await Promise.allSettled([
      cancelStaffReservation({
        actor: staffActor,
        reservationId: stored.id,
        rawPayload: { version: stored.version },
        now,
      }),
      cancelManagedPublicReservation({ restaurantId, rawToken, now }),
    ]);
    const finalReservation = await prisma.reservation.findUniqueOrThrow({
      where: { id: stored.id },
    });

    expect(attempts.every((attempt) => attempt.status === "fulfilled")).toBe(true);
    expect(finalReservation).toMatchObject({ status: "CANCELLED", version: 2 });
    expect(
      await prisma.reservationAuditEvent.count({
        where: { reservationId: stored.id, action: "CANCELLED" },
      }),
    ).toBe(1);
  });
});
