import {
  buildPlannedLegs,
  eventExpiry,
  reminderSchedule,
} from "@/modules/notifications/domain/notification-rules";
import type {
  NotificationEventType,
  NotificationReservationSnapshot,
} from "@/modules/notifications/domain/types";
import type {
  NotificationIdGenerator,
  NotificationPlanningContext,
  NotificationTransactionWriter,
} from "@/modules/notifications/application/ports";

export interface ReservationNotificationSource {
  id: string;
  restaurantId: string;
  version: number;
  origin: "PUBLIC" | "PHONE" | "STAFF";
  customerFirstName: string;
  customerPhone: string;
  customerEmail: string | null;
  consentLanguage: string | null;
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  partySize: number;
}

export interface NotificationPlanningDependencies {
  writer: NotificationTransactionWriter;
  ids: NotificationIdGenerator;
}

function snapshot(
  reservation: ReservationNotificationSource,
  context: NotificationPlanningContext,
): NotificationReservationSnapshot {
  return {
    ...reservation,
    restaurantName: context.restaurantName,
    timezone: context.timezone,
  };
}

async function requireContext(
  writer: NotificationTransactionWriter,
  restaurantId: string,
): Promise<NotificationPlanningContext> {
  const context = await writer.readPlanningContext(restaurantId);
  if (!context) {
    throw new Error("Notification settings are not available for the restaurant.");
  }
  return context;
}

async function insertEvent(input: {
  dependencies: NotificationPlanningDependencies;
  reservation: ReservationNotificationSource;
  context: NotificationPlanningContext;
  eventType: NotificationEventType;
  actorUserId: string | null;
  originCorrelationId: string;
  now: Date;
  scheduledAt: Date;
  expiresAt: Date;
  whatsappConfirmationRequested?: boolean;
}): Promise<void> {
  const reservation = snapshot(input.reservation, input.context);
  const legs = buildPlannedLegs({
    reservation,
    eventGroupId: input.dependencies.ids.generate(),
    eventType: input.eventType,
    strategy: input.context.strategy,
    now: input.now,
    scheduledAt: input.scheduledAt,
    expiresAt: input.expiresAt,
    whatsappConfirmationRequested: input.whatsappConfirmationRequested,
  });
  for (const leg of legs) {
    await input.dependencies.writer.insertLeg({
      reservation,
      actorUserId: input.actorUserId,
      originCorrelationId: input.originCorrelationId,
      leg,
      now: input.now,
    });
  }
}

async function insertReminder(input: {
  dependencies: NotificationPlanningDependencies;
  reservation: ReservationNotificationSource;
  context: NotificationPlanningContext;
  actorUserId: string | null;
  originCorrelationId: string;
  now: Date;
}): Promise<void> {
  const reservation = snapshot(input.reservation, input.context);
  const reminder = reminderSchedule(reservation, input.now);
  if (!reminder) return;
  await insertEvent({
    ...input,
    eventType: "RESERVATION_REMINDER",
    scheduledAt: reminder.scheduledAt,
    expiresAt: reminder.expiresAt,
  });
}

export async function planReservationCreated(input: {
  dependencies: NotificationPlanningDependencies;
  reservation: ReservationNotificationSource;
  actorUserId: string | null;
  originCorrelationId: string;
  now: Date;
  sendWhatsAppConfirmation?: boolean;
}): Promise<void> {
  const context = await requireContext(
    input.dependencies.writer,
    input.reservation.restaurantId,
  );
  await insertEvent({
    dependencies: input.dependencies,
    reservation: input.reservation,
    context,
    eventType: "RESERVATION_CONFIRMED",
    actorUserId: input.actorUserId,
    originCorrelationId: input.originCorrelationId,
    now: input.now,
    scheduledAt: input.now,
    expiresAt: eventExpiry("RESERVATION_CONFIRMED", input.now),
    whatsappConfirmationRequested: input.sendWhatsAppConfirmation,
  });
  await insertReminder({ ...input, context });
}

export async function planReservationUpdated(input: {
  dependencies: NotificationPlanningDependencies;
  reservation: ReservationNotificationSource;
  actorUserId: string | null;
  originCorrelationId: string;
  now: Date;
  scheduleChanged: boolean;
}): Promise<void> {
  const context = await requireContext(
    input.dependencies.writer,
    input.reservation.restaurantId,
  );
  const succeededForSameSchedule =
    !input.scheduleChanged &&
    (await input.dependencies.writer.hasSucceededReminderForSchedule({
      restaurantId: input.reservation.restaurantId,
      reservationId: input.reservation.id,
      localDate: input.reservation.localDate,
      serviceType: input.reservation.serviceType,
      arrivalTime: input.reservation.arrivalTime,
    }));
  await input.dependencies.writer.supersedeNonTerminal({
    restaurantId: input.reservation.restaurantId,
    reservationId: input.reservation.id,
    reason: "SUPERSEDED",
    now: input.now,
  });
  await insertEvent({
    dependencies: input.dependencies,
    reservation: input.reservation,
    context,
    eventType: "RESERVATION_UPDATED",
    actorUserId: input.actorUserId,
    originCorrelationId: input.originCorrelationId,
    now: input.now,
    scheduledAt: input.now,
    expiresAt: eventExpiry("RESERVATION_UPDATED", input.now),
  });
  if (!succeededForSameSchedule) {
    await insertReminder({ ...input, context });
  }
}

export async function planReservationCancelled(input: {
  dependencies: NotificationPlanningDependencies;
  reservation: ReservationNotificationSource;
  actorUserId: string | null;
  originCorrelationId: string;
  now: Date;
}): Promise<void> {
  const context = await requireContext(
    input.dependencies.writer,
    input.reservation.restaurantId,
  );
  await input.dependencies.writer.supersedeNonTerminal({
    restaurantId: input.reservation.restaurantId,
    reservationId: input.reservation.id,
    reason: "RESERVATION_CANCELLED",
    now: input.now,
  });
  await insertEvent({
    dependencies: input.dependencies,
    reservation: input.reservation,
    context,
    eventType: "RESERVATION_CANCELLED",
    actorUserId: input.actorUserId,
    originCorrelationId: input.originCorrelationId,
    now: input.now,
    scheduledAt: input.now,
    expiresAt: eventExpiry("RESERVATION_CANCELLED", input.now),
  });
}
