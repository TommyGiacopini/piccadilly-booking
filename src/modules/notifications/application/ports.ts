import type {
  NotificationChannel,
  NotificationEventType,
  NotificationFailureCode,
  NotificationPayloadV1,
  NotificationProviderKind,
  NotificationReservationSnapshot,
  NotificationStrategy,
  PlannedNotificationLeg,
  VersionedNotificationMessage,
} from "@/modules/notifications/domain/types";

export interface Clock {
  now(): Date;
}

export interface Sleeper {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface NotificationIdGenerator {
  generate(): string;
}

export interface NotificationPlanningContext {
  restaurantName: string;
  timezone: string;
  strategy: NotificationStrategy;
}

export interface NotificationTransactionWriter {
  readPlanningContext(
    restaurantId: string,
  ): Promise<NotificationPlanningContext | null>;
  insertLeg(input: {
    reservation: NotificationReservationSnapshot;
    actorUserId: string | null;
    originCorrelationId: string;
    leg: PlannedNotificationLeg;
    now: Date;
  }): Promise<void>;
  supersedeNonTerminal(input: {
    restaurantId: string;
    reservationId: string;
    reason: "SUPERSEDED" | "RESERVATION_CANCELLED";
    now: Date;
  }): Promise<void>;
  hasSucceededReminderForSchedule(input: {
    restaurantId: string;
    reservationId: string;
    localDate: string;
    serviceType: "LUNCH" | "DINNER";
    arrivalTime: string;
  }): Promise<boolean>;
}

export interface NotificationProviderRequest {
  destination: string;
  message: VersionedNotificationMessage;
  idempotencyKey: string;
  correlationId: string;
  context: {
    restaurantId: string;
    outboxId: string;
    providerKind: NotificationProviderKind;
  };
}

export type NotificationProviderResult =
  | {
      type: "SUCCESS";
      providerReference: string;
      deduplicated: boolean;
    }
  | {
      type: "TRANSIENT_FAILURE";
      failureCode: NotificationFailureCode;
    }
  | {
      type: "PERMANENT_FAILURE";
      failureCode: NotificationFailureCode;
    };

export interface NotificationProvider {
  send(
    request: NotificationProviderRequest,
    options: { signal: AbortSignal },
  ): Promise<NotificationProviderResult>;
}

export interface ClaimedNotification {
  id: string;
  restaurantId: string;
  reservationId: string;
  reservationVersion: number;
  eventGroupId: string;
  eventType: NotificationEventType;
  channel: NotificationChannel;
  strategy: NotificationStrategy;
  destination: string;
  payload: NotificationPayloadV1;
  expiresAt: Date;
  attemptCount: number;
  maxAttempts: number;
  idempotencyKey: string;
  originCorrelationId: string;
  leaseToken: string;
}

export interface StartedNotificationAttempt {
  notification: ClaimedNotification;
  attemptNumber: number;
  attemptCorrelationId: string;
  providerKind: NotificationProviderKind;
}

export interface NotificationWorkerRepository {
  expirePending(input: { now: Date; limit: number }): Promise<number>;
  recoverExpiredLeases(now: Date): Promise<number>;
  claimDue(input: {
    now: Date;
    batchSize: number;
    maxPerTenant: number;
    leaseMilliseconds: number;
  }): Promise<ClaimedNotification[]>;
  startAttempt(input: {
    notification: ClaimedNotification;
    attemptCorrelationId: string;
    now: Date;
  }): Promise<StartedNotificationAttempt | null>;
  confirmProviderCall(input: {
    attempt: StartedNotificationAttempt;
    now: Date;
  }): Promise<boolean>;
  finalizeAttempt(input: {
    attempt: StartedNotificationAttempt;
    result: NotificationProviderResult;
    now: Date;
    nextAvailableAt: Date | null;
    terminalFailureCode: NotificationFailureCode | null;
  }): Promise<"SUCCEEDED" | "PENDING" | "DEAD" | "CANCELLED" | "STALE">;
}

export interface NotificationSettingsActor {
  id: string;
  restaurantId: string;
}

export interface NotificationSettingsRepository {
  read(actor: NotificationSettingsActor): Promise<{
    strategy: NotificationStrategy;
  } | null>;
  update(input: {
    actor: NotificationSettingsActor;
    strategy: NotificationStrategy;
    correlationId: string;
    now: Date;
  }): Promise<{ strategy: NotificationStrategy; changed: boolean }>;
}
