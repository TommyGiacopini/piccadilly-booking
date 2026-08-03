import { NextResponse } from "next/server";
import { z } from "zod";

import {
  ReservationApplicationError,
  reservationErrorStatus,
} from "@/modules/reservations/application/reservation-errors";
import { getReservationById } from "@/modules/reservations/application/reservation-service";
import { getRequestUser } from "@/server/auth/authorization";

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

  const { id } = await context.params;
  const parsedId = z.string().uuid().safeParse(id);

  if (!parsedId.success) {
    return noStoreJson({ error: "Identificativo non valido." }, 400);
  }

  try {
    const reservation = await getReservationById({
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
