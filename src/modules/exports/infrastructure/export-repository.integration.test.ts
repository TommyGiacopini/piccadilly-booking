import { buildExportPreview, ExportPreviewDataError, type ExportPreviewRequest } from "@/modules/exports/domain/export-contract";
import { ExportSnapshotTooLargeError } from "@/modules/exports/application/export-errors";
import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import {
  getAuditEventDetail,
  listAuditEvents,
} from "@/modules/audit/application/audit-query-service";
import { resolveExcelExportPeriod } from "@/modules/exports/domain/export-domain";
import { createInfrastructureExportService } from "@/modules/exports/infrastructure/export-composition";
import {
  ExportActorUnavailableError,
  readExportPreviewWithClient,
  readExportSnapshot,
  readExportSnapshotWithClient,
} from "@/modules/exports/infrastructure/export-repository";
import { resolveDatabaseUrl } from "@/server/db/database-config";
import { prisma } from "@/server/db/prisma";

const restaurantId = randomUUID();
const otherRestaurantId = randomUUID();
const staffId = randomUUID();
const adminId = randomUUID();
const disabledStaffId = randomUUID();
const mustChangeStaffId = randomUUID();
const otherStaffId = randomUUID();
const assignedReservationId = randomUUID();
const clearedReservationId = randomUUID();
const cancelledReservationId = randomUUID();
const concurrentReservationId = randomUUID();
const otherReservationId = randomUUID();
const localDate = "2026-08-24";
const roomDefinitions = [
  ["sala-1", "Sala 1", "DEFAULT_AVAILABLE"],
  ["sala-2", "Sala 2", "DEFAULT_AVAILABLE"],
  ["sala-3", "Sala 3", "DEFAULT_AVAILABLE"],
  ["galleria", "Galleria", "EXPLICIT_ONLY"],
  ["terrazzo", "Terrazzo", "EXPLICIT_ONLY"],
] as const;
const roomIds = new Map(roomDefinitions.map(([code]) => [code, randomUUID()]));
const tableId = randomUUID();

function reservationData(input: {
  id: string;
  tenant?: string;
  status?: "CONFIRMED" | "CANCELLED";
  firstName?: string;
  lastName?: string;
  notes?: string | null;
  createdAt?: Date;
}) {
  return {
    id: input.id,
    restaurantId: input.tenant ?? restaurantId,
    localDate: new Date(`${localDate}T00:00:00.000Z`),
    serviceType: "DINNER" as const,
    arrivalTime: new Date("1970-01-01T19:00:00.000Z"),
    partySize: 2,
    status: input.status ?? "CONFIRMED",
    origin: "PHONE" as const,
    customerFirstName: input.firstName ?? "Cliente",
    customerLastName: input.lastName ?? "M11",
    customerPhone: "+39000000000",
    customerEmail: null,
    notes: input.notes ?? null,
    preferences: JSON.stringify({
      roomCode: "sala-2",
      highChair: true,
      stroller: false,
      accessibility: false,
      children: true,
      celebration: "Festa fittizia",
      animals: false,
    }),
    allergies: JSON.stringify({
      celiac: false,
      allergies: "Arachidi fittizie",
      intolerances: null,
    }),
    privacyPolicyVersion: "test-v1",
    privacyConsentAt: new Date("2026-08-01T10:00:00.000Z"),
    privacyConsentMethod: "VERBAL" as const,
    createdByUserId:
      (input.tenant ?? restaurantId) === restaurantId ? staffId : otherStaffId,
    createdAt: input.createdAt ?? new Date("2026-08-01T10:00:00.000Z"),
    cancelledAt:
      input.status === "CANCELLED"
        ? new Date("2026-08-20T10:00:00.000Z")
        : null,
  };
}

async function cleanup(): Promise<void> {
  for (const tenant of [restaurantId, otherRestaurantId]) {
    await prisma.auditEvent.deleteMany({ where: { restaurantId: tenant } });
    await prisma.reservationAssignmentTable.deleteMany({
      where: { restaurantId: tenant },
    });
    await prisma.reservationAssignment.deleteMany({ where: { restaurantId: tenant } });
    await prisma.reservationAuditEvent.deleteMany({ where: { restaurantId: tenant } });
    await prisma.reservation.deleteMany({ where: { restaurantId: tenant } });
    await prisma.diningTable.deleteMany({ where: { room: { restaurantId: tenant } } });
    await prisma.room.deleteMany({ where: { restaurantId: tenant } });
    await prisma.user.deleteMany({ where: { restaurantId: tenant } });
    await prisma.restaurant.deleteMany({ where: { id: tenant } });
  }
}

async function businessFingerprint(): Promise<string> {
  const [reservations, assignments, assignmentTables, rooms, tables, instances] =
    await Promise.all([
      prisma.reservation.findMany({ where: { restaurantId }, orderBy: { id: "asc" } }),
      prisma.reservationAssignment.findMany({
        where: { restaurantId },
        orderBy: { id: "asc" },
      }),
      prisma.reservationAssignmentTable.findMany({
        where: { restaurantId },
        orderBy: [{ assignmentId: "asc" }, { diningTableId: "asc" }],
      }),
      prisma.room.findMany({ where: { restaurantId }, orderBy: { id: "asc" } }),
      prisma.diningTable.findMany({
        where: { room: { restaurantId } },
        orderBy: { id: "asc" },
      }),
      prisma.serviceInstance.findMany({
        where: { restaurantId },
        orderBy: { id: "asc" },
      }),
    ]);
  return JSON.stringify({
    reservations,
    assignments,
    assignmentTables,
    rooms,
    tables,
    instances,
  });
}

beforeAll(async () => {
  await cleanup();
  await prisma.restaurant.createMany({
    data: [
      { id: restaurantId, name: "M11 Ristorante fittizio", timezone: "Europe/Rome" },
      {
        id: otherRestaurantId,
        name: "M11 Decoy cross-tenant",
        timezone: "Europe/Rome",
      },
    ],
  });
  await prisma.user.createMany({
    data: [
      {
        id: staffId,
        restaurantId,
        username: `m11.staff.${staffId.slice(0, 8)}`,
        passwordHash: "fake-test-hash",
        role: "STAFF",
      },
      {
        id: adminId,
        restaurantId,
        username: `m11.admin.${adminId.slice(0, 8)}`,
        passwordHash: "fake-test-hash",
        role: "ADMIN",
      },
      {
        id: disabledStaffId,
        restaurantId,
        username: `m11.disabled.${disabledStaffId.slice(0, 8)}`,
        passwordHash: "fake-test-hash",
        role: "STAFF",
        isActive: false,
        disabledAt: new Date("2026-08-01T00:00:00Z"),
      },
      {
        id: mustChangeStaffId,
        restaurantId,
        username: `m11.must.${mustChangeStaffId.slice(0, 8)}`,
        passwordHash: "fake-test-hash",
        role: "STAFF",
        mustChangePassword: true,
      },
      {
        id: otherStaffId,
        restaurantId: otherRestaurantId,
        username: `m11.other.${otherStaffId.slice(0, 8)}`,
        passwordHash: "fake-test-hash",
        role: "STAFF",
      },
    ],
  });
  await prisma.room.createMany({
    data: [
      ...roomDefinitions.map(([code, name, policy], index) => ({
        id: roomIds.get(code)!,
        restaurantId,
        code,
        name,
        serviceAvailabilityPolicy: policy,
        displayOrder: index + 1,
      })),
      {
        id: randomUUID(),
        restaurantId: otherRestaurantId,
        code: "sala-1",
        name: "Sala 1",
        serviceAvailabilityPolicy: "DEFAULT_AVAILABLE" as const,
        displayOrder: 1,
      },
    ],
  });
  await prisma.diningTable.create({
    data: {
      id: tableId,
      roomId: roomIds.get("sala-1")!,
      name: "Tavolo grandfathered",
      minimumSeats: 1,
      maximumSeats: 4,
      displayOrder: 1,
    },
  });
  await prisma.reservation.createMany({
    data: [
      reservationData({
        id: assignedReservationId,
        lastName: "Assegnata",
        notes: "Nota esportabile",
        createdAt: new Date("2026-08-01T09:00:00Z"),
      }),
      reservationData({
        id: clearedReservationId,
        lastName: "Cleared",
        createdAt: new Date("2026-08-01T10:00:00Z"),
      }),
      reservationData({
        id: concurrentReservationId,
        lastName: "Concurrent",
        notes: "before-snapshot",
        createdAt: new Date("2026-08-01T11:00:00Z"),
      }),
      reservationData({
        id: cancelledReservationId,
        lastName: "Cancelled",
        status: "CANCELLED",
      }),
      reservationData({
        id: otherReservationId,
        tenant: otherRestaurantId,
        lastName: "CrossTenant",
      }),
    ],
  });
  const assignment = await prisma.reservationAssignment.create({
    data: {
      id: randomUUID(),
      restaurantId,
      reservationId: assignedReservationId,
      roomId: roomIds.get("sala-1")!,
      internalNotes: "Nota interna Staff M11",
      assignedByUserId: staffId,
      updatedByUserId: staffId,
    },
  });
  await prisma.reservationAssignmentTable.create({
    data: {
      restaurantId,
      assignmentId: assignment.id,
      roomId: roomIds.get("sala-1")!,
      diningTableId: tableId,
    },
  });
  await prisma.reservationAssignment.create({
    data: {
      id: randomUUID(),
      restaurantId,
      reservationId: clearedReservationId,
      roomId: roomIds.get("sala-2")!,
      internalNotes: "Nota cleared da ignorare",
      assignedByUserId: staffId,
      updatedByUserId: staffId,
      clearedAt: new Date("2026-08-10T10:00:00Z"),
    },
  });
  await prisma.room.update({
    where: { id: roomIds.get("sala-1")! },
    data: { isActive: false },
  });
  await prisma.diningTable.update({ where: { id: tableId }, data: { isActive: false } });
});

afterAll(cleanup);

describe("M11 PostgreSQL export snapshot", () => {
  const actor = { id: staffId, restaurantId };
  const period = resolveExcelExportPeriod({ mode: "DAY", date: localDate });
  it("T06 never selects or projects autonomous/active/cleared/cross-tenant NI and keeps business data unchanged", async () => {
    const markers = ["T06_REPO_AUTONOMOUS_NI", "T06_REPO_ACTIVE_NI", "T06_REPO_CLEARED_NI", "T06_REPO_OTHER_TENANT_NI"];
    await prisma.reservation.updateMany({ where: { id: { in: [assignedReservationId, clearedReservationId] } }, data: { privateNotes: markers[0] } });
    await prisma.reservation.update({ where: { id: otherReservationId }, data: { privateNotes: markers[3] } });
    await prisma.reservationAssignment.updateMany({ where: { reservationId: assignedReservationId }, data: { internalNotes: markers[1] } });
    await prisma.reservationAssignment.updateMany({ where: { reservationId: clearedReservationId }, data: { internalNotes: markers[2] } });
    const before = await businessFingerprint();
    const queries: string[] = [];
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: resolveDatabaseUrl(process.env.DATABASE_URL) }),
      log: [{ emit: "event", level: "query" }] });
    client.$on("query", (event) => queries.push(event.query));
    try {
      const snapshot = await readExportSnapshotWithClient(client, { actor, period });
      for (const marker of markers) expect(JSON.stringify(snapshot)).not.toContain(marker);
      expect(JSON.stringify(snapshot)).toContain("Nota esportabile");
      expect(queries.some((query) => query.includes("private_notes") || query.includes("internal_notes"))).toBe(false);
      expect(await businessFingerprint()).toBe(before);
    } finally { await client.$disconnect(); }
  });

  it("authorizes active Staff/Admin and rejects disabled, must-change and tenant-mismatched actors", async () => {
    await expect(readExportSnapshot({ actor, period })).resolves.toMatchObject({
      restaurantName: "M11 Ristorante fittizio",
    });
    await expect(
      readExportSnapshot({ actor: { id: adminId, restaurantId }, period }),
    ).resolves.toMatchObject({ restaurantName: "M11 Ristorante fittizio" });

    for (const deniedActor of [
      { id: disabledStaffId, restaurantId },
      { id: mustChangeStaffId, restaurantId },
      { id: otherStaffId, restaurantId },
    ]) {
      await expect(
        readExportSnapshot({ actor: deniedActor, period }),
      ).rejects.toBeInstanceOf(ExportActorUnavailableError);
    }
  });

  it("isolates the tenant, exports only CONFIRMED and maps active/cleared grandfathered assignments", async () => {
    const beforeInstances = await prisma.serviceInstance.count({ where: { restaurantId } });
    const result = await readExportSnapshot({ actor, period });
    expect(result.reservationCount).toBe(3);
    const all = result.days[0]!.sections.flatMap((section) => section.reservations);
    expect(all.map((item) => item.id)).not.toContain(cancelledReservationId);
    expect(all.map((item) => item.id)).not.toContain(otherReservationId);
    const assigned = all.find((item) => item.id === assignedReservationId)!;
    expect(assigned.assignment).toMatchObject({
      roomCode: "sala-1",
      tables: [{ id: tableId, name: "Tavolo grandfathered" }],
    });
    const cleared = all.find((item) => item.id === clearedReservationId)!;
    expect(cleared.assignment).toBeNull();
    expect(result.days[0]?.sections[0]?.reservations.map((item) => item.id)).toContain(
      clearedReservationId,
    );
    expect(result.days[0]?.sections[1]?.reservations.map((item) => item.id)).toContain(
      assignedReservationId,
    );
    await expect(
      prisma.serviceInstance.count({ where: { restaurantId } }),
    ).resolves.toBe(beforeInstances);
  });

  it("keeps a REPEATABLE READ snapshot across a concurrent update", async () => {
    const concurrentClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: resolveDatabaseUrl(process.env.DATABASE_URL) }),
    });
    try {
      const result = await readExportSnapshotWithClient(
        prisma,
        { actor, period },
        {
          afterContextRead: async () => {
            await concurrentClient.$transaction(async (client) => {
              await client.reservation.update({
                where: { id: concurrentReservationId },
                data: { notes: "after-snapshot" },
              });
            });
          },
        },
      );
      const exported = result.days[0]!.sections
        .flatMap((section) => section.reservations)
        .find((item) => item.id === concurrentReservationId)!;
      expect(exported.notes).toBe("before-snapshot");
      await expect(
        prisma.reservation.findUniqueOrThrow({
          where: { id: concurrentReservationId },
          select: { notes: true },
        }),
      ).resolves.toEqual({ notes: "after-snapshot" });
    } finally {
      await concurrentClient.$disconnect();
    }
  });

  it("uses a bounded query count independent of reservation cardinality", async () => {
    const queryClient = new PrismaClient({
      adapter: new PrismaPg({ connectionString: resolveDatabaseUrl(process.env.DATABASE_URL) }),
      log: [{ emit: "event", level: "query" }],
    });
    let firstCount = 0;
    let secondCount = 0;
    let target: "first" | "second" = "first";
    queryClient.$on("query", () => {
      if (target === "first") firstCount += 1;
      else secondCount += 1;
    });
    try {
      await readExportSnapshotWithClient(queryClient, { actor, period });
      await prisma.reservation.createMany({
        data: Array.from({ length: 12 }, (_, index) =>
          reservationData({
            id: randomUUID(),
            lastName: `Bounded ${index}`,
            createdAt: new Date(Date.UTC(2026, 7, 2, 10, index)),
          }),
        ),
      });
      target = "second";
      await readExportSnapshotWithClient(queryClient, { actor, period });
      expect(firstCount).toBeGreaterThan(0);
      expect(secondCount).toBe(firstCount);
      expect(secondCount).toBeLessThanOrEqual(10);
    } finally {
      await queryClient.$disconnect();
    }
  });

  it("renders real PDF and Excel buffers from the PostgreSQL snapshot", async () => {
    const before = await businessFingerprint();
    const exportService = createInfrastructureExportService();
    const pdf = await exportService.generatePdfExport({
      actor,
      request: { date: localDate },
    });
    expect(pdf.contentType).toBe("application/pdf");
    expect(pdf.buffer.subarray(0, 5).toString()).toBe("%PDF-");

    const excel = await exportService.generateExcelExport({
      actor: { id: adminId, restaurantId },
      request: { mode: "DAY", date: localDate },
    });
    expect(excel.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(excel.buffer.subarray(0, 2).toString()).toBe("PK");
    expect(await businessFingerprint()).toBe(before);
  });

  it("writes only AuditEvent on success/failure and leaves business tables unchanged", async () => {
    const before = await businessFingerprint();
    const successCorrelation = randomUUID();
    const success = await createInfrastructureExportService({
      pdfRenderer: { render: async () => Buffer.from("synthetic-pdf-buffer") },
      correlationIds: { generate: () => successCorrelation },
    }).generatePdfExport({
      actor,
      request: { date: localDate },
    });
    expect(success.buffer.toString()).toBe("synthetic-pdf-buffer");
    const successAudit = await prisma.auditEvent.findFirstOrThrow({
      where: { restaurantId, correlationId: successCorrelation },
    });
    expect(successAudit).toMatchObject({
      category: "EXPORT",
      action: "PDF_EXPORT_REQUESTED",
      outcome: "SUCCESS",
      actorUserId: staffId,
      actorRole: "STAFF",
      entityType: null,
      entityId: null,
      previousState: null,
      newState: null,
    });
    expect(successAudit.metadata).toEqual({
      format: "PDF",
      mode: "DAY",
      fromDate: localDate,
      toDate: localDate,
      dayCount: 1,
      reservationCount: 15,
    });

    const failureCorrelation = randomUUID();
    await expect(
      createInfrastructureExportService({
        excelRenderer: {
          render: async () => {
            throw new Error("synthetic integration renderer failure");
          },
        },
        correlationIds: { generate: () => failureCorrelation },
      }).generateExcelExport({
        actor,
        request: { mode: "DAY", date: localDate },
      }),
    ).rejects.toMatchObject({ code: "EXPORT_GENERATION_FAILED" });
    await expect(
      prisma.auditEvent.findFirstOrThrow({
        where: { restaurantId, correlationId: failureCorrelation },
        select: { outcome: true, metadata: true },
      }),
    ).resolves.toEqual({
      outcome: "FAILURE",
      metadata: {
        format: "EXCEL",
        mode: "DAY",
        fromDate: localDate,
        toDate: localDate,
        dayCount: 1,
        failureCode: "GENERATION_FAILED",
      },
    });

    const decoyAudit = await prisma.auditEvent.create({
      data: {
        restaurantId: otherRestaurantId,
        category: "EXPORT",
        action: "PDF_EXPORT_REQUESTED",
        outcome: "SUCCESS",
        actorUserId: otherStaffId,
        actorRole: "STAFF",
        correlationId: randomUUID(),
        metadata: {
          format: "PDF",
          mode: "DAY",
          fromDate: localDate,
          toDate: localDate,
          dayCount: 1,
          reservationCount: 1,
        },
      },
    });
    const auditViewer = { id: adminId, restaurantId };
    const exportPage = await listAuditEvents(
      auditViewer,
      new URLSearchParams("category=EXPORT&limit=100"),
    );
    expect(exportPage.items.map((item) => item.eventId)).toEqual(
      expect.arrayContaining([successAudit.id]),
    );
    expect(exportPage.items.map((item) => item.eventId)).not.toContain(decoyAudit.id);
    const detail = await getAuditEventDetail(
      auditViewer,
      "ADMINISTRATIVE",
      successAudit.id,
    );
    expect(detail).toMatchObject({
      category: "EXPORT",
      action: "PDF_EXPORT_REQUESTED",
      outcome: "SUCCESS",
      previousState: [],
      newState: [],
    });
    expect(detail.metadata.map((field) => field.key)).toEqual([
      "format",
      "mode",
      "fromDate",
      "toDate",
      "dayCount",
      "reservationCount",
    ]);
    await expect(
      getAuditEventDetail(auditViewer, "ADMINISTRATIVE", decoyAudit.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await businessFingerprint()).toBe(before);
  });
});

describe.sequential("T09 PostgreSQL preview read model", () => {
  const actor = { id: staffId, restaurantId };
  const selection: ExportPreviewRequest = { version: 2, target: "PDF", period: { mode: "DAY", date: localDate }, service: "DINNER", room: "ALL", order: "CREATED_ASC" };
  it("uses a positive SQL select without NI, phone or email and keeps only authorized confirmed records", async () => {
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: resolveDatabaseUrl(process.env.DATABASE_URL) }), log: [{ emit: "event", level: "query" }] });
    const queries: string[] = []; client.$on("query", event => queries.push(event.query));
    const before = await businessFingerprint(), auditBefore = await prisma.auditEvent.count({ where: { restaurantId } });
    try {
      const snapshot = await readExportPreviewWithClient(client, { actor, selection, maximumReservations: 2000 });
      const dto = buildExportPreview({ selection, snapshot, readAt: new Date() });
      expect(snapshot.reservations.map(row => row.id)).toContain(assignedReservationId);
      expect(snapshot.reservations.map(row => row.id)).not.toContain(cancelledReservationId);
      expect(snapshot.reservations.map(row => row.id)).not.toContain(otherReservationId);
      expect(snapshot.reservations.find(row => row.id === clearedReservationId)?.assignment).toBeNull();
      expect(dto.groups[1].rows.find(row => row.customerLastName === "Assegnata")).toMatchObject({ tableNames: ["Tavolo grandfathered"], childrenCount: null, adultsCount: null, legacyChildren: true });
      expect(JSON.stringify(dto)).toContain("Nota esportabile");
      expect(queries.some(query => /private_notes|internal_notes|customer_phone|customer_email/u.test(query))).toBe(false);
      expect(queries.some(query => /LIMIT/u.test(query))).toBe(true);
      expect(queries.length).toBeLessThanOrEqual(12);
      expect(await businessFingerprint()).toBe(before);
      expect(await prisma.auditEvent.count({ where: { restaurantId } })).toBe(auditBefore);
    } finally { await client.$disconnect(); }
  });
  it("filters day, service and actual room without interpreting a room preference", async () => {
    const room = await readExportPreviewWithClient(prisma, { actor, selection: { ...selection, room: "SALA_1" }, maximumReservations: 2000 });
    expect(room.reservations.map(row => row.id)).toEqual([assignedReservationId]);
    expect(room.reservations[0].preferredRoom).toBe("Sala 2");
    const unassigned = await readExportPreviewWithClient(prisma, { actor, selection: { ...selection, room: "UNASSIGNED" }, maximumReservations: 2000 });
    expect(unassigned.reservations.map(row => row.id)).toContain(clearedReservationId);
    expect(unassigned.reservations.map(row => row.id)).not.toContain(assignedReservationId);
    const lunch = await readExportPreviewWithClient(prisma, { actor, selection: { ...selection, service: "LUNCH" }, maximumReservations: 2000 });
    expect(lunch.reservations).toEqual([]);
    const otherDate = await readExportPreviewWithClient(prisma, { actor, selection: { ...selection, period: { mode: "DAY", date: "2026-08-25" } }, maximumReservations: 2000 });
    expect(otherDate.reservations).toEqual([]);
  });
  it("keeps legacy options independent of the current room filter and preserves room-only and authoritative composition", async () => {
    const legacyId = randomUUID(), roomOnlyId = randomUUID();
    await prisma.reservation.createMany({ data: [
      { ...reservationData({ id: legacyId, lastName: "Legacy Galleria" }), childrenCount: 1, gameRoomPreference: true },
      { ...reservationData({ id: roomOnlyId, lastName: "Room only adults" }), childrenCount: 0, gameRoomPreference: null },
    ] });
    await prisma.reservationAssignment.createMany({ data: [
      { restaurantId, reservationId: legacyId, roomId: roomIds.get("galleria")!, assignedByUserId: staffId, updatedByUserId: staffId },
      { restaurantId, reservationId: roomOnlyId, roomId: roomIds.get("sala-2")!, assignedByUserId: staffId, updatedByUserId: staffId },
    ] });
    try {
      const single = await readExportPreviewWithClient(prisma, { actor, selection: { ...selection, room: "SALA_1" }, maximumReservations: 2000 });
      expect(single.availableLegacyRooms).toContain("GALLERIA"); expect(single.reservations).toHaveLength(1);
      const legacySelection = { ...selection, room: "GALLERIA" as const };
      const legacy = buildExportPreview({ selection: legacySelection, snapshot: await readExportPreviewWithClient(prisma, { actor, selection: legacySelection, maximumReservations: 2000 }), readAt: new Date() });
      expect(legacy.groups[0]).toMatchObject({ key: "GALLERIA", legacy: true, summary: { reservationCount: 1 } });
      expect(legacy.groups[0].rows[0]).toMatchObject({ childrenCount: 1, adultsCount: 1, gameRoomPreference: true, assignmentState: "ROOM_ONLY" });
      const roomSelection = { ...selection, room: "SALA_2" as const };
      const adults = buildExportPreview({ selection: roomSelection, snapshot: await readExportPreviewWithClient(prisma, { actor, selection: roomSelection, maximumReservations: 2000 }), readAt: new Date() });
      expect(adults.groups[0].rows[0]).toMatchObject({ childrenCount: 0, adultsCount: 2, gameRoomPreference: null, assignmentState: "ROOM_ONLY" });
    } finally {
      await prisma.reservationAssignment.deleteMany({ where: { reservationId: { in: [legacyId, roomOnlyId] } } });
      await prisma.reservation.deleteMany({ where: { id: { in: [legacyId, roomOnlyId] } } });
    }
  });
  it("rejects cap+1 rows after the selection filters and leaves business data unchanged", async () => {
    const before = await businessFingerprint();
    await expect(readExportPreviewWithClient(prisma, { actor, selection, maximumReservations: 1 })).rejects.toBeInstanceOf(ExportSnapshotTooLargeError);
    await expect(readExportPreviewWithClient(prisma, { actor, selection: { ...selection, room: "SALA_1" }, maximumReservations: 1 })).resolves.toMatchObject({ reservations: [{ id: assignedReservationId }] });
    expect(await businessFingerprint()).toBe(before);
  });
  it("keeps a RepeatableRead preview coherent, while a subsequent read sees the concurrent update", async () => {
    const current = await prisma.reservation.findUniqueOrThrow({ where: { id: concurrentReservationId }, select: { notes: true } });
    const other = new PrismaClient({ adapter: new PrismaPg({ connectionString: resolveDatabaseUrl(process.env.DATABASE_URL) }) });
    try {
      const snapshot = await readExportPreviewWithClient(prisma, { actor, selection, maximumReservations: 2000 }, {
        afterContextRead: async () => { await other.reservation.update({ where: { id: concurrentReservationId }, data: { notes: "T09_AFTER_SNAPSHOT" } }); },
      });
      expect(snapshot.reservations.find(row => row.id === concurrentReservationId)?.notes).toBe(current.notes);
      const next = await readExportPreviewWithClient(prisma, { actor, selection, maximumReservations: 2000 });
      expect(next.reservations.find(row => row.id === concurrentReservationId)?.notes).toBe("T09_AFTER_SNAPSHOT");
    } finally {
      await other.$disconnect();
      await prisma.reservation.update({ where: { id: concurrentReservationId }, data: { notes: current.notes } });
    }
  });
  it("rejects disabled, password-change and tenant-mismatched actors", async () => {
    for (const denied of [disabledStaffId, mustChangeStaffId, otherStaffId]) await expect(
      readExportPreviewWithClient(prisma, { actor: { id: denied, restaurantId }, selection, maximumReservations: 2000 }),
    ).rejects.toBeInstanceOf(ExportActorUnavailableError);
  });
  it("fails closed for an actual noncanonical room instead of moving it to UNASSIGNED", async () => {
    const roomId = randomUUID(), id = randomUUID();
    await prisma.room.create({ data: { id: roomId, restaurantId, code: "t09-noncanonical", name: "Artificial unknown" } });
    await prisma.reservation.create({ data: reservationData({ id, lastName: "Invalid assignment" }) });
    await prisma.reservationAssignment.create({ data: { restaurantId, reservationId: id, roomId, assignedByUserId: staffId, updatedByUserId: staffId } });
    try {
      const snapshot = await readExportPreviewWithClient(prisma, { actor, selection, maximumReservations: 2000 });
      expect(() => buildExportPreview({ selection, snapshot, readAt: new Date() })).toThrow(ExportPreviewDataError);
    } finally {
      await prisma.reservationAssignment.deleteMany({ where: { reservationId: id } });
      await prisma.reservation.delete({ where: { id } }); await prisma.room.delete({ where: { id: roomId } });
    }
  });
});
