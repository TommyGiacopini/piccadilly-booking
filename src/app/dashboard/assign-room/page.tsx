import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { readDraftRequestSession } from "@/server/auth/draft-session-context";
import { getStaffReservationFormContext } from "@/modules/dashboard/application/dashboard-query";
import { getRoomAssignmentWorkspace } from "@/modules/rooms/application/room-assignment-workspace-query";
import { RoomAssignmentWorkspace } from "./room-assignment-workspace";
import { ReservationAssignmentError } from "@/modules/rooms/application/reservation-assignment-errors";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export default async function AssignRoomPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // No fetch: adapt the headers of this SSR request to the canonical resolver.
  const session = await readDraftRequestSession(new Request("http://staff.internal/dashboard/assign-room", { headers: new Headers(await headers()) }));
  if (!session || (session.user.role !== "STAFF" && session.user.role !== "ADMIN")) redirect("/login?returnTo=%2Fdashboard%2Fassign-room");
  if (session.user.mustChangePassword) redirect("/cambia-password");
  const { user, sessionBinding } = session, query = await searchParams;
  const context = await getStaffReservationFormContext({ restaurantId: user.restaurantId });
  const rawQuery = { date: query.date ?? context.localDate, service: query.service ?? "DINNER", room: query.room ?? "ALL", order: query.order ?? "ARRIVAL" };
  let data;
  try { data = await getRoomAssignmentWorkspace({ actor: { id: user.id, restaurantId: user.restaurantId }, rawQuery }); }
  catch (error) {
    if (error instanceof ReservationAssignmentError && error.code === "VALIDATION") return <main className="p-6"><h1 className="text-2xl font-semibold">ASSEGNA SALA</h1><p role="alert">Parametri di consultazione non validi.</p><a className="inline-flex min-h-11 items-center underline" href="/dashboard/assign-room">Riapri workspace</a></main>;
    throw error;
  }
  return <main className="mx-auto min-w-0 max-w-7xl px-3 py-6 sm:px-6"><RoomAssignmentWorkspace data={data}
    owner={{ actorId: user.id, tenantId: user.restaurantId, sessionBinding, role: user.role }} /></main>;
}
