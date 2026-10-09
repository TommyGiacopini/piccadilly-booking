import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { projectAuditDetail } from "@/modules/audit/domain/audit-projection";

describe("M10-A reservation assignment audit projection", () => {
  it.each((["ASSIGNED", "REASSIGNED", "UNASSIGNED"] as const).flatMap((action) => [false, true].map((roomOnly) => ({ action, roomOnly }))))(
    "allow-lists and safely projects $action (room-only=$roomOnly)",
    ({ action, roomOnly }) => {
      const first = randomUUID();
      const second = randomUUID();
      const detail = projectAuditDetail({
        source: "RESERVATION",
        sourceRank: 1,
        eventId: randomUUID(),
        occurredAt: new Date("2099-01-01T00:00:00.000Z"),
        category: "RESERVATION",
        action,
        outcome: "SUCCESS",
        actorKind: "USER",
        actorUserId: randomUUID(),
        actorDisplayName: "staff.fittizio",
        actorRole: "STAFF",
        entityType: "RESERVATION",
        entityId: randomUUID(),
        correlationId: randomUUID(),
        previousState: {
          assignment:
            action === "ASSIGNED"
              ? null
              : {
                  finalRoomCode: "sala-2",
                  tableIds: [first],
                  tableCount: 1,
                  internalNotesPresent: true,
                  internalNotes: "Nota precedente ostile vietata",
                  customerEmail: "private@example.invalid",
                },
        },
        newState: {
          assignment:
            action === "UNASSIGNED"
              ? null
              : {
                  finalRoomCode: "sala-1",
                  tableIds: roomOnly ? [] : [second, first],
                  tableCount: roomOnly ? 0 : 2,
                  internalNotesPresent: true,
                  internalNotes: "Testo fittizio vietato",
                  customerPhone: "+39 000 000 9999",
                },
          ...(action === "UNASSIGNED"
            ? {
                reason: "RESERVATION_SCHEDULE_CHANGED",
                removalExplanation: "Testo editoriale ostile vietato",
              }
            : {}),
        },
        metadata: {
          rawRequest: { authorization: "Bearer fixture-secret" },
          sessionToken: "fixture-session-token",
        },
      });

      expect(detail?.action).toBe(action);
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain("Testo fittizio vietato");
      expect(serialized).not.toContain("Nota precedente ostile vietata");
      expect(serialized).not.toContain("+39 000 000 9999");
      expect(serialized).not.toContain("private@example.invalid");
      expect(serialized).not.toContain("fixture-secret");
      expect(serialized).not.toContain("fixture-session-token");
      expect(serialized).not.toContain("Testo editoriale ostile vietato");
      if (action !== "UNASSIGNED") {
        expect(detail?.newState).toContainEqual({ key: "assignment.tableIds", label: "ID tavoli", value: roomOnly ? "" : [first, second].sort().join(", ") });
        expect(detail?.newState).toContainEqual({ key: "assignment.tableCount", label: "Numero tavoli", value: roomOnly ? 0 : 2 });
        expect(detail?.newState.map((field) => field.key)).toEqual([
          "assignment.finalRoomCode",
          "assignment.tableIds",
          "assignment.tableCount",
          "assignment.internalNotesPresent",
        ]);
      } else {
        expect(detail?.newState).toEqual([
          {
            key: "reason",
            label: "Motivo rimozione",
            value: "RESERVATION_SCHEDULE_CHANGED",
          },
        ]);
      }
      expect(detail?.summary).toBe({ ASSIGNED: "Sala assegnata", REASSIGNED: "Assegnazione sala/tavoli aggiornata", UNASSIGNED: "Assegnazione rimossa" }[action]);
    },
  );
});
