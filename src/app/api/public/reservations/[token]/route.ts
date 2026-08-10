import {
  publicReservationErrorResponse,
  publicJson,
  rateLimitResponse,
  readPublicJson,
  requirePublicMutationRequest,
} from "@/app/api/public/_shared";
import {
  cancelManagedPublicReservation,
  readPublicReservation,
  updateManagedPublicReservation,
} from "@/modules/reservations/application/public-reservation-service";
import { enforcePublicRateLimit } from "@/server/security/public-request";
import { resolvePublicBookingConfig } from "@/shared/config/public-booking-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface PublicReservationRouteContext {
  params: Promise<{ token: string }>;
}

async function rateLimitedContext(
  request: Request,
  context: PublicReservationRouteContext,
  action: "VIEW" | "UPDATE" | "CANCEL",
) {
  const config = resolvePublicBookingConfig();
  const rateLimit = await enforcePublicRateLimit({ request, action, config });
  const { token } = await context.params;
  return { config, rateLimit, token };
}

export async function GET(
  request: Request,
  context: PublicReservationRouteContext,
): Promise<Response> {
  try {
    const { config, rateLimit, token } = await rateLimitedContext(
      request,
      context,
      "VIEW",
    );

    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAt);
    }

    const reservation = await readPublicReservation({
      restaurantId: config.restaurantId,
      rawToken: token,
    });
    return publicJson({ reservation });
  } catch (error) {
    return publicReservationErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: PublicReservationRouteContext,
): Promise<Response> {
  try {
    const { config, rateLimit, token } = await rateLimitedContext(
      request,
      context,
      "UPDATE",
    );
    const invalidRequest = requirePublicMutationRequest(request, config);

    if (invalidRequest) {
      return invalidRequest;
    }
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAt);
    }

    const reservation = await updateManagedPublicReservation({
      restaurantId: config.restaurantId,
      rawToken: token,
      rawPayload: await readPublicJson(request),
    });
    return publicJson({ reservation });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "PublicReservationError") {
      console.error("Public reservation update failed.");
    }
    return publicReservationErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  context: PublicReservationRouteContext,
): Promise<Response> {
  try {
    const { config, rateLimit, token } = await rateLimitedContext(
      request,
      context,
      "CANCEL",
    );
    const invalidRequest = requirePublicMutationRequest(request, config);

    if (invalidRequest) {
      return invalidRequest;
    }
    if (!rateLimit.allowed) {
      return rateLimitResponse(rateLimit.retryAt);
    }

    const reservation = await cancelManagedPublicReservation({
      restaurantId: config.restaurantId,
      rawToken: token,
    });
    return publicJson({ reservation });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "PublicReservationError") {
      console.error("Public reservation cancellation failed.");
    }
    return publicReservationErrorResponse(error);
  }
}
