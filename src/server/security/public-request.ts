import "server-only";

import type { PublicReservationRateLimitAction } from "@/generated/prisma/client";
import { resolveClientAddress } from "@/server/auth/request-security";
import {
  consumePublicRateLimit,
  createPublicRateLimitKeyHash,
} from "@/server/security/public-rate-limit";
import type { PublicBookingConfig } from "@/shared/config/public-booking-config";

export async function enforcePublicRateLimit(input: {
  request: Request;
  action: PublicReservationRateLimitAction;
  config: PublicBookingConfig;
  now?: Date;
}) {
  const clientAddress = resolveClientAddress(
    input.request.headers,
    input.config.trustProxy,
  );
  const keyHash = createPublicRateLimitKeyHash({
    restaurantId: input.config.restaurantId,
    action: input.action,
    clientAddress,
    secret: input.config.rateLimitSecret,
  });
  const isRead = input.action === "AVAILABILITY" || input.action === "VIEW";

  return consumePublicRateLimit({
    restaurantId: input.config.restaurantId,
    action: input.action,
    keyHash,
    limit: isRead ? input.config.readLimit : input.config.mutationLimit,
    windowMs: input.config.rateLimitWindowMs,
    now: input.now,
  });
}
