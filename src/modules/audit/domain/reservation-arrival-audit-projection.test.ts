import { describe, expect, it } from "vitest";

import { projectAuditDetail } from "@/modules/audit/domain/audit-projection";

function record(overrides: Record<string, unknown> = {}) {
  return {
    source: "RESERVATION",
    sourceRank: 1,
    eventId: "00000000-0000-4000-8000-000000000001",
    occurredAt: new Date("2026-09-30T19:42:15.123Z"),
    category: "RESERVATION",
    action: "ARRIVAL_RECORDED",
    outcome: "SUCCESS",
    actorKind: "USER",
    actorUserId: "00000000-0000-4000-8000-000000000002",
    actorDisplayName: "staff.demo",
    actorRole: "STAFF",
    entityType: "RESERVATION",
    entityId: "00000000-0000-4000-8000-000000000003",
    correlationId: "00000000-0000-4000-8000-000000000004",
    previousState: { arrival: { recorded: false, arrivedAt: null } },
    newState: {
      arrival: {
        recorded: true,
        arrivedAt: "2026-09-30T19:42:15.123Z",
      },
    },
    metadata: null,
    ...overrides,
  };
}

describe("T03 arrival audit projection", () => {
  it("projects the two arrival actions with fixed labels and minimized fields", () => {
    const recorded = projectAuditDetail(record());
    const reverted = projectAuditDetail(
      record({
        action: "ARRIVAL_REVERTED",
        previousState: record().newState,
        newState: record().previousState,
      }),
    );

    expect(recorded).toMatchObject({
      summary: "Arrivo registrato",
      previousState: [
        { key: "arrival.recorded", value: false },
      ],
      newState: [
        { key: "arrival.recorded", value: true },
        {
          key: "arrival.arrivedAt",
          value: "2026-09-30T19:42:15.123Z",
        },
      ],
      metadata: [],
    });
    expect(reverted?.summary).toBe("Arrivo annullato");
  });

  it.each([
    { arrival: { recorded: true, arrivedAt: null } },
    { arrival: { recorded: false, arrivedAt: "2026-09-30T19:42:15.123Z" } },
    { arrival: { recorded: true, arrivedAt: "not-a-date" } },
    { arrival: { recorded: false, arrivedAt: null, phone: "+390000000" } },
    { arrival: { recorded: false } },
  ])("rejects malformed or expanded arrival snapshots %#", (state) => {
    expect(projectAuditDetail(record({ previousState: state }))).toBeNull();
  });
});
