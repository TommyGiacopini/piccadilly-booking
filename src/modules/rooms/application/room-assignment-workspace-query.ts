import "server-only";
import { workspaceQuerySchema } from "@/modules/rooms/domain/room-assignment-workspace";
import { readRoomAssignmentWorkspace } from "@/modules/rooms/infrastructure/room-assignment-workspace-repository";
import { ReservationAssignmentError } from "./reservation-assignment-errors";

export async function getRoomAssignmentWorkspace(input: {
  actor: { id: string; restaurantId: string }; rawQuery: unknown; now?: Date;
}) {
  const query = workspaceQuerySchema.safeParse(input.rawQuery);
  if (!query.success) throw new ReservationAssignmentError("VALIDATION", "Data, servizio, sala o ordinamento non validi.");
  return readRoomAssignmentWorkspace({ actor: input.actor, query: query.data, now: input.now ?? new Date() });
}
