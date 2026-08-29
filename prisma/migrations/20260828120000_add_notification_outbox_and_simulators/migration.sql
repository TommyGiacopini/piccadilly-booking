CREATE TYPE "NotificationEventType" AS ENUM (
    'RESERVATION_CONFIRMED',
    'RESERVATION_UPDATED',
    'RESERVATION_CANCELLED',
    'RESERVATION_REMINDER'
);

CREATE TYPE "NotificationChannel" AS ENUM ('WHATSAPP', 'EMAIL');

CREATE TYPE "NotificationStrategy" AS ENUM (
    'WHATSAPP_ONLY',
    'WHATSAPP_WITH_EMAIL_FALLBACK',
    'WHATSAPP_AND_EMAIL_PARALLEL'
);

CREATE TYPE "NotificationOutboxStatus" AS ENUM (
    'PENDING',
    'CLAIMED',
    'SUCCEEDED',
    'DEAD',
    'CANCELLED'
);

CREATE TYPE "NotificationAttemptOutcome" AS ENUM (
    'SUCCESS',
    'TRANSIENT_FAILURE',
    'PERMANENT_FAILURE',
    'ABANDONED'
);

CREATE TYPE "NotificationProviderKind" AS ENUM (
    'SIMULATED_WHATSAPP',
    'SIMULATED_EMAIL'
);

CREATE TYPE "NotificationFailureCode" AS ENUM (
    'SIMULATED_TRANSIENT_FAILURE',
    'SIMULATED_PERMANENT_FAILURE',
    'SIMULATED_TIMEOUT',
    'DESTINATION_UNAVAILABLE',
    'PROVIDER_UNAVAILABLE',
    'PROVIDER_TIMEOUT',
    'IDEMPOTENCY_CONFLICT',
    'RETRY_EXHAUSTED',
    'EXPIRED',
    'WORKER_INTERRUPTED'
);

CREATE TYPE "NotificationCancellationReason" AS ENUM (
    'SUPERSEDED',
    'RESERVATION_CANCELLED'
);

CREATE TABLE "restaurant_notification_settings" (
    "restaurant_id" UUID NOT NULL,
    "strategy" "NotificationStrategy" NOT NULL DEFAULT 'WHATSAPP_ONLY',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "restaurant_notification_settings_pkey" PRIMARY KEY ("restaurant_id")
);

CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "restaurant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "event_group_id" UUID NOT NULL,
    "reservation_version" INTEGER NOT NULL,
    "event_type" "NotificationEventType" NOT NULL,
    "source" "ReservationOrigin" NOT NULL,
    "actor_user_id" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "strategy" "NotificationStrategy" NOT NULL,
    "destination" VARCHAR(254),
    "payload_version" SMALLINT NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "available_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "NotificationOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 4,
    "retry_policy_version" SMALLINT NOT NULL DEFAULT 1,
    "idempotency_key" CHAR(64) NOT NULL,
    "origin_correlation_id" UUID NOT NULL,
    "claimed_at" TIMESTAMPTZ(3),
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "cancel_requested_at" TIMESTAMPTZ(3),
    "cancellation_reason" "NotificationCancellationReason",
    "terminal_at" TIMESTAMPTZ(3),
    "terminal_failure_code" "NotificationFailureCode",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_outbox_attempt_count_check" CHECK (
        "attempt_count" >= 0 AND "max_attempts" > 0 AND "attempt_count" <= "max_attempts"
    ),
    CONSTRAINT "notification_outbox_payload_object_check" CHECK (jsonb_typeof("payload") = 'object'),
    CONSTRAINT "notification_outbox_versions_check" CHECK (
        "payload_version" = 1 AND "retry_policy_version" = 1 AND "reservation_version" > 0
    ),
    CONSTRAINT "notification_outbox_lease_check" CHECK (
        ("status" = 'CLAIMED' AND "claimed_at" IS NOT NULL AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
        OR
        ("status" <> 'CLAIMED' AND "claimed_at" IS NULL AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
    ),
    CONSTRAINT "notification_outbox_terminal_check" CHECK (
        (("status" IN ('SUCCEEDED', 'DEAD', 'CANCELLED')) AND "terminal_at" IS NOT NULL)
        OR
        (("status" IN ('PENDING', 'CLAIMED')) AND "terminal_at" IS NULL)
    ),
    CONSTRAINT "notification_outbox_failure_check" CHECK (
        ("status" = 'DEAD' AND "terminal_failure_code" IS NOT NULL)
        OR
        ("status" <> 'DEAD' AND "terminal_failure_code" IS NULL)
    ),
    CONSTRAINT "notification_outbox_destination_check" CHECK (
        "destination" IS NOT NULL
        OR ("status" = 'DEAD' AND "terminal_failure_code" = 'DESTINATION_UNAVAILABLE')
    ),
    CONSTRAINT "notification_outbox_cancellation_check" CHECK (
        ("status" = 'CANCELLED' AND "cancellation_reason" IS NOT NULL)
        OR "status" <> 'CANCELLED'
    ),
    CONSTRAINT "notification_outbox_expiry_check" CHECK (
        "expires_at" > "scheduled_at" AND "available_at" <= "expires_at"
    )
);

CREATE TABLE "notification_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "restaurant_id" UUID NOT NULL,
    "outbox_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "provider_kind" "NotificationProviderKind" NOT NULL,
    "attempt_correlation_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "outcome" "NotificationAttemptOutcome",
    "failure_code" "NotificationFailureCode",
    "provider_reference" VARCHAR(96),
    "deduplicated" BOOLEAN,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_attempts_number_check" CHECK ("attempt_number" > 0),
    CONSTRAINT "notification_attempts_lifecycle_check" CHECK (
        ("outcome" IS NULL AND "completed_at" IS NULL AND "failure_code" IS NULL AND "provider_reference" IS NULL AND "deduplicated" IS NULL)
        OR
        ("outcome" = 'SUCCESS' AND "completed_at" IS NOT NULL AND "failure_code" IS NULL AND "provider_reference" IS NOT NULL AND "deduplicated" IS NOT NULL)
        OR
        ("outcome" IN ('TRANSIENT_FAILURE', 'PERMANENT_FAILURE', 'ABANDONED') AND "completed_at" IS NOT NULL AND "failure_code" IS NOT NULL AND "provider_reference" IS NULL AND "deduplicated" IS NULL)
    )
);

CREATE TABLE "notification_simulation_receipts" (
    "restaurant_id" UUID NOT NULL,
    "idempotency_key" CHAR(64) NOT NULL,
    "outbox_id" UUID NOT NULL,
    "provider_kind" "NotificationProviderKind" NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "provider_reference" VARCHAR(96) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_simulation_receipts_pkey" PRIMARY KEY ("restaurant_id", "idempotency_key")
);

INSERT INTO "restaurant_notification_settings" ("restaurant_id", "strategy", "created_at", "updated_at")
SELECT "id", 'WHATSAPP_ONLY', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "restaurants";

CREATE UNIQUE INDEX "notification_outbox_restaurant_id_key"
ON "notification_outbox"("restaurant_id", "id");

CREATE UNIQUE INDEX "notification_outbox_restaurant_idempotency_key"
ON "notification_outbox"("restaurant_id", "idempotency_key");

CREATE UNIQUE INDEX "notification_outbox_logical_delivery_key"
ON "notification_outbox"("restaurant_id", "reservation_id", "reservation_version", "event_type", "channel");

CREATE INDEX "notification_outbox_work_eligibility_idx"
ON "notification_outbox"("status", "available_at", "scheduled_at", "created_at", "id");

CREATE INDEX "notification_outbox_lease_recovery_idx"
ON "notification_outbox"("status", "lease_expires_at");

CREATE INDEX "notification_outbox_restaurant_reservation_created_idx"
ON "notification_outbox"("restaurant_id", "reservation_id", "created_at");

CREATE INDEX "notification_outbox_restaurant_group_status_idx"
ON "notification_outbox"("restaurant_id", "event_group_id", "status");

CREATE UNIQUE INDEX "notification_attempts_logical_attempt_key"
ON "notification_attempts"("restaurant_id", "outbox_id", "attempt_number");

CREATE INDEX "notification_attempts_restaurant_outbox_created_idx"
ON "notification_attempts"("restaurant_id", "outbox_id", "created_at");

CREATE UNIQUE INDEX "notification_simulation_receipts_restaurant_outbox_key"
ON "notification_simulation_receipts"("restaurant_id", "outbox_id");

ALTER TABLE "restaurant_notification_settings"
ADD CONSTRAINT "restaurant_notification_settings_restaurant_id_fkey"
FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_outbox"
ADD CONSTRAINT "notification_outbox_restaurant_id_fkey"
FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_outbox"
ADD CONSTRAINT "notification_outbox_restaurant_reservation_fkey"
FOREIGN KEY ("restaurant_id", "reservation_id") REFERENCES "reservations"("restaurant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_outbox"
ADD CONSTRAINT "notification_outbox_restaurant_actor_fkey"
FOREIGN KEY ("restaurant_id", "actor_user_id") REFERENCES "users"("restaurant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_attempts"
ADD CONSTRAINT "notification_attempts_restaurant_id_fkey"
FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_attempts"
ADD CONSTRAINT "notification_attempts_restaurant_outbox_fkey"
FOREIGN KEY ("restaurant_id", "outbox_id") REFERENCES "notification_outbox"("restaurant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_simulation_receipts"
ADD CONSTRAINT "notification_simulation_receipts_restaurant_id_fkey"
FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_simulation_receipts"
ADD CONSTRAINT "notification_simulation_receipts_restaurant_outbox_fkey"
FOREIGN KEY ("restaurant_id", "outbox_id") REFERENCES "notification_outbox"("restaurant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
