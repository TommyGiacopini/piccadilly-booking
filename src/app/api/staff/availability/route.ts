import { NextResponse } from "next/server";

import { AvailabilityApplicationError } from "@/modules/availability/application/availability-errors";
import { availabilityPreviewQuerySchema } from "@/modules/availability/application/availability-preview-query";
import { getAvailabilityPreview } from "@/modules/availability/application/availability-service";
import { listAvailableRoomsForService } from "@/modules/rooms/infrastructure/service-instance-repository";
import {
  getRequestUser,
  passwordChangeRequiredResponse,
} from "@/server/auth/authorization";
import { prisma } from "@/server/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOWED_PARAMETERS = new Set(["date", "service", "partySize"]);

function noStoreJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request);

  if (!user) return noStoreJson({ error: "Unauthorized" }, 401);
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return passwordGuard;

  try {
    const url = new URL(request.url);

    if (
      [...url.searchParams.keys()].some(
        (parameter) => !ALLOWED_PARAMETERS.has(parameter),
      )
    ) {
      return noStoreJson({ error: "I parametri non sono validi." }, 400);
    }

    const parsed = availabilityPreviewQuerySchema.safeParse({
      date: url.searchParams.get("date") ?? undefined,
      service: url.searchParams.get("service") ?? undefined,
      partySize: url.searchParams.get("partySize") ?? undefined,
      channel: "STAFF",
    });

    if (!parsed.success) {
      return noStoreJson({ error: "I parametri non sono validi." }, 400);
    }

    const now = new Date();
    const availability = await getAvailabilityPreview({
      restaurantId: user.restaurantId,
      date: parsed.data.date,
      serviceType: parsed.data.service,
      partySize: parsed.data.partySize,
      channel: "STAFF",
      now,
      includePersistentLoad: true,
    });
    const rooms = await listAvailableRoomsForService(prisma, {
      restaurantId: user.restaurantId,
      localDate: parsed.data.date,
      serviceType: parsed.data.service,
      now,
    });

    return noStoreJson({ ...availability, rooms }, 200);
  } catch (error) {
    if (error instanceof AvailabilityApplicationError) {
      return noStoreJson(
        { error: "La disponibilità non è temporaneamente consultabile." },
        error.code === "NOT_FOUND" ? 404 : 400,
      );
    }

    console.error("Staff availability request failed.");
    return noStoreJson(
      { error: "La disponibilità non è temporaneamente consultabile." },
      500,
    );
  }
}
