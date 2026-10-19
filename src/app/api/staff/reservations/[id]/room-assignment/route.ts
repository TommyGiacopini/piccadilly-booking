import { NextResponse } from "next/server";
import { z } from "zod";
import { assignReservationRoom } from "@/modules/rooms/application/reservation-assignment-service";
import { ReservationAssignmentError, reservationAssignmentErrorStatus } from "@/modules/rooms/application/reservation-assignment-errors";
import { readDraftRequestSession, draftSessionBindingError, DRAFT_SESSION_BINDING_HEADER } from "@/server/auth/draft-session-context";
import { passwordChangeRequiredResponse } from "@/server/auth/authorization";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { isSameOriginRequest } from "@/server/auth/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const session = await readDraftRequestSession(request);
    if (!session) return json({ error: "Unauthorized" }, 401);
    const { user, sessionBinding } = session;
    const passwordGuard = passwordChangeRequiredResponse(user);
    if (passwordGuard) return passwordGuard;
    if ((user.role !== "STAFF" && user.role !== "ADMIN") || !isSameOriginRequest(request, resolveAuthConfig().trustProxy)) return json({ error: "Forbidden" }, 403);
    // The new endpoint has no headerless legacy contract.
    if (!request.headers.has(DRAFT_SESSION_BINDING_HEADER)) return json({ code: "DRAFT_SESSION_BINDING_INVALID" }, 400);
    const bindingError = draftSessionBindingError(request, sessionBinding);
    if (bindingError) return json({ code: bindingError.code }, bindingError.status);
    const id = z.uuid().safeParse((await context.params).id);
    if (!id.success) return json({ code: "VALIDATION", error: "Identificativo non valido." }, 400);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return json({ code: "VALIDATION", error: "Content-Type deve essere application/json." }, 400);
    let rawPayload: unknown;
    try { rawPayload = await request.json(); } catch { return json({ code: "VALIDATION", error: "JSON non valido." }, 400); }
    return json(await assignReservationRoom({ actor: { id: user.id, restaurantId: user.restaurantId }, reservationId: id.data, rawPayload }));
  } catch (error) {
    if (error instanceof ReservationAssignmentError) return json({ code: error.code, error: error.publicMessage }, reservationAssignmentErrorStatus(error.code));
    console.error("Room assignment request failed.");
    return json({ error: "Non è stato possibile aggiornare la sala." }, 500);
  }
}
