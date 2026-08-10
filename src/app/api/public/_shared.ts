import { NextResponse } from "next/server";

import {
  PublicReservationError,
  publicReservationErrorMessage,
  publicReservationErrorStatus,
} from "@/modules/reservations/application/public-reservation-errors";
import { isSameOriginRequest } from "@/server/auth/request-security";
import type { PublicBookingConfig } from "@/shared/config/public-booking-config";

export function publicJson(body: unknown, status = 200, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

export function requirePublicMutationRequest(
  request: Request,
  config: PublicBookingConfig,
): Response | null {
  if (!isSameOriginRequest(request, config.trustProxy)) {
    return publicJson({ error: "Richiesta non consentita." }, 403);
  }

  const contentType =
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";

  return contentType === "application/json"
    ? null
    : publicJson({ error: "La richiesta non è valida." }, 400);
}

export async function readPublicJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new PublicReservationError("VALIDATION");
  }
}

export function publicReservationErrorResponse(error: unknown): Response {
  if (error instanceof PublicReservationError) {
    return publicJson(
      { error: publicReservationErrorMessage(error.code) },
      publicReservationErrorStatus(error.code),
    );
  }

  return publicJson(
    { error: "Non è stato possibile completare la richiesta." },
    500,
  );
}

export function rateLimitResponse(retryAt: Date, now = new Date()): Response {
  const retryAfter = Math.max(
    1,
    Math.ceil((retryAt.getTime() - now.getTime()) / 1_000),
  );
  return publicJson(
    { error: "Troppe richieste. Riprova più tardi." },
    429,
    { "Retry-After": String(retryAfter) },
  );
}
