import { AvailabilityApplicationError } from "@/modules/availability/application/availability-errors";
import { availabilityPreviewQuerySchema } from "@/modules/availability/application/availability-preview-query";
import { getAvailabilityPreview } from "@/modules/availability/application/availability-service";
import { listAvailableRoomsForService } from "@/modules/rooms/infrastructure/service-instance-repository";
import {
  publicJson,
  rateLimitResponse,
} from "@/app/api/public/_shared";
import { enforcePublicRateLimit } from "@/server/security/public-request";
import { resolvePublicBookingConfig } from "@/shared/config/public-booking-config";
import { prisma } from "@/server/db/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const ALLOWED_PARAMETERS = new Set(["date", "service", "partySize"]);

export async function GET(request: Request): Promise<Response> {
  try {
    const config = resolvePublicBookingConfig();
    const rateLimit = await enforcePublicRateLimit({
      request,
      action: "AVAILABILITY",
      config,
    });

    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAt);
    }

    const url = new URL(request.url);

    if (
      [...url.searchParams.keys()].some(
        (parameter) => !ALLOWED_PARAMETERS.has(parameter),
      )
    ) {
      return publicJson({ error: "I parametri non sono validi." }, 400);
    }

    const parsed = availabilityPreviewQuerySchema.safeParse({
      date: url.searchParams.get("date") ?? undefined,
      service: url.searchParams.get("service") ?? undefined,
      partySize: url.searchParams.get("partySize") ?? undefined,
      channel: "PUBLIC",
    });

    if (!parsed.success) {
      return publicJson({ error: "I parametri non sono validi." }, 400);
    }

    const now = new Date();
    const [availability, rooms] = await Promise.all([
      getAvailabilityPreview({
        restaurantId: config.restaurantId,
        date: parsed.data.date,
        serviceType: parsed.data.service,
        partySize: parsed.data.partySize,
        channel: "PUBLIC",
        now,
        includePersistentLoad: true,
      }),
      listAvailableRoomsForService(prisma, {
        restaurantId: config.restaurantId,
        localDate: parsed.data.date,
        serviceType: parsed.data.service,
        now,
      }),
    ]);

    return publicJson({ ...availability, rooms });
  } catch (error) {
    if (error instanceof AvailabilityApplicationError) {
      return publicJson(
        { error: "La disponibilità non è temporaneamente consultabile." },
        error.code === "NOT_FOUND" ? 404 : 400,
      );
    }

    console.error("Public availability request failed.");
    return publicJson(
      { error: "La disponibilità non è temporaneamente consultabile." },
      500,
    );
  }
}
