import { describe, expect, it } from "vitest";
import { deriveRoomAssignedAt, orderWorkspaceReservations, roomAssignmentCommandSchema, workspaceQuerySchema, type AssignmentHistoryEvent, type WorkspaceReservation } from "./room-assignment-workspace";
const snapshot = (room: string | null) => ({ assignment: room === null ? null : { finalRoomCode: room, tableIds: [], tableCount: 0, internalNotesPresent: false } });
const event = (action: AssignmentHistoryEvent["action"], before: string | null, after: string | null, day: number): AssignmentHistoryEvent => ({ action, previousState: snapshot(before), newState: snapshot(after), createdAt: new Date(Date.UTC(2026, 9, day)).toISOString() });
describe("T06-C room-only contract and audit chronology", () => {
  const command = { version: 1, roomId: "123e4567-e89b-42d3-a456-426614174000", expectedLocalDate: "2026-10-19", expectedServiceType: "DINNER" };
  it("accepts only the explicit room intent", () => { expect(roomAssignmentCommandSchema.safeParse(command).success).toBe(true); });
  it.each(["tableIds", "internalNotes", "privateNotes", "actorId", "tenantId", "commandId"])("rejects extra field %s", field => { expect(roomAssignmentCommandSchema.safeParse({ ...command, [field]: null }).success).toBe(false); });
  it.each([{ version: 0 }, { version: 1.5 }, { roomId: "wrong" }, { expectedLocalDate: "2026-02-30" }, { expectedServiceType: "ALL" }])("rejects malformed intent %#", patch => { expect(roomAssignmentCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false); });
  it("allows only technical workspace query keys", () => { expect(workspaceQuerySchema.safeParse({ date: "2026-10-19", service: "DINNER", q: "personal" }).success).toBe(false); });
  it("uses arrival-independent audit entry, unaffected by same-room note/table changes", () => {
    const first = event("ASSIGNED", null, "sala-1", 1), note = event("REASSIGNED", "sala-1", "sala-1", 2);
    expect(deriveRoomAssignedAt("sala-1", [note, first])).toBe(first.createdAt);
  });
  it("uses the latest return to the current room", () => {
    const back = event("REASSIGNED", "sala-2", "sala-1", 3);
    expect(deriveRoomAssignedAt("sala-1", [event("ASSIGNED", null, "sala-1", 1), event("REASSIGNED", "sala-1", "sala-2", 2), back])).toBe(back.createdAt);
  });
  it("separates clear and reactivation cycles", () => { const again = event("ASSIGNED", null, "sala-1", 3); expect(deriveRoomAssignedAt("sala-1", [event("ASSIGNED", null, "sala-1", 1), event("UNASSIGNED", "sala-1", null, 2), again])).toBe(again.createdAt); });
  it.each([
    [], [event("REASSIGNED", "sala-1", "sala-2", 1)],
    [event("ASSIGNED", null, "sala-2", 1)],
    [event("ASSIGNED", null, "sala-1", 1), event("REASSIGNED", "sala-2", "sala-1", 2)],
    [event("ASSIGNED", null, "sala-1", 1), event("REASSIGNED", "sala-1", "sala-2", 1)],
    [{ ...event("ASSIGNED", null, "sala-1", 1), newState: { injected: "ARTIFICIAL_PRIVATE_MARKER" } }],
    [{ ...event("ASSIGNED", null, "sala-1", 1), createdAt: "invalid" }],
  ].map(events => ({ events })))("returns unknown for missing, incomplete, tied or invalid lineage %#", ({ events }) => { expect(deriveRoomAssignedAt("sala-1", events)).toBeNull(); });
  it("sorts known assignment moments first with deterministic ties and no mutation", () => {
    const row = { arrivalTime: "19:00", createdAt: "2026-01-01", roomAssignedAt: null } as WorkspaceReservation;
    const rows = [{ ...row, id: "b" }, { ...row, id: "a", roomAssignedAt: "2026-10-01" }, { ...row, id: "c", arrivalTime: "18:00" }];
    expect(orderWorkspaceReservations(rows, "ASSIGNMENT").map(r => r.id)).toEqual(["a", "c", "b"]);
    expect(orderWorkspaceReservations(rows, "ARRIVAL").map(r => r.id)).toEqual(["c", "a", "b"]);
    expect(rows.map(r => r.id)).toEqual(["b", "a", "c"]);
  });
});
