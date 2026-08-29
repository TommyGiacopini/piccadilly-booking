export const NOTIFICATION_EVENT_TYPES = [
  "RESERVATION_CONFIRMED",
  "RESERVATION_UPDATED",
  "RESERVATION_CANCELLED",
  "RESERVATION_REMINDER",
] as const;

export const NOTIFICATION_CHANNELS = ["WHATSAPP", "EMAIL"] as const;

export const NOTIFICATION_STRATEGIES = [
  "WHATSAPP_ONLY",
  "WHATSAPP_WITH_EMAIL_FALLBACK",
  "WHATSAPP_AND_EMAIL_PARALLEL",
] as const;

export const NOTIFICATION_OUTBOX_STATUSES = [
  "PENDING",
  "CLAIMED",
  "SUCCEEDED",
  "DEAD",
  "CANCELLED",
] as const;

export const NOTIFICATION_ATTEMPT_OUTCOMES = [
  "SUCCESS",
  "TRANSIENT_FAILURE",
  "PERMANENT_FAILURE",
  "ABANDONED",
] as const;

export const NOTIFICATION_PROVIDER_KINDS = [
  "SIMULATED_WHATSAPP",
  "SIMULATED_EMAIL",
] as const;

export const NOTIFICATION_FAILURE_CODES = [
  "SIMULATED_TRANSIENT_FAILURE",
  "SIMULATED_PERMANENT_FAILURE",
  "SIMULATED_TIMEOUT",
  "DESTINATION_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "IDEMPOTENCY_CONFLICT",
  "RETRY_EXHAUSTED",
  "EXPIRED",
  "WORKER_INTERRUPTED",
] as const;

export const NOTIFICATION_CANCELLATION_REASONS = [
  "SUPERSEDED",
  "RESERVATION_CANCELLED",
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationStrategy = (typeof NOTIFICATION_STRATEGIES)[number];
export type NotificationOutboxStatus =
  (typeof NOTIFICATION_OUTBOX_STATUSES)[number];
export type NotificationAttemptOutcome =
  (typeof NOTIFICATION_ATTEMPT_OUTCOMES)[number];
export type NotificationProviderKind =
  (typeof NOTIFICATION_PROVIDER_KINDS)[number];
export type NotificationFailureCode =
  (typeof NOTIFICATION_FAILURE_CODES)[number];
export type NotificationCancellationReason =
  (typeof NOTIFICATION_CANCELLATION_REASONS)[number];
export type NotificationLocale = "IT" | "EN";

export interface NotificationReservationSnapshot {
  id: string;
  restaurantId: string;
  restaurantName: string;
  timezone: string;
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

export interface NotificationPayloadV1 {
  schemaVersion: 1;
  templateKey: NotificationEventType;
  templateVersion: 1;
  locale: NotificationLocale;
  params: {
    customerFirstName: string;
    restaurantName: string;
    localDate: string;
    serviceType: "LUNCH" | "DINNER";
    arrivalTime: string;
    partySize: number;
  };
}

export interface VersionedNotificationMessage {
  templateKey: NotificationEventType;
  templateVersion: 1;
  locale: NotificationLocale;
  params: NotificationPayloadV1["params"];
}

export interface PlannedNotificationLeg {
  eventGroupId: string;
  eventType: NotificationEventType;
  channel: NotificationChannel;
  strategy: NotificationStrategy;
  destination: string | null;
  payload: NotificationPayloadV1;
  scheduledAt: Date;
  availableAt: Date;
  expiresAt: Date;
  terminalFailureCode: "DESTINATION_UNAVAILABLE" | null;
}
