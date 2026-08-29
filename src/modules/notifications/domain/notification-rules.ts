import { z } from "zod";

import { localReservationInstant } from "@/modules/reservations/domain/management-time";
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationChannel,
  type NotificationEventType,
  type NotificationLocale,
  type NotificationOutboxStatus,
  type NotificationPayloadV1,
  type NotificationReservationSnapshot,
  type NotificationStrategy,
  type PlannedNotificationLeg,
  type VersionedNotificationMessage,
} from "@/modules/notifications/domain/types";

const THREE_HOURS_MS = 3 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

const notificationPayloadV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    templateKey: z.enum(NOTIFICATION_EVENT_TYPES),
    templateVersion: z.literal(1),
    locale: z.enum(["IT", "EN"]),
    params: z
      .object({
        customerFirstName: z.string().min(1).max(80),
        restaurantName: z.string().min(1).max(200),
        localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        serviceType: z.enum(["LUNCH", "DINNER"]),
        arrivalTime: z.string().regex(/^\d{2}:\d{2}$/u),
        partySize: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export function notificationLocale(
  origin: NotificationReservationSnapshot["origin"],
  consentLanguage: string | null,
): NotificationLocale {
  return origin === "PUBLIC" && consentLanguage === "en" ? "EN" : "IT";
}

export function buildNotificationPayloadV1(
  eventType: NotificationEventType,
  reservation: NotificationReservationSnapshot,
): NotificationPayloadV1 {
  return {
    schemaVersion: 1,
    templateKey: eventType,
    templateVersion: 1,
    locale: notificationLocale(reservation.origin, reservation.consentLanguage),
    params: {
      customerFirstName: reservation.customerFirstName,
      restaurantName: reservation.restaurantName,
      localDate: reservation.localDate,
      serviceType: reservation.serviceType,
      arrivalTime: reservation.arrivalTime,
      partySize: reservation.partySize,
    },
  };
}

export function parseNotificationPayload(
  value: unknown,
): NotificationPayloadV1 {
  return notificationPayloadV1Schema.parse(value);
}

export function toVersionedMessage(
  payload: NotificationPayloadV1,
): VersionedNotificationMessage {
  return {
    templateKey: payload.templateKey,
    templateVersion: payload.templateVersion,
    locale: payload.locale,
    params: payload.params,
  };
}

export function reservationInstant(
  reservation: Pick<
    NotificationReservationSnapshot,
    "localDate" | "arrivalTime" | "timezone"
  >,
): Date {
  return localReservationInstant(
    reservation.localDate,
    reservation.arrivalTime,
    reservation.timezone,
  );
}

export function reminderSchedule(
  reservation: Pick<
    NotificationReservationSnapshot,
    "localDate" | "arrivalTime" | "timezone"
  >,
  now: Date,
): { scheduledAt: Date; expiresAt: Date } | null {
  const startsAt = reservationInstant(reservation);
  const remaining = startsAt.getTime() - now.getTime();
  if (remaining < THREE_HOURS_MS || remaining <= 0) return null;
  return {
    scheduledAt: new Date(startsAt.getTime() - THREE_HOURS_MS),
    expiresAt: startsAt,
  };
}

export function eventExpiry(eventType: NotificationEventType, now: Date): Date {
  if (eventType === "RESERVATION_REMINDER") {
    throw new Error("Reminder expiry is the reservation start instant.");
  }
  return new Date(now.getTime() + DAY_MS);
}

export function plannedChannels(input: {
  strategy: NotificationStrategy;
  eventType: NotificationEventType;
  whatsappConfirmationRequested: boolean;
}): NotificationChannel[] {
  const whatsappSuppressed =
    input.eventType === "RESERVATION_CONFIRMED" &&
    !input.whatsappConfirmationRequested;
  if (input.strategy === "WHATSAPP_AND_EMAIL_PARALLEL") {
    return whatsappSuppressed ? ["EMAIL"] : ["WHATSAPP", "EMAIL"];
  }
  return whatsappSuppressed ? [] : ["WHATSAPP"];
}

export function buildPlannedLegs(input: {
  reservation: NotificationReservationSnapshot;
  eventGroupId: string;
  eventType: NotificationEventType;
  strategy: NotificationStrategy;
  now: Date;
  scheduledAt: Date;
  expiresAt: Date;
  whatsappConfirmationRequested?: boolean;
}): PlannedNotificationLeg[] {
  const payload = buildNotificationPayloadV1(input.eventType, input.reservation);
  return plannedChannels({
    strategy: input.strategy,
    eventType: input.eventType,
    whatsappConfirmationRequested:
      input.whatsappConfirmationRequested ?? true,
  }).map((channel) => {
    const destination =
      channel === "WHATSAPP"
        ? input.reservation.customerPhone
        : input.reservation.customerEmail;
    const missing = destination === null;
    return {
      eventGroupId: input.eventGroupId,
      eventType: input.eventType,
      channel,
      strategy: input.strategy,
      destination,
      payload,
      scheduledAt: input.scheduledAt,
      availableAt: input.scheduledAt > input.now ? input.scheduledAt : input.now,
      expiresAt: input.expiresAt,
      terminalFailureCode: missing ? "DESTINATION_UNAVAILABLE" : null,
    };
  });
}

export type NotificationGroupOutcome =
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "FAILURE"
  | "PENDING"
  | "CANCELLED";

export function notificationGroupOutcome(
  statuses: readonly NotificationOutboxStatus[],
): NotificationGroupOutcome {
  if (statuses.length === 0 || statuses.some((status) => status === "PENDING" || status === "CLAIMED")) {
    return "PENDING";
  }
  if (statuses.every((status) => status === "CANCELLED")) return "CANCELLED";
  const successes = statuses.filter((status) => status === "SUCCEEDED").length;
  if (successes === statuses.length) return "SUCCESS";
  if (successes > 0) return "PARTIAL_SUCCESS";
  return "FAILURE";
}
