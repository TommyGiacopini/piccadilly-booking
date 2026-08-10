import {
  publicReservationErrorResponse,
  publicJson,
  rateLimitResponse,
  readPublicJson,
  requirePublicMutationRequest,
} from "@/app/api/public/_shared";
import { createPublicReservation } from "@/modules/reservations/application/public-reservation-service";
import { enforcePublicRateLimit } from "@/server/security/public-request";
import { resolvePublicBookingConfig } from "@/shared/config/public-booking-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  try {
    const config = resolvePublicBookingConfig();
    const invalidRequest = requirePublicMutationRequest(request, config);

    if (invalidRequest) {
      return invalidRequest;
    }

    const rateLimit = await enforcePublicRateLimit({
      request,
      action: "CREATE",
      config,
    });

    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAt);
    }

    const result = await createPublicReservation({
      restaurantId: config.restaurantId,
      managementSecret: config.managementSecret,
      rawPayload: await readPublicJson(request),
      rawIdempotencyKey: request.headers.get("idempotency-key"),
    });

    return publicJson(result, result.replayed ? 200 : 201);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "PublicReservationError") {
      console.error("Public reservation creation failed.");
    }
    return publicReservationErrorResponse(error);
  }
}
