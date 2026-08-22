import { NextResponse } from "next/server";
import { z } from "zod";

import {
  ReservationAssignmentError,
  reservationAssignmentErrorStatus,
} from "@/modules/rooms/application/reservation-assignment-errors";
import {
  deleteReservationAssignment,
  getReservationAssignmentContext,
  putReservationAssignment,
} from "@/modules/rooms/application/reservation-assignment-service";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import {
  getRequestUser,
  passwordChangeRequiredResponse,
} from "@/server/auth/authorization";
import { isSameOriginRequest } from "@/server/auth/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface AssignmentRouteContext {
  params: Promise<{ id: string }>;
}

function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

async function requireAssignmentUser(request: Request) {
  const user = await getRequestUser(request);
  if (!user) {
    return { user: null, response: noStoreJson({ error: "Unauthorized" }, 401) };
  }
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return { user: null, response: passwordGuard };
  return { user, response: null };
}

async function reservationId(context: AssignmentRouteContext) {
  const { id } = await context.params;
  const parsed = z.uuid().safeParse(id);
  return parsed.success ? parsed.data : null;
}

async function strictJson(request: Request): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    throw new ReservationAssignmentError(
      "VALIDATION",
      "Content-Type deve essere application/json.",
    );
  }
  try {
    return await request.json();
  } catch {
    throw new ReservationAssignmentError(
      "VALIDATION",
      "Il corpo JSON non è valido.",
    );
  }
}

function assignmentFailure(error: unknown): Response {
  if (error instanceof ReservationAssignmentError) {
    return noStoreJson(
      { error: error.publicMessage },
      reservationAssignmentErrorStatus(error.code),
    );
  }
  console.error("Reservation assignment request failed.");
  return noStoreJson(
    { error: "Non è stato possibile gestire l'assegnazione." },
    500,
  );
}

export async function GET(
  request: Request,
  context: AssignmentRouteContext,
): Promise<Response> {
  const auth = await requireAssignmentUser(request);
  if (auth.response) return auth.response;
  const id = await reservationId(context);
  if (!id) return noStoreJson({ error: "Identificativo non valido." }, 400);

  try {
    const assignmentContext = await getReservationAssignmentContext({
      actor: { id: auth.user.id, restaurantId: auth.user.restaurantId },
      reservationId: id,
    });
    return noStoreJson(assignmentContext);
  } catch (error) {
    return assignmentFailure(error);
  }
}

async function mutate(
  request: Request,
  context: AssignmentRouteContext,
  action: "PUT" | "DELETE",
): Promise<Response> {
  const auth = await requireAssignmentUser(request);
  if (auth.response) return auth.response;
  if (!isSameOriginRequest(request, resolveAuthConfig().trustProxy)) {
    return noStoreJson({ error: "Forbidden" }, 403);
  }
  const id = await reservationId(context);
  if (!id) return noStoreJson({ error: "Identificativo non valido." }, 400);

  try {
    const rawPayload = await strictJson(request);
    const actor = { id: auth.user.id, restaurantId: auth.user.restaurantId };
    const result =
      action === "PUT"
        ? await putReservationAssignment({
            actor,
            reservationId: id,
            rawPayload,
          })
        : await deleteReservationAssignment({
            actor,
            reservationId: id,
            rawPayload,
          });
    return noStoreJson(result);
  } catch (error) {
    return assignmentFailure(error);
  }
}

export async function PUT(
  request: Request,
  context: AssignmentRouteContext,
): Promise<Response> {
  return mutate(request, context, "PUT");
}

export async function DELETE(
  request: Request,
  context: AssignmentRouteContext,
): Promise<Response> {
  return mutate(request, context, "DELETE");
}
