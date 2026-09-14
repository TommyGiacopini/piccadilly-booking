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

export type NotificationWorkerPhase =
  | "STARTUP"
  | "CLOCK"
  | "EXPIRE_PENDING"
  | "RECOVER_EXPIRED_LEASES"
  | "CLAIM_DUE"
  | "PROCESS_NOTIFICATION"
  | "POLL_WAIT"
  | "SHUTDOWN";

export type NotificationWorkerFailureClassification =
  | "RUNTIME_RECOVERABLE"
  | "RUNTIME_FATAL";

export type NotificationWorkerFailureCode =
  | "DB_CONNECTION_UNAVAILABLE"
  | "DB_OPERATION_TIMEOUT"
  | "DB_CONNECTION_LOST"
  | "DB_POOL_EXHAUSTED"
  | "DB_TRANSACTION_CONFLICT"
  | "DB_AUTHORIZATION_FAILED"
  | "DB_SCHEMA_INCOMPATIBLE"
  | "WORKER_CONFIGURATION_INVALID"
  | "WORKER_RUNTIME_UNCLASSIFIED"
  | "NOTIFICATION_PROCESSING_FAILED";

export type NotificationWorkerEvent =
  | {
      event: "notification_worker_runtime_failure";
      phase: NotificationWorkerPhase;
      classification: NotificationWorkerFailureClassification;
      code: NotificationWorkerFailureCode;
      consecutiveFailures: number;
      backoffMs: number;
      timestamp: string;
    }
  | {
      event: "notification_worker_recovered";
      previousFailures: number;
      timestamp: string;
    }
  | {
      event: "notification_worker_item_failure";
      phase: "PROCESS_NOTIFICATION";
      code: "NOTIFICATION_PROCESSING_FAILED";
      outboxId: string;
      attemptCorrelationId?: string;
      timestamp: string;
    }
  | {
      event: "notification_worker_stopped";
      reason:
        | "ABORTED"
        | "RUNTIME_FATAL"
        | "ONE_SHOT_FAILURE"
        | "SHUTDOWN_FAILURE";
      phase: NotificationWorkerPhase;
      code: NotificationWorkerFailureCode;
      exitCode: 0 | 1;
      timestamp: string;
    };

export interface NotificationWorkerRuntime {
  classifyFailure(error: unknown): {
    classification: NotificationWorkerFailureClassification;
    code: NotificationWorkerFailureCode;
  };
  backoffMilliseconds(consecutiveFailures: number): number;
  timestamp(): string;
  emit(event: NotificationWorkerEvent): void;
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
