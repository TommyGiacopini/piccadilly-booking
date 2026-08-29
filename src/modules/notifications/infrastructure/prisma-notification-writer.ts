import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { NotificationTransactionWriter } from "@/modules/notifications/application/ports";
import { notificationIdempotencyKey } from "@/modules/notifications/domain/delivery-policy";
import { parseNotificationPayload } from "@/modules/notifications/domain/notification-rules";

export function createPrismaNotificationWriter(
  client: Prisma.TransactionClient,
): NotificationTransactionWriter {
  return {
    async readPlanningContext(restaurantId) {
      const restaurant = await client.restaurant.findUnique({
        where: { id: restaurantId },
        select: {
          name: true,
          timezone: true,
          notificationSettings: { select: { strategy: true } },
        },
      });
      if (!restaurant?.notificationSettings) return null;
      return {
        restaurantName: restaurant.name,
        timezone: restaurant.timezone,
        strategy: restaurant.notificationSettings.strategy,
      };
    },

    async insertLeg(input) {
      const unavailable = input.leg.terminalFailureCode !== null;
      await client.notificationOutbox.create({
        data: {
          restaurantId: input.reservation.restaurantId,
          reservationId: input.reservation.id,
          eventGroupId: input.leg.eventGroupId,
          reservationVersion: input.reservation.version,
          eventType: input.leg.eventType,
          source: input.reservation.origin,
          actorUserId: input.actorUserId,
          channel: input.leg.channel,
          strategy: input.leg.strategy,
          destination: input.leg.destination,
          payloadVersion: 1,
          payload: input.leg.payload as unknown as Prisma.InputJsonValue,
          scheduledAt: input.leg.scheduledAt,
          availableAt: input.leg.availableAt,
          expiresAt: input.leg.expiresAt,
          status: unavailable ? "DEAD" : "PENDING",
          attemptCount: 0,
          maxAttempts: 4,
          retryPolicyVersion: 1,
          idempotencyKey: notificationIdempotencyKey({
            restaurantId: input.reservation.restaurantId,
            reservationId: input.reservation.id,
            reservationVersion: input.reservation.version,
            eventType: input.leg.eventType,
            channel: input.leg.channel,
          }),
          originCorrelationId: input.originCorrelationId,
          terminalAt: unavailable ? input.now : null,
          terminalFailureCode: input.leg.terminalFailureCode,
        },
      });
    },

    async supersedeNonTerminal(input) {
      await client.notificationOutbox.updateMany({
        where: {
          restaurantId: input.restaurantId,
          reservationId: input.reservationId,
          status: "PENDING",
        },
        data: {
          status: "CANCELLED",
          terminalAt: input.now,
          cancellationReason: input.reason,
        },
      });
      await client.notificationOutbox.updateMany({
        where: {
          restaurantId: input.restaurantId,
          reservationId: input.reservationId,
          status: "CLAIMED",
        },
        data: {
          cancelRequestedAt: input.now,
          cancellationReason: input.reason,
        },
      });
    },

    async hasSucceededReminderForSchedule(input) {
      const rows = await client.notificationOutbox.findMany({
        where: {
          restaurantId: input.restaurantId,
          reservationId: input.reservationId,
          eventType: "RESERVATION_REMINDER",
          status: "SUCCEEDED",
        },
        select: { payload: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      return rows.some((row) => {
        const parsed = parseNotificationPayload(row.payload);
        return (
          parsed.params.localDate === input.localDate &&
          parsed.params.serviceType === input.serviceType &&
          parsed.params.arrivalTime === input.arrivalTime
        );
      });
    },
  };
}
