import { createHash } from "node:crypto";

import type {
  NotificationChannel,
  NotificationEventType,
  NotificationFailureCode,
  NotificationOutboxStatus,
} from "@/modules/notifications/domain/types";

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

function canonicalParts(parts: readonly (string | number)[]): string {
  return parts
    .map((part) => {
      const value = String(part);
      return `${Buffer.byteLength(value, "utf8")}:${value}`;
    })
    .join("|");
}

export function notificationIdempotencyKey(input: {
  restaurantId: string;
  reservationId: string;
  reservationVersion: number;
  eventType: NotificationEventType;
  channel: NotificationChannel;
}): string {
  return createHash("sha256")
    .update(
      canonicalParts([
        "notification-v1",
        input.restaurantId,
        input.reservationId,
        input.reservationVersion,
        input.eventType,
        input.channel,
      ]),
      "utf8",
    )
    .digest("hex");
}

export function notificationPayloadHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export function retryDelayAfterAttempt(attemptNumber: number): number | null {
  return RETRY_DELAYS_MS[attemptNumber - 1] ?? null;
}

export function nextRetryAt(input: {
  attemptNumber: number;
  completedAt: Date;
  expiresAt: Date;
}): Date | null {
  const delay = retryDelayAfterAttempt(input.attemptNumber);
  if (delay === null) return null;
  const next = new Date(input.completedAt.getTime() + delay);
  return next.getTime() >= input.expiresAt.getTime() ? null : next;
}

const ALLOWED_TRANSITIONS: Readonly<Record<NotificationOutboxStatus, readonly NotificationOutboxStatus[]>> = {
  PENDING: ["CLAIMED", "CANCELLED"],
  CLAIMED: ["SUCCEEDED", "PENDING", "DEAD", "CANCELLED"],
  SUCCEEDED: [],
  DEAD: [],
  CANCELLED: [],
};

export function canTransitionNotification(
  from: NotificationOutboxStatus,
  to: NotificationOutboxStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function terminalFailureForTransient(input: {
  attemptNumber: number;
  maxAttempts: number;
  now: Date;
  expiresAt: Date;
}): NotificationFailureCode | null {
  if (input.now.getTime() >= input.expiresAt.getTime()) return "EXPIRED";
  if (input.attemptNumber >= input.maxAttempts) return "RETRY_EXHAUSTED";
  return nextRetryAt({
    attemptNumber: input.attemptNumber,
    completedAt: input.now,
    expiresAt: input.expiresAt,
  }) === null
    ? "EXPIRED"
    : null;
}
