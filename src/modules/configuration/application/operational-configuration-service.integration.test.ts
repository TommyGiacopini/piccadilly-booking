import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyOperationalConfigurationChange,
  ConfigurationImpactChangedError,
  previewOperationalConfigurationChange,
} from "@/modules/configuration/application/operational-configuration-service";
import {
  DAY_OF_WEEK_VALUES,
  DEFAULT_SERVICE_TIMES,
  SERVICE_TYPE_VALUES,
} from "@/modules/configuration/domain/defaults";
import {
  localDateToDatabase,
  operationalTimeToDatabase,
} from "@/modules/configuration/domain/operational-time";
import { prisma } from "@/server/db/prisma";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const adminId = randomUUID();
const secondAdminId = randomUUID();
const staffId = randomUUID();
const mustChangeAdminId = randomUUID();
const otherAdminId = randomUUID();
const now = new Date("2099-01-01T10:00:00.000Z");
const mondayDinnerDate = "2099-11-16";
const activeOverrideDate = "2099-11-23";
const archivedOverrideDate = "2099-11-30";
const adminActor = { id: adminId, restaurantId };
const secondAdminActor = { id: secondAdminId, restaurantId };

function settingsProposal(overrides: Record<string, unknown> = {}) {
  return {
    kind: "BOOKING_SETTINGS",
    rollingCapacityCovers: 30,
    lunchModificationCutoff: "10:30",
    dinnerModificationCutoff: "17:30",
    ...overrides,
  };
}

async function createReservation(input: {
  localDate?: string;
  serviceType?: "LUNCH" | "DINNER";
  arrivalTime?: string;
  partySize: number;
  origin?: "PHONE" | "PUBLIC";
  status?: "CONFIRMED" | "CANCELLED";
  marker: string;
}) {
  const origin = input.origin ?? "PHONE";
  const status = input.status ?? "CONFIRMED";
  return prisma.reservation.create({
    data: {
      restaurantId,
      localDate: localDateToDatabase(input.localDate ?? mondayDinnerDate),
      serviceType: input.serviceType ?? "DINNER",
      arrivalTime: operationalTimeToDatabase(input.arrivalTime ?? "19:00"),
      partySize: input.partySize,
      status,
      origin,
      customerFirstName: `Sentinel-${input.marker}`,
      customerLastName: "Customer",
      customerPhone: "+39000000000",
      customerEmail: `sentinel.${input.marker}@example.invalid`,
      notes: `forbidden-note-${input.marker}`,
      allergies: `forbidden-allergy-${input.marker}`,
      privacyPolicyVersion: "privacy-demo-v1",
      privacyConsentAt: now,
      privacyConsentMethod: origin === "PUBLIC" ? "WEB_CHECKBOX" : "VERBAL",
      termsPolicyVersion: origin === "PUBLIC" ? "terms-demo-v1" : null,
      termsConsentAt: origin === "PUBLIC" ? now : null,
      termsConsentMethod: origin === "PUBLIC" ? "WEB_CHECKBOX" : null,
      consentLanguage: origin === "PUBLIC" ? "it" : null,
      createdByUserId: origin === "PHONE" ? adminId : null,
      cancelledAt: status === "CANCELLED" ? now : null,
    },
  });
}

describe.sequential("M9-C impact-aware operational configuration", () => {
  beforeAll(async () => {
    await prisma.restaurant.createMany({
      data: [
        { id: restaurantId, name: "M9-C Demo", timezone: "Europe/Rome" },
        { id: otherRestaurantId, name: "M9-C Other", timezone: "Europe/Rome" },
      ],
    });
    await prisma.user.createMany({
      data: [
        { id: adminId, restaurantId, username: `m9c.admin.${adminId}`, passwordHash: "fake", role: "ADMIN" },
        { id: secondAdminId, restaurantId, username: `m9c.admin2.${secondAdminId}`, passwordHash: "fake", role: "ADMIN" },
        { id: staffId, restaurantId, username: `m9c.staff.${staffId}`, passwordHash: "fake", role: "STAFF" },
        { id: mustChangeAdminId, restaurantId, username: `m9c.change.${mustChangeAdminId}`, passwordHash: "fake", role: "ADMIN", mustChangePassword: true },
        { id: otherAdminId, restaurantId: otherRestaurantId, username: `m9c.other.${otherAdminId}`, passwordHash: "fake", role: "ADMIN" },
      ],
    });
    await prisma.restaurantBookingSettings.create({
      data: {
        restaurantId,
        rollingCapacityCovers: 30,
        rollingWindowMinutes: 30,
        lunchModificationCutoff: operationalTimeToDatabase("10:30"),
        dinnerModificationCutoff: operationalTimeToDatabase("17:30"),
      },
    });
    await prisma.weeklyServiceSchedule.createMany({
      data: DAY_OF_WEEK_VALUES.flatMap((dayOfWeek) =>
        SERVICE_TYPE_VALUES.map((serviceType) => ({
          restaurantId,
          dayOfWeek,
          serviceType,
          isEnabled: true,
          startTime: operationalTimeToDatabase(DEFAULT_SERVICE_TIMES[serviceType].startTime),
          endTime: operationalTimeToDatabase(DEFAULT_SERVICE_TIMES[serviceType].endTime),
          slotIntervalMinutes: 15,
        })),
      ),
    });
  });

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany({ where: { restaurantId } });
    await prisma.reservation.deleteMany({ where: { restaurantId } });
    await prisma.specialDateOverride.deleteMany({ where: { restaurantId } });
    await prisma.bookingCutoffRule.deleteMany({ where: { restaurantId } });
    await prisma.restaurantBookingSettings.update({
      where: { restaurantId },
      data: {
        rollingCapacityCovers: 30,
        rollingWindowMinutes: 30,
        lunchModificationCutoff: operationalTimeToDatabase("10:30"),
        dinnerModificationCutoff: operationalTimeToDatabase("17:30"),
      },
    });
    await prisma.weeklyServiceSchedule.updateMany({
      where: { restaurantId },
      data: { isEnabled: true, slotIntervalMinutes: 15 },
    });
    await prisma.user.update({ where: { id: adminId }, data: { role: "ADMIN", isActive: true, disabledAt: null, mustChangePassword: false } });
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { restaurantId } });
    await prisma.reservation.deleteMany({ where: { restaurantId } });
    await prisma.specialDateOverride.deleteMany({ where: { restaurantId } });
    await prisma.bookingCutoffRule.deleteMany({ where: { restaurantId } });
    await prisma.weeklyServiceSchedule.deleteMany({ where: { restaurantId } });
    await prisma.restaurantBookingSettings.deleteMany({ where: { restaurantId } });
    await prisma.user.deleteMany({ where: { restaurantId: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.restaurant.deleteMany({ where: { id: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.$disconnect();
  });

  it("previews without mutation and applies a no-impact change with atomic audit", async () => {
    const proposal = settingsProposal({ rollingCapacityCovers: 35 });
    const preview = await previewOperationalConfigurationChange(adminActor, proposal, { now });

    expect(preview).toMatchObject({ changed: true, confirmationRequired: false });
    expect(preview.impact.items[0]?.classification).toBe("NO_EXISTING_RESERVATION_IMPACT");
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
    await expect(prisma.restaurantBookingSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ rollingCapacityCovers: 30 });

    await expect(applyOperationalConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now })).resolves.toEqual({ changed: true });
    await expect(prisma.restaurantBookingSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ rollingCapacityCovers: 35, rollingWindowMinutes: 30 });
    await expect(prisma.auditEvent.findFirstOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ action: "BOOKING_SETTINGS_UPDATED", actorUserId: adminId, actorRole: "ADMIN" });
  });

  it("detects real rolling-window overflow and preserves every reservation", async () => {
    await createReservation({ partySize: 18, arrivalTime: "19:00", marker: "capacity-a" });
    await createReservation({ partySize: 14, arrivalTime: "19:15", marker: "capacity-b" });
    await createReservation({ partySize: 90, arrivalTime: "19:00", marker: "cancelled", status: "CANCELLED" });
    const before = await prisma.reservation.findMany({ where: { restaurantId }, select: { id: true, status: true, partySize: true, version: true, updatedAt: true }, orderBy: { id: "asc" } });
    const proposal = settingsProposal({ rollingCapacityCovers: 25 });
    const preview = await previewOperationalConfigurationChange(adminActor, proposal, { now });

    expect(preview.confirmationRequired).toBe(true);
    expect(preview.impact).toMatchObject({ reservationCount: 2, covers: 32 });
    expect(preview.impact.items).toContainEqual(expect.objectContaining({ classification: "CAPACITY_EXCEEDED", slot: "19:00", previousLimit: 30, proposedLimit: 25, maxLoad: 32 }));
    expect(JSON.stringify(preview)).not.toContain("Sentinel-");
    expect(JSON.stringify(preview)).not.toContain("forbidden-");

    await applyOperationalConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now });
    await expect(prisma.reservation.findMany({ where: { restaurantId }, select: { id: true, status: true, partySize: true, version: true, updatedAt: true }, orderBy: { id: "asc" } })).resolves.toEqual(before);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { restaurantId } });
    expect(audit.metadata).toMatchObject({ reservationCount: 2, covers: 32, previousLimit: 30, proposedLimit: 25, maxLoad: 32 });
    expect(JSON.stringify(audit)).not.toContain("Sentinel-");
    expect(JSON.stringify(audit)).not.toContain("forbidden-");
  });

  it("classifies changed public modification cutoffs without customer data", async () => {
    await createReservation({ partySize: 4, origin: "PUBLIC", marker: "public-cutoff" });
    await createReservation({ partySize: 3, origin: "PHONE", marker: "phone-cutoff" });
    const preview = await previewOperationalConfigurationChange(
      adminActor,
      settingsProposal({ dinnerModificationCutoff: "17:00" }),
      { now },
    );

    expect(preview.impact).toMatchObject({ reservationCount: 1, covers: 4 });
    expect(preview.impact.items[0]?.classification).toBe("MODIFICATION_CUTOFF_CHANGED");
    expect(JSON.stringify(preview)).not.toContain("public-cutoff");
  });

  it("honors active special dates and ignores archived ones for weekly disable impact", async () => {
    const mondaySchedule = await prisma.weeklyServiceSchedule.findFirstOrThrow({ where: { restaurantId, dayOfWeek: "MONDAY", serviceType: "DINNER" } });
    await createReservation({ partySize: 2, localDate: mondayDinnerDate, marker: "weekly" });
    await createReservation({ partySize: 3, localDate: activeOverrideDate, marker: "active" });
    await createReservation({ partySize: 4, localDate: archivedOverrideDate, marker: "archived" });
    await prisma.specialDateOverride.createMany({ data: [
      { restaurantId, date: localDateToDatabase(activeOverrideDate), scope: "DINNER", isClosed: false },
      { restaurantId, date: localDateToDatabase(archivedOverrideDate), scope: "DINNER", isClosed: false, archivedAt: now },
    ] });
    const proposal = { kind: "WEEKLY_SCHEDULE", id: mondaySchedule.id, dayOfWeek: "MONDAY", serviceType: "DINNER", isEnabled: false, startTime: "19:00", endTime: "22:15" };
    const preview = await previewOperationalConfigurationChange(adminActor, proposal, { now });

    expect(preview.impact).toMatchObject({ reservationCount: 2, covers: 6 });
    expect(preview.impact.items.map((item) => item.localDate)).toEqual(expect.arrayContaining([mondayDinnerDate, archivedOverrideDate]));
    expect(preview.impact.items.map((item) => item.localDate)).not.toContain(activeOverrideDate);
  });

  it("detects a future reservation newly outside reduced service hours", async () => {
    const mondaySchedule = await prisma.weeklyServiceSchedule.findFirstOrThrow({ where: { restaurantId, dayOfWeek: "MONDAY", serviceType: "DINNER" } });
    await createReservation({ partySize: 5, localDate: mondayDinnerDate, arrivalTime: "22:15", marker: "outside-hours" });
    const preview = await previewOperationalConfigurationChange(adminActor, {
      kind: "WEEKLY_SCHEDULE",
      id: mondaySchedule.id,
      dayOfWeek: "MONDAY",
      serviceType: "DINNER",
      isEnabled: true,
      startTime: "19:00",
      endTime: "21:45",
    }, { now });

    expect(preview.impact).toMatchObject({ reservationCount: 1, covers: 5 });
    expect(preview.impact.items[0]).toMatchObject({ classification: "OUTSIDE_NEW_HOURS", slot: "22:15" });
  });

  it("gives active special capacity precedence over a lower default", async () => {
    await createReservation({ partySize: 28, localDate: activeOverrideDate, marker: "special-capacity" });
    await prisma.specialDateOverride.create({
      data: {
        restaurantId,
        date: localDateToDatabase(activeOverrideDate),
        scope: "DINNER",
        isClosed: false,
        specialCapacityCovers: 40,
      },
    });
    const preview = await previewOperationalConfigurationChange(
      adminActor,
      settingsProposal({ rollingCapacityCovers: 20 }),
      { now },
    );

    expect(preview.impact).toMatchObject({ reservationCount: 0, covers: 0 });
    expect(preview.impact.items[0]?.classification).toBe("NO_EXISTING_RESERVATION_IMPACT");
  });

  it("rejects a stale preview after a relevant reservation appears", async () => {
    await createReservation({ partySize: 20, marker: "stale-before" });
    const proposal = settingsProposal({ rollingCapacityCovers: 25 });
    const preview = await previewOperationalConfigurationChange(adminActor, proposal, { now });
    await createReservation({ partySize: 8, arrivalTime: "19:15", marker: "stale-after" });

    await expect(applyOperationalConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now })).rejects.toBeInstanceOf(ConfigurationImpactChangedError);
    await expect(prisma.restaurantBookingSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ rollingCapacityCovers: 30 });
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
  });

  it("rejects a stale preview after a relevant reservation is cancelled", async () => {
    await createReservation({ partySize: 20, marker: "cancel-before" });
    const cancelled = await createReservation({ partySize: 8, arrivalTime: "19:15", marker: "cancel-after" });
    const proposal = settingsProposal({ rollingCapacityCovers: 25 });
    const preview = await previewOperationalConfigurationChange(adminActor, proposal, { now });

    await prisma.reservation.update({
      where: { id: cancelled.id },
      data: { status: "CANCELLED", cancelledAt: now },
    });

    await expect(applyOperationalConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now })).rejects.toBeInstanceOf(ConfigurationImpactChangedError);
    await expect(prisma.restaurantBookingSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ rollingCapacityCovers: 30 });
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
  });

  it.each([
    { field: "arrival time", data: { arrivalTime: operationalTimeToDatabase("19:15") } },
    { field: "party size", data: { partySize: 9 } },
    { field: "service", data: { serviceType: "LUNCH" as const } },
    { field: "date", data: { localDate: localDateToDatabase("2099-11-17") } },
  ])("rejects a stale preview after a relevant reservation changes $field", async ({ data }) => {
    const reservation = await createReservation({ partySize: 8, marker: `changed-${randomUUID()}` });
    const proposal = settingsProposal({ rollingCapacityCovers: 1 });
    const preview = await previewOperationalConfigurationChange(adminActor, proposal, { now });

    await prisma.reservation.update({ where: { id: reservation.id }, data });

    await expect(applyOperationalConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now })).rejects.toBeInstanceOf(ConfigurationImpactChangedError);
    await expect(prisma.restaurantBookingSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ rollingCapacityCovers: 30 });
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
  });

  it("does not invalidate a weekly preview for an irrelevant reservation", async () => {
    const mondaySchedule = await prisma.weeklyServiceSchedule.findFirstOrThrow({ where: { restaurantId, dayOfWeek: "MONDAY", serviceType: "DINNER" } });
    await createReservation({ partySize: 2, marker: "relevant-weekly" });
    const proposal = { kind: "WEEKLY_SCHEDULE", id: mondaySchedule.id, dayOfWeek: "MONDAY", serviceType: "DINNER", isEnabled: false, startTime: "19:00", endTime: "22:15" } as const;
    const preview = await previewOperationalConfigurationChange(adminActor, proposal, { now });

    await createReservation({
      partySize: 3,
      localDate: "2099-11-17",
      serviceType: "LUNCH",
      marker: "irrelevant-weekly",
    });

    await expect(applyOperationalConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now })).resolves.toEqual({ changed: true });
    await expect(prisma.weeklyServiceSchedule.findUniqueOrThrow({ where: { id: mondaySchedule.id } })).resolves.toMatchObject({ isEnabled: false });
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(1);
  });

  it("serializes two Admin updates without losing one silently", async () => {
    const firstProposal = settingsProposal({ rollingCapacityCovers: 29 });
    const secondProposal = settingsProposal({ rollingCapacityCovers: 28 });
    const [firstPreview, secondPreview] = await Promise.all([
      previewOperationalConfigurationChange(adminActor, firstProposal, { now }),
      previewOperationalConfigurationChange(secondAdminActor, secondProposal, { now }),
    ]);
    const outcomes = await Promise.allSettled([
      applyOperationalConfigurationChange(adminActor, { proposal: firstProposal, fingerprint: firstPreview.fingerprint }, { now }),
      applyOperationalConfigurationChange(secondAdminActor, { proposal: secondProposal, fingerprint: secondPreview.fingerprint }, { now }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(1);
    const settings = await prisma.restaurantBookingSettings.findUniqueOrThrow({ where: { restaurantId } });
    expect([28, 29]).toContain(settings.rollingCapacityCovers);
  });

  it("rolls the mutation back when its audit insert fails", async () => {
    const proposal = settingsProposal({ rollingCapacityCovers: 34 });
    const preview = await previewOperationalConfigurationChange(adminActor, proposal, { now });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION m9c_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'BOOKING_SETTINGS_UPDATED' AND NEW.restaurant_id = '${restaurantId}'::uuid THEN RAISE EXCEPTION 'synthetic M9-C audit failure'; END IF; RETURN NEW; END; $$;`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER m9c_test_reject_audit_trigger BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION m9c_test_reject_audit();`);

    try {
      await expect(applyOperationalConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now })).rejects.toThrow("synthetic M9-C audit failure");
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS m9c_test_reject_audit_trigger ON audit_events");
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS m9c_test_reject_audit()");
    }
    await expect(prisma.restaurantBookingSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ rollingCapacityCovers: 30 });
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
  });

  it("re-reads actor role/status, isolates tenants, and rejects client restaurantId", async () => {
    await expect(previewOperationalConfigurationChange({ id: staffId, restaurantId }, settingsProposal(), { now })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(previewOperationalConfigurationChange({ id: mustChangeAdminId, restaurantId }, settingsProposal(), { now })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(previewOperationalConfigurationChange({ id: otherAdminId, restaurantId }, settingsProposal(), { now })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(previewOperationalConfigurationChange(adminActor, { ...settingsProposal(), restaurantId }, { now })).rejects.toMatchObject({ code: "VALIDATION" });

    const proposal = settingsProposal({ rollingCapacityCovers: 31 });
    const preview = await previewOperationalConfigurationChange(adminActor, proposal, { now });
    await prisma.user.update({ where: { id: adminId }, data: { role: "STAFF" } });
    await expect(applyOperationalConfigurationChange(adminActor, { proposal, fingerprint: preview.fingerprint }, { now })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(prisma.restaurantBookingSettings.findUniqueOrThrow({ where: { restaurantId } })).resolves.toMatchObject({ rollingCapacityCovers: 30 });
  });

  it("creates, updates and disables a generic cutoff rule with fixed audit actions", async () => {
    const createProposal = { kind: "BOOKING_CUTOFF_RULE", dayOfWeek: "MONDAY", serviceType: "LUNCH", isEnabled: true, cutoffTime: "10:00" };
    const createPreview = await previewOperationalConfigurationChange(adminActor, createProposal, { now });
    await applyOperationalConfigurationChange(adminActor, { proposal: createProposal, fingerprint: createPreview.fingerprint }, { now });
    const disableProposal = { ...createProposal, isEnabled: false };
    const disablePreview = await previewOperationalConfigurationChange(adminActor, disableProposal, { now });
    await applyOperationalConfigurationChange(adminActor, { proposal: disableProposal, fingerprint: disablePreview.fingerprint }, { now });

    await expect(prisma.auditEvent.findMany({ where: { restaurantId }, select: { action: true } })).resolves.toEqual(
      expect.arrayContaining([
        { action: "PUBLIC_BOOKING_CUTOFF_RULE_CREATED" },
        { action: "PUBLIC_BOOKING_CUTOFF_RULE_DISABLED" },
      ]),
    );
    await expect(prisma.bookingCutoffRule.findUniqueOrThrow({ where: { restaurantId_dayOfWeek_serviceType: { restaurantId, dayOfWeek: "MONDAY", serviceType: "LUNCH" } } })).resolves.toMatchObject({ isEnabled: false, cutoffTime: operationalTimeToDatabase("10:00") });
  });

  it("treats an exact no-op as no mutation and no audit", async () => {
    const preview = await previewOperationalConfigurationChange(adminActor, settingsProposal(), { now });
    expect(preview.changed).toBe(false);
    await expect(applyOperationalConfigurationChange(adminActor, { proposal: settingsProposal(), fingerprint: preview.fingerprint }, { now })).resolves.toEqual({ changed: false });
    await expect(prisma.auditEvent.count({ where: { restaurantId } })).resolves.toBe(0);
  });
});
