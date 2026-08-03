import { NextResponse } from "next/server";

import {
  ReservationApplicationError,
  reservationErrorStatus,
} from "@/modules/reservations/application/reservation-errors";
import { createReservation } from "@/modules/reservations/application/reservation-service";
import { getRequestUser } from "@/server/auth/authorization";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { isSameOriginRequest } from "@/server/auth/request-security";

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
  const user = await getRequestUser(request);

  if (!user) {
    return noStoreJson({ error: "Unauthorized" }, 401);
  }

  const authConfig = resolveAuthConfig();

  if (!isSameOriginRequest(request, authConfig.trustProxy)) {
    return noStoreJson({ error: "Forbidden" }, 403);
  }

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
    const result = await createReservation({
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
