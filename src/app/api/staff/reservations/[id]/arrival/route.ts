import { NextResponse } from "next/server";
import { z } from "zod";

import {
  putReservationArrival,
  ReservationArrivalError,
  reservationArrivalErrorStatus,
} from "@/modules/reservations/application/reservation-arrival-service";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import {
  getRequestUser,
  passwordChangeRequiredResponse,
} from "@/server/auth/authorization";
import { isSameOriginRequest } from "@/server/auth/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface ArrivalRouteContext {
  params: Promise<{ id: string }>;
}

function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

async function strictJson(request: Request): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new ReservationArrivalError(
      "VALIDATION",
      "Content-Type deve essere application/json.",
    );
  }
  try {
    return await request.json();
  } catch {
    throw new ReservationArrivalError(
      "VALIDATION",
      "Il corpo JSON non è valido.",
    );
  }
}

function arrivalFailure(error: unknown): Response {
  if (error instanceof ReservationArrivalError) {
    return noStoreJson(
      { error: error.publicMessage, code: error.code },
      reservationArrivalErrorStatus(error.code),
    );
  }
  console.error("Reservation arrival request failed.");
  return noStoreJson(
    { error: "Non è stato possibile aggiornare lo stato di arrivo." },
    500,
  );
}

export async function PUT(
  request: Request,
  context: ArrivalRouteContext,
): Promise<Response> {
  const user = await getRequestUser(request);
  if (!user) return noStoreJson({ error: "Unauthorized" }, 401);
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return passwordGuard;
  if (!isSameOriginRequest(request, resolveAuthConfig().trustProxy)) {
    return noStoreJson({ error: "Forbidden" }, 403);
  }

  const { id: rawId } = await context.params;
  const parsedId = z.uuid().safeParse(rawId);
  if (!parsedId.success) {
    return noStoreJson({ error: "Identificativo non valido." }, 400);
  }

  try {
    const result = await putReservationArrival({
      actor: { id: user.id, restaurantId: user.restaurantId },
      reservationId: parsedId.data,
      rawPayload: await strictJson(request),
    });
    return noStoreJson(result);
  } catch (error) {
    return arrivalFailure(error);
  }
}
