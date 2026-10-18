import { NextResponse } from "next/server";
import { z } from "zod";

import {
  ReservationApplicationError,
  reservationErrorStatus,
} from "@/modules/reservations/application/reservation-errors";
import {
  cancelStaffReservation,
  getStaffReservation,
  updateStaffReservation,
} from "@/modules/reservations/application/staff-reservation-service";
import {
  getRequestUser,
  passwordChangeRequiredResponse,
} from "@/server/auth/authorization";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { isSameOriginRequest } from "@/server/auth/request-security";
import { readDraftRequestSession, draftSessionBindingError } from "@/server/auth/draft-session-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface ReservationRouteContext {
  params: Promise<{ id: string }>;
}

function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET(
  request: Request,
  context: ReservationRouteContext,
): Promise<Response> {
  const user = await getRequestUser(request);

  if (!user) {
    return noStoreJson({ error: "Unauthorized" }, 401);
  }
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return passwordGuard;

  const { id } = await context.params;
  const parsedId = z.string().uuid().safeParse(id);

  if (!parsedId.success) {
    return noStoreJson({ error: "Identificativo non valido." }, 400);
  }

  try {
    const reservation = await getStaffReservation({
      actor: {
        id: user.id,
        restaurantId: user.restaurantId,
        role: user.role,
      },
      reservationId: parsedId.data,
    });

    return noStoreJson({ reservation }, 200);
  } catch (error) {
    if (error instanceof ReservationApplicationError) {
      return noStoreJson(
        { error: error.publicMessage },
        reservationErrorStatus(error.code),
      );
    }

    console.error("Staff reservation read failed.");
    return noStoreJson(
      { error: "Non è stato possibile leggere la prenotazione." },
      500,
    );
  }
}

async function mutationPayload(request: Request): Promise<unknown> {
  const contentType =
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";

  if (contentType !== "application/json") {
    throw new ReservationApplicationError(
      "VALIDATION",
      "Content-Type deve essere application/json.",
    );
  }

  try {
    return await request.json();
  } catch {
    throw new ReservationApplicationError(
      "VALIDATION",
      "Il corpo JSON non è valido.",
    );
  }
}

async function mutate(
  request: Request,
  context: ReservationRouteContext,
  action: "UPDATE" | "CANCEL",
): Promise<Response> {
  let session;
  if (action === "UPDATE") {
    try { session = await readDraftRequestSession(request); }
    catch { return noStoreJson({ error: "Internal error" }, 500); }
  }
  const user = action === "UPDATE" ? session?.user : await getRequestUser(request);

  if (!user) return noStoreJson({ error: "Unauthorized" }, 401);
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return passwordGuard;

  if (!isSameOriginRequest(request, resolveAuthConfig().trustProxy)) {
    return noStoreJson({ error: "Forbidden" }, 403);
  }

  if (action === "UPDATE") {
    const bindingError = draftSessionBindingError(request, session!.sessionBinding);
    if (bindingError) return noStoreJson({ code: bindingError.code }, bindingError.status);
  }

  const { id } = await context.params;
  const parsedId = z.string().uuid().safeParse(id);

  if (!parsedId.success) {
    return noStoreJson({ error: "Identificativo non valido." }, 400);
  }

  try {
    const payload = await mutationPayload(request);
    const actor = {
      id: user.id,
      restaurantId: user.restaurantId,
      role: user.role,
    };
    const result =
      action === "UPDATE"
        ? await updateStaffReservation({
            actor,
            reservationId: parsedId.data,
            rawPayload: payload,
          })
        : await cancelStaffReservation({
            actor,
            reservationId: parsedId.data,
            rawPayload: payload,
          });

    return noStoreJson(result, 200);
  } catch (error) {
    if (error instanceof ReservationApplicationError) {
      return noStoreJson(
        { error: error.publicMessage },
        reservationErrorStatus(error.code),
      );
    }

    console.error(`Staff reservation ${action.toLowerCase()} failed.`);
    return noStoreJson(
      { error: "Non è stato possibile aggiornare la prenotazione." },
      500,
    );
  }
}

export async function PATCH(
  request: Request,
  context: ReservationRouteContext,
): Promise<Response> {
  return mutate(request, context, "UPDATE");
}

export async function DELETE(
  request: Request,
  context: ReservationRouteContext,
): Promise<Response> {
  return mutate(request, context, "CANCEL");
}
