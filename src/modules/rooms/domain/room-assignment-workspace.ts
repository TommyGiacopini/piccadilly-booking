import { z } from "zod";
import { isLocalDate } from "@/modules/configuration/domain/operational-time";

export const roomAssignmentCommandSchema = z.strictObject({
  version: z.number().int().positive(),
  roomId: z.uuid().transform(value => value.toLowerCase()),
  expectedLocalDate: z.string().refine(isLocalDate),
  expectedServiceType: z.enum(["LUNCH", "DINNER"]),
});
export type RoomAssignmentCommand = z.infer<typeof roomAssignmentCommandSchema>;
export const workspaceQuerySchema = z.strictObject({
  date: z.string().refine(isLocalDate),
  service: z.enum(["LUNCH", "DINNER"]),
  room: z.enum(["ALL", "sala-1", "sala-2", "sala-3", "galleria", "terrazzo"]).default("ALL"),
  order: z.enum(["ARRIVAL", "ASSIGNMENT", "CREATION"]).default("ARRIVAL"),
});
export type WorkspaceQuery = z.infer<typeof workspaceQuerySchema>;
export interface WorkspaceRoom {
  id: string; code: string; name: string; isActive: boolean; isAvailable: boolean | null;
  reservations: number; covers: number;
}
export interface WorkspaceReservation {
  id: string; version: number; name: string; arrivalTime: string; partySize: number;
  childrenCount: number | null; children: boolean; createdAt: string;
  roomId: string | null; roomAssignedAt: string | null;
  notesPresent: boolean; privateNotesPresent: boolean; legacyNotesPresent: boolean;
  legacyNotesState: "ACTIVE" | "CLEARED" | null; legacyTableCount: number;
  requirements: string[];
}
export interface RoomAssignmentWorkspace {
  query: WorkspaceQuery; timezone: string; isHistorical: boolean; snapshotAt: string;
  rooms: WorkspaceRoom[]; reservations: WorkspaceReservation[];
}
export interface RoomAssignmentResult {
  changed: boolean; reservationId: string; reservationVersion: number;
  assignment: { id: string; roomId: string; roomCode: string; legacyTableCount: number; legacyNotesPresent: boolean };
}
export interface AssignmentHistoryEvent {
  action: "ASSIGNED" | "REASSIGNED" | "UNASSIGNED";
  createdAt: string; previousState: unknown; newState: unknown;
}
function auditRoom(value: unknown): string | null | undefined {
  if (!value || typeof value !== "object" || !("assignment" in value)) return undefined;
  const assignment = value.assignment;
  if (assignment === null) return null;
  if (!assignment || typeof assignment !== "object" || !("finalRoomCode" in assignment) ||
      typeof assignment.finalRoomCode !== "string" || !assignment.finalRoomCode) return undefined;
  return assignment.finalRoomCode;
}
/** A timestamp is returned only when the ordered audit lineage proves it.
 * UUID order, assignment.createdAt and assignment.updatedAt are never fallbacks. */
export function deriveRoomAssignedAt(currentRoomCode: string | null, events: readonly AssignmentHistoryEvent[]): string | null {
  if (!currentRoomCode || !events.length) return null;
  const sorted = [...events].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let room: string | null = null, entered: string | null = null;
  for (let index = 0; index < sorted.length; index++) {
    const event = sorted[index], before = auditRoom(event.previousState), after = auditRoom(event.newState);
    if (!Number.isFinite(Date.parse(event.createdAt)) || before === undefined || after === undefined || before !== room) return null;
    // Equal-time state transitions cannot be ordered by random audit IDs.
    if (index > 0 && sorted[index - 1].createdAt === event.createdAt &&
        (before !== after || auditRoom(sorted[index - 1].previousState) !== auditRoom(sorted[index - 1].newState))) return null;
    if (event.action === "ASSIGNED") {
      if (before !== null || after === null) return null;
      entered = event.createdAt;
    } else if (event.action === "UNASSIGNED") {
      if (before === null || after !== null) return null;
      entered = null;
    } else {
      if (before === null || after === null) return null;
      if (before !== after) entered = event.createdAt;
    }
    room = after;
  }
  return room === currentRoomCode ? entered : null;
}
export function orderWorkspaceReservations(rows: readonly WorkspaceReservation[], order: WorkspaceQuery["order"]): WorkspaceReservation[] {
  return [...rows].sort((a, b) => {
    const primary = order === "ASSIGNMENT"
      ? a.roomAssignedAt === null ? (b.roomAssignedAt === null ? 0 : 1) : b.roomAssignedAt === null ? -1 : a.roomAssignedAt.localeCompare(b.roomAssignedAt)
      : order === "CREATION" ? a.createdAt.localeCompare(b.createdAt) : a.arrivalTime.localeCompare(b.arrivalTime);
    return primary || a.arrivalTime.localeCompare(b.arrivalTime) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}
