import "dotenv/config";

import { describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import {
  getAuditEventDetail,
  listAuditEvents,
} from "@/modules/audit/application/audit-query-service";
import { AuditQueryError } from "@/modules/audit/domain/audit-query";
import { prisma } from "@/server/db/prisma";

const ids = {
  restaurant: "91000000-0000-4000-8000-000000000001",
  otherRestaurant: "91000000-0000-4000-8000-000000000002",
  admin: "91000000-0000-4000-8000-000000000003",
  staff: "91000000-0000-4000-8000-000000000004",
  mustChange: "91000000-0000-4000-8000-000000000005",
  disabled: "91000000-0000-4000-8000-000000000006",
  otherAdmin: "91000000-0000-4000-8000-000000000007",
  reservation: "91000000-0000-4000-8000-000000000008",
  reservationEventNewest: "91000000-0000-4000-8000-000000000009",
  reservationEventOlder: "91000000-0000-4000-8000-000000000010",
  administrativeEventNewest: "91000000-0000-4000-8000-000000000011",
  administrativeEventOlder: "91000000-0000-4000-8000-000000000012",
  anonymousEvent: "91000000-0000-4000-8000-000000000013",
  systemEvent: "91000000-0000-4000-8000-000000000014",
  otherEvent: "91000000-0000-4000-8000-000000000015",
  correlationReservation: "92000000-0000-4000-8000-000000000001",
  correlationAdministrative: "92000000-0000-4000-8000-000000000002",
  correlationAnonymous: "92000000-0000-4000-8000-000000000003",
  correlationSystem: "92000000-0000-4000-8000-000000000004",
  correlationOther: "92000000-0000-4000-8000-000000000005",
};

const actor = { id: ids.admin, restaurantId: ids.restaurant };
const now = new Date("2026-08-13T20:00:00.000Z");
const sentinel = "M9F-PRIVATE-SENTINEL";

class ExpectedRollback extends Error {}

async function createFixture(client: Prisma.TransactionClient) {
  await client.restaurant.createMany({
    data: [
      { id: ids.restaurant, name: "M9-F Audit Demo", timezone: "Europe/Rome" },
      { id: ids.otherRestaurant, name: "M9-F Isolated Demo", timezone: "Europe/Rome" },
    ],
  });
  await client.user.createMany({
    data: [
      { id: ids.admin, restaurantId: ids.restaurant, username: "m9f.admin", passwordHash: "M9-F-fake-hash", role: "ADMIN" },
      { id: ids.staff, restaurantId: ids.restaurant, username: "m9f.staff", passwordHash: "M9-F-fake-hash", role: "STAFF" },
      { id: ids.mustChange, restaurantId: ids.restaurant, username: "m9f.must-change", passwordHash: "M9-F-fake-hash", role: "ADMIN", mustChangePassword: true },
      { id: ids.disabled, restaurantId: ids.restaurant, username: "m9f.disabled", passwordHash: "M9-F-fake-hash", role: "ADMIN", isActive: false, disabledAt: now },
      { id: ids.otherAdmin, restaurantId: ids.otherRestaurant, username: "m9f.other-admin", passwordHash: "M9-F-fake-hash", role: "ADMIN" },
    ],
  });
  await client.reservation.create({
    data: {
      id: ids.reservation,
      restaurantId: ids.restaurant,
      localDate: new Date("2026-08-14T00:00:00.000Z"),
      serviceType: "DINNER",
      arrivalTime: new Date("1970-01-01T20:00:00.000Z"),
      partySize: 4,
      origin: "PUBLIC",
      customerFirstName: "Cliente",
      customerLastName: "Fittizio",
      customerPhone: "+390000000000",
      privacyPolicyVersion: "m9f-demo",
      privacyConsentAt: now,
      privacyConsentMethod: "WEB_CHECKBOX",
      termsPolicyVersion: "m9f-demo",
      termsConsentAt: now,
      termsConsentMethod: "WEB_CHECKBOX",
      consentLanguage: "it",
    },
  });
  const reservationState = {
    localDate: "2026-08-14",
    serviceType: "DINNER",
    arrivalTime: "20:00",
    partySize: 4,
    status: "CONFIRMED",
    origin: "PUBLIC",
    version: 1,
    requests: {
      roomCode: "sala-1",
      highChair: false,
      allergiesPresent: false,
      hiddenNotes: sentinel,
    },
    customerFirstName: sentinel,
    tokenHash: sentinel,
  };
  await client.reservationAuditEvent.createMany({
    data: [
      {
        id: ids.reservationEventNewest,
        restaurantId: ids.restaurant,
        reservationId: ids.reservation,
        action: "UPDATED",
        actorOrigin: "PUBLIC",
        correlationId: ids.correlationReservation,
        previousState: reservationState,
        newState: { ...reservationState, partySize: 5 },
        createdAt: new Date("2026-08-13T12:00:00.000Z"),
      },
      {
        id: ids.reservationEventOlder,
        restaurantId: ids.restaurant,
        reservationId: ids.reservation,
        action: "CREATED",
        actorOrigin: "PUBLIC",
        correlationId: "92000000-0000-4000-8000-000000000006",
        newState: reservationState,
        createdAt: new Date("2026-08-13T10:00:00.000Z"),
      },
    ],
  });
  await client.auditEvent.createMany({
    data: [
      {
        id: ids.administrativeEventNewest,
        restaurantId: ids.restaurant,
        category: "CONFIGURATION",
        action: "ROOM_UPDATED",
        outcome: "SUCCESS",
        actorUserId: ids.admin,
        actorRole: "ADMIN",
        entityType: "ROOM",
        entityId: ids.restaurant,
        correlationId: ids.correlationAdministrative,
        previousState: { code: "sala-1", displayOrder: 1, isActive: true, notes: sentinel },
        newState: { code: "sala-1", displayOrder: 2, isActive: true, publicEmail: sentinel },
        metadata: { reservationCount: 2, covers: 7, secret: sentinel },
        createdAt: new Date("2026-08-13T12:00:00.000Z"),
      },
      {
        id: ids.administrativeEventOlder,
        restaurantId: ids.restaurant,
        category: "IDENTITY",
        action: "USER_ROLE_CHANGED",
        outcome: "SUCCESS",
        actorUserId: ids.admin,
        actorRole: "ADMIN",
        entityType: "USER",
        entityId: ids.staff,
        correlationId: "92000000-0000-4000-8000-000000000007",
        previousState: { role: "STAFF", isActive: true },
        newState: { role: "ADMIN", isActive: true },
        metadata: { revokedSessionCount: 1, flowType: "ADMIN_ROLE_CHANGE" },
        createdAt: new Date("2026-08-13T11:00:00.000Z"),
      },
      {
        id: ids.anonymousEvent,
        restaurantId: ids.restaurant,
        category: "AUTHENTICATION",
        action: "LOGIN_FAILED",
        outcome: "FAILURE",
        correlationId: ids.correlationAnonymous,
        metadata: { credentialFingerprint: sentinel, ip: sentinel },
        createdAt: new Date("2026-08-13T09:00:00.000Z"),
      },
      {
        id: ids.systemEvent,
        restaurantId: ids.restaurant,
        category: "CONFIGURATION",
        action: "ROOM_UPDATED",
        outcome: "SUCCESS",
        entityType: "ROOM",
        entityId: ids.restaurant,
        correlationId: ids.correlationSystem,
        newState: { code: "sala-2", displayOrder: 2, isActive: true },
        createdAt: new Date("2026-08-13T08:00:00.000Z"),
      },
      {
        id: ids.otherEvent,
        restaurantId: ids.otherRestaurant,
        category: "IDENTITY",
        action: "USER_CREATED",
        outcome: "SUCCESS",
        actorUserId: ids.otherAdmin,
        actorRole: "ADMIN",
        entityType: "USER",
        entityId: ids.otherAdmin,
        correlationId: ids.correlationOther,
        newState: { role: "ADMIN", isActive: true },
        createdAt: new Date("2026-08-13T13:00:00.000Z"),
      },
    ],
  });
}

async function withFixture(run: (client: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(async (client) => {
      await createFixture(client);
      await run(client);
      throw new ExpectedRollback();
    });
  } catch (error) {
    if (!(error instanceof ExpectedRollback)) throw error;
  }
}

function query(values: Record<string, string | number>) {
  return new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  );
}

describe.sequential("M9-F unified audit with real PostgreSQL", () => {
  it("globally orders and keyset-pages both sources without duplicates or omissions", async () => {
    await withFixture(async (client) => {
      const options = { client, now };
      const all = await listAuditEvents(actor, query({ limit: 100 }), options);
      expect(all.items).toHaveLength(5);
      expect(all.items.map((item) => item.eventId)).toEqual([
        ids.administrativeEventNewest,
        ids.reservationEventNewest,
        ids.administrativeEventOlder,
        ids.reservationEventOlder,
        ids.anonymousEvent,
      ]);
      expect(all.items.map((item) => item.source)).toContain("RESERVATION");
      expect(all.items.map((item) => item.source)).toContain("ADMINISTRATIVE");
      expect(JSON.stringify(all)).not.toContain(ids.otherEvent);

      const first = await listAuditEvents(actor, query({ limit: 2 }), options);
      expect(first.nextCursor).not.toBeNull();
      await client.auditEvent.create({
        data: {
          id: "91000000-0000-4000-8000-000000000016",
          restaurantId: ids.restaurant,
          category: "CONFIGURATION",
          action: "ROOM_UPDATED",
          outcome: "SUCCESS",
          entityType: "ROOM",
          entityId: ids.restaurant,
          correlationId: "92000000-0000-4000-8000-000000000008",
          newState: { code: "sala-3", displayOrder: 3, isActive: true },
          createdAt: new Date("2026-08-13T13:30:00.000Z"),
        },
      });
      const collected = [...first.items];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await listAuditEvents(actor, query({ limit: 2, cursor }), options);
        collected.push(...page.items);
        cursor = page.nextCursor;
      }
      expect(collected.map((item) => item.eventId)).toEqual(all.items.map((item) => item.eventId));
      expect(new Set(collected.map((item) => item.eventId)).size).toBe(collected.length);
    });
  });

  it("applies every allow-listed filter in PostgreSQL and validates tenant-owned actors", async () => {
    await withFixture(async (client) => {
      const options = { client, now };
      const cases: Array<[Record<string, string>, string[]]> = [
        [{ source: "RESERVATION" }, [ids.reservationEventNewest, ids.reservationEventOlder]],
        [{ category: "IDENTITY" }, [ids.administrativeEventOlder]],
        [{ action: "LOGIN_FAILED" }, [ids.anonymousEvent]],
        [{ outcome: "FAILURE" }, [ids.anonymousEvent]],
        [{ actor: ids.admin }, [ids.administrativeEventNewest, ids.administrativeEventOlder]],
        [{ actor: "PUBLIC" }, [ids.reservationEventNewest, ids.reservationEventOlder]],
        [{ actor: "ANONYMOUS" }, [ids.anonymousEvent]],
        [{ actor: "SYSTEM" }, []],
        [{ entityType: "RESERVATION" }, [ids.reservationEventNewest, ids.reservationEventOlder]],
        [{ entityId: ids.staff }, [ids.administrativeEventOlder]],
        [{ correlationId: ids.correlationAdministrative }, [ids.administrativeEventNewest]],
        [{ source: "ADMINISTRATIVE", category: "CONFIGURATION", actor: ids.admin }, [ids.administrativeEventNewest]],
      ];
      for (const [filters, expected] of cases) {
        const result = await listAuditEvents(actor, query({ ...filters, limit: "100" }), options);
        expect(result.items.map((item) => item.eventId)).toEqual(expected);
      }
      const localPeriod = await listAuditEvents(
        actor,
        query({ from: "2026-08-13", to: "2026-08-13", limit: 100 }),
        options,
      );
      expect(localPeriod.items).toHaveLength(5);
      await expect(
        listAuditEvents(actor, query({ actor: ids.otherAdmin }), options),
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });
      await expect(
        listAuditEvents(actor, query({ restaurantId: ids.otherRestaurant }), options),
      ).rejects.toBeInstanceOf(AuditQueryError);
    });
  });

  it("returns minimized details, blocks other tenants and leaves all tables unchanged", async () => {
    await withFixture(async (client) => {
      const options = { client, now };
      const before = await Promise.all([
        client.auditEvent.count(),
        client.reservationAuditEvent.count(),
        client.user.count(),
        client.reservation.count(),
        client.$queryRaw<Array<{ fingerprint: string }>>`
          SELECT md5(string_agg(id::text || created_at::text, ',' ORDER BY id)) AS fingerprint
          FROM audit_events
        `,
      ]);
      const list = await listAuditEvents(actor, query({ limit: 2 }), options);
      expect(list.nextCursor).not.toBeNull();
      await listAuditEvents(actor, query({ limit: 2, cursor: list.nextCursor! }), options);
      const reservationDetail = await getAuditEventDetail(
        actor,
        "RESERVATION",
        ids.reservationEventNewest,
        options,
      );
      const adminDetail = await getAuditEventDetail(
        actor,
        "ADMINISTRATIVE",
        ids.administrativeEventNewest,
        options,
      );
      const anonymousDetail = await getAuditEventDetail(
        actor,
        "ADMINISTRATIVE",
        ids.anonymousEvent,
        options,
      );
      for (const detail of [reservationDetail, adminDetail, anonymousDetail]) {
        expect(JSON.stringify(detail)).not.toContain(sentinel);
      }
      expect(reservationDetail.newState).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "partySize", value: 5 }),
      ]));
      expect(adminDetail.newState).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "displayOrder", value: 2 }),
      ]));
      expect(anonymousDetail.metadata).toEqual([]);

      await expect(
        getAuditEventDetail(actor, "ADMINISTRATIVE", ids.otherEvent, options),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        getAuditEventDetail(actor, "INVALID", ids.administrativeEventNewest, options),
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });

      const after = await Promise.all([
        client.auditEvent.count(),
        client.reservationAuditEvent.count(),
        client.user.count(),
        client.reservation.count(),
        client.$queryRaw<Array<{ fingerprint: string }>>`
          SELECT md5(string_agg(id::text || created_at::text, ',' ORDER BY id)) AS fingerprint
          FROM audit_events
        `,
      ]);
      expect(after).toEqual(before);
    });
  });

  it("re-reads role, active state, tenant and mandatory-password state", async () => {
    await withFixture(async (client) => {
      const options = { client, now };
      for (const denied of [
        { id: ids.staff, restaurantId: ids.restaurant },
        { id: ids.mustChange, restaurantId: ids.restaurant },
        { id: ids.disabled, restaurantId: ids.restaurant },
        { id: ids.admin, restaurantId: ids.otherRestaurant },
      ]) {
        await expect(listAuditEvents(denied, new URLSearchParams(), options)).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      await expect(listAuditEvents(actor, new URLSearchParams(), options)).resolves.toHaveProperty("items");
    });
  });
});
