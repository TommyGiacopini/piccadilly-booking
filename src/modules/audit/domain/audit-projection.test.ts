import { describe, expect, it } from "vitest";

import {
  projectAuditDetail,
  projectAuditListRow,
  type AuditDetailDatabaseRecord,
  type AuditListDatabaseRow,
} from "@/modules/audit/domain/audit-projection";

const ids = {
  event: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  entity: "10000000-0000-4000-8000-000000000003",
  correlation: "10000000-0000-4000-8000-000000000004",
};

function reservationRow(overrides: Partial<AuditListDatabaseRow> = {}): AuditListDatabaseRow {
  return {
    source: "RESERVATION",
    sourceRank: 1,
    eventId: ids.event,
    occurredAt: new Date("2026-08-13T10:00:00.000Z"),
    category: "RESERVATION",
    action: "UPDATED",
    outcome: "SUCCESS",
    actorKind: "PUBLIC",
    actorUserId: null,
    actorDisplayName: null,
    actorRole: null,
    entityType: "RESERVATION",
    entityId: ids.entity,
    correlationId: ids.correlation,
    ...overrides,
  };
}

describe("audit list projection", () => {
  it("normalizes reservation headers, public actor, entity and outcome", () => {
    expect(projectAuditListRow(reservationRow())).toEqual({
      source: "RESERVATION",
      eventId: ids.event,
      occurredAt: "2026-08-13T10:00:00.000Z",
      category: "RESERVATION",
      action: "UPDATED",
      outcome: "SUCCESS",
      actorKind: "PUBLIC",
      entityType: "RESERVATION",
      entityId: ids.entity,
      correlationId: ids.correlation,
      summary: "Prenotazione aggiornata",
    });
  });

  it.each([
    ["ANONYMOUS", "AUTHENTICATION", "LOGIN_FAILED"],
    ["SYSTEM", "CONFIGURATION", "ROOM_UPDATED"],
  ])("normalizes an administrative %s actor", (actorKind, category, action) => {
    expect(
      projectAuditListRow(
        reservationRow({
          source: "ADMINISTRATIVE",
          sourceRank: 2,
          category,
          action,
          actorKind,
          entityType: action === "ROOM_UPDATED" ? "ROOM" : null,
          entityId: action === "ROOM_UPDATED" ? ids.entity : null,
        }),
      )?.actorKind,
    ).toBe(actorKind);
  });

  it("uses a same-tenant username or a neutral fallback for authenticated actors", () => {
    expect(
      projectAuditListRow(
        reservationRow({
          actorKind: "USER",
          actorUserId: ids.actor,
          actorDisplayName: null,
          actorRole: "ADMIN",
        }),
      ),
    ).toMatchObject({ actorDisplayName: "Utente non disponibile", actorRole: "ADMIN" });
  });
});

describe("positive detail allow-list", () => {
  it("keeps only approved reservation flags from hostile nested legacy JSON", () => {
    const sentinel = "M9F-SENSITIVE-SENTINEL";
    const state = {
      localDate: "2026-08-13",
      serviceType: "DINNER",
      arrivalTime: "20:00",
      partySize: 4,
      status: "CONFIRMED",
      origin: "PUBLIC",
      version: 2,
      customerFirstName: sentinel,
      customerLastName: sentinel,
      phone: sentinel,
      email: sentinel,
      password: sentinel,
      hash: sentinel,
      token: sentinel,
      sessionSecret: sentinel,
      ip: sentinel,
      allergies: sentinel,
      intolerances: sentinel,
      notes: sentinel,
      recurrence: sentinel,
      contacts: [sentinel],
      deep: { nested: { value: sentinel } },
      requests: {
        roomCode: "sala-1",
        highChair: true,
        allergiesPresent: true,
        noteText: sentinel,
        arbitrary: [sentinel],
      },
      capacityOverride: false,
      capacityOverrideReason: sentinel,
    };
    const detail = projectAuditDetail({
      ...reservationRow(),
      previousState: state,
      newState: { ...state, partySize: 5 },
      metadata: { tokenHash: sentinel },
    });
    const serialized = JSON.stringify(detail);
    expect(detail?.newState).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "partySize", value: 5 }),
      expect.objectContaining({ key: "requests.allergiesPresent", value: true }),
    ]));
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("customerFirstName");
    expect(serialized).not.toContain("capacityOverrideReason");
  });

  it("does not expose authentication HMAC or arbitrary metadata", () => {
    const sentinel = "M9F-HMAC-SENTINEL";
    const record: AuditDetailDatabaseRecord = {
      ...reservationRow({
        source: "ADMINISTRATIVE",
        sourceRank: 2,
        category: "AUTHENTICATION",
        action: "LOGIN_FAILED",
        outcome: "FAILURE",
        actorKind: "ANONYMOUS",
        entityType: null,
        entityId: null,
      }),
      previousState: { attemptedUsername: sentinel },
      newState: { ip: sentinel },
      metadata: { credentialFingerprint: sentinel, userAgent: sentinel },
    };
    expect(JSON.stringify(projectAuditDetail(record))).not.toContain(sentinel);
    expect(projectAuditDetail(record)).toMatchObject({
      previousState: [],
      newState: [],
      metadata: [],
    });
  });

  it("shows identity flags and public-content keys but never text or contacts", () => {
    const sentinel = "M9F-CONTENT-SENTINEL";
    const identity = projectAuditDetail({
      ...reservationRow({
        source: "ADMINISTRATIVE",
        sourceRank: 2,
        category: "IDENTITY",
        action: "USER_DISABLED",
        actorKind: "USER",
        actorUserId: ids.actor,
        actorDisplayName: "demo.admin",
        actorRole: "ADMIN",
        entityType: "USER",
      }),
      previousState: { role: "STAFF", isActive: true, username: sentinel },
      newState: { role: "STAFF", isActive: false, passwordHash: sentinel },
      metadata: { revokedSessionCount: 3, flowType: "ADMIN_DISABLE", secret: sentinel },
    });
    expect(identity?.metadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "revokedSessionCount", value: 3 }),
    ]));
    expect(JSON.stringify(identity)).not.toContain(sentinel);

    const content = projectAuditDetail({
      ...reservationRow({
        source: "ADMINISTRATIVE",
        sourceRank: 2,
        category: "CONFIGURATION",
        action: "PUBLIC_CONTENT_UPDATED",
        actorKind: "USER",
        actorUserId: ids.actor,
        actorDisplayName: "demo.admin",
        actorRole: "ADMIN",
        entityType: "Restaurant",
      }),
      previousState: { complete: true, locales: ["IT", "EN"], keys: ["BOOKING_PAGE_TITLE"], contentText: sentinel },
      newState: { complete: true, locales: ["IT", "EN"], keys: ["BOOKING_PAGE_TITLE"], publicPhone: sentinel },
      metadata: { changed: [{ locale: "IT", keys: ["BOOKING_PAGE_TITLE"] }], text: sentinel },
    });
    expect(content?.newState).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "complete", value: true }),
    ]));
    expect(JSON.stringify(content)).not.toContain(sentinel);
  });
});
