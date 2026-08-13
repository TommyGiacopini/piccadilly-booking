import { NextResponse } from "next/server";

import { AvailabilityApplicationError } from "@/modules/availability/application/availability-errors";
import { availabilityPreviewQuerySchema } from "@/modules/availability/application/availability-preview-query";
import { getAvailabilityPreview } from "@/modules/availability/application/availability-service";
import {
  getRequestUser,
  passwordChangeRequiredResponse,
} from "@/server/auth/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOWED_QUERY_PARAMETERS = new Set([
  "date",
  "service",
  "partySize",
  "channel",
]);

function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request);

  if (!user) {
    return noStoreJson({ error: "Unauthorized" }, 401);
  }
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return passwordGuard;

  if (user.role !== "ADMIN") {
    return noStoreJson({ error: "Forbidden" }, 403);
  }

  const url = new URL(request.url);

  if (
    [...url.searchParams.keys()].some(
      (parameter) => !ALLOWED_QUERY_PARAMETERS.has(parameter),
    )
  ) {
    return noStoreJson({ error: "Parametri non validi." }, 400);
  }

  const parsed = availabilityPreviewQuerySchema.safeParse({
    date: url.searchParams.get("date") ?? undefined,
    service: url.searchParams.get("service") ?? undefined,
    partySize: url.searchParams.get("partySize") ?? undefined,
    channel: url.searchParams.get("channel") ?? undefined,
  });

  if (!parsed.success) {
    return noStoreJson(
      {
        error:
          parsed.error.issues[0]?.message ?? "I parametri non sono validi.",
      },
      400,
    );
  }

  try {
    const result = await getAvailabilityPreview({
      restaurantId: user.restaurantId,
      date: parsed.data.date,
      serviceType: parsed.data.service,
      partySize: parsed.data.partySize,
      channel: parsed.data.channel,
      now: new Date(),
    });

    return noStoreJson(result);
  } catch (error) {
    if (error instanceof AvailabilityApplicationError) {
      return noStoreJson(
        { error: error.publicMessage },
        error.code === "NOT_FOUND" ? 404 : 400,
      );
    }

    console.error("Availability preview read failed.");
    return noStoreJson(
      { error: "Non è stato possibile calcolare la disponibilità." },
      500,
    );
  }
}
