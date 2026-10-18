import { NextResponse } from "next/server";

import {
  ReservationApplicationError,
  reservationErrorStatus,
} from "@/modules/reservations/application/reservation-errors";
import { createPhoneReservation } from "@/modules/reservations/application/staff-reservation-service";
import {
  passwordChangeRequiredResponse,
} from "@/server/auth/authorization";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { isSameOriginRequest } from "@/server/auth/request-security";
import { readDraftRequestSession, draftSessionBindingError } from "@/server/auth/draft-session-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function POST(request: Request): Promise<Response> {
  let session;
  try { session = await readDraftRequestSession(request); }
  catch { return noStoreJson({ error: "Internal error" }, 500); }
  const user = session?.user;

  if (!user) {
    return noStoreJson({ error: "Unauthorized" }, 401);
  }
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return passwordGuard;

  const authConfig = resolveAuthConfig();

  if (!isSameOriginRequest(request, authConfig.trustProxy)) {
    return noStoreJson({ error: "Forbidden" }, 403);
  }

  const bindingError = draftSessionBindingError(request, session!.sessionBinding);
  if (bindingError) return noStoreJson({ code: bindingError.code }, bindingError.status);

  const contentType =
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";

  if (contentType !== "application/json") {
    return noStoreJson({ error: "Content-Type deve essere application/json." }, 400);
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return noStoreJson({ error: "Il corpo JSON non è valido." }, 400);
  }

  try {
    const result = await createPhoneReservation({
      actor: {
        id: user.id,
        restaurantId: user.restaurantId,
        role: user.role,
      },
      rawPayload: payload,
      rawIdempotencyKey: request.headers.get("idempotency-key"),
    });

    return noStoreJson(
      { reservation: result.reservation, replayed: result.replayed },
      result.replayed ? 200 : 201,
    );
  } catch (error) {
    if (error instanceof ReservationApplicationError) {
      return noStoreJson(
        { error: error.publicMessage },
        reservationErrorStatus(error.code),
      );
    }

    console.error("Staff reservation creation failed.");
    return noStoreJson(
      { error: "Non è stato possibile creare la prenotazione." },
      500,
    );
  }
}
