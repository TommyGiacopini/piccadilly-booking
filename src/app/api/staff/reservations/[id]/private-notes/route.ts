import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getReservationPrivateNotes, putReservationPrivateNotes,
  ReservationPrivateNotesError, privateNotesErrorStatus,
} from "@/modules/reservations/application/reservation-private-notes-service";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { getRequestUser, passwordChangeRequiredResponse } from "@/server/auth/authorization";
import { isSameOriginRequest } from "@/server/auth/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
interface Context { params: Promise<{ id: string }> }
function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store, max-age=0" } });
}
async function handle(request: Request, context: Context, mutation: boolean): Promise<Response> {
  const user = await getRequestUser(request);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return passwordGuard;
  if (user.role !== "STAFF" && user.role !== "ADMIN") return json({ error: "Forbidden" }, 403);
  if (mutation && !isSameOriginRequest(request, resolveAuthConfig().trustProxy)) return json({ error: "Forbidden" }, 403);
  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return json({ error: "Identificativo non valido." }, 400);
  const input = { actor: { id: user.id, restaurantId: user.restaurantId }, reservationId: id.data };
  try {
    if (!mutation) return json(await getReservationPrivateNotes(input));
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return json({ error: "Content-Type deve essere application/json.", code: "VALIDATION" }, 400);
    }
    let rawPayload: unknown;
    try { rawPayload = await request.json(); } catch {
      return json({ error: "Il corpo JSON non è valido.", code: "VALIDATION" }, 400);
    }
    return json(await putReservationPrivateNotes({ ...input, rawPayload }));
  } catch (error) {
    if (error instanceof ReservationPrivateNotesError) return json({ error: error.publicMessage, code: error.code }, privateNotesErrorStatus(error.code));
    console.error("Reservation private notes request failed.");
    return json({ error: "Non è stato possibile gestire la nota interna." }, 500);
  }
}
export async function GET(request: Request, context: Context) { return handle(request, context, false); }
export async function PUT(request: Request, context: Context) { return handle(request, context, true); }
