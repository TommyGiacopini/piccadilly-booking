-- ExtendEnum
ALTER TYPE "ReservationOrigin" ADD VALUE 'PUBLIC';

-- ExtendEnum
ALTER TYPE "PrivacyConsentMethod" ADD VALUE 'WEB_CHECKBOX';

-- CreateEnum
CREATE TYPE "PublicReservationRateLimitAction" AS ENUM ('AVAILABILITY', 'CREATE', 'VIEW', 'UPDATE', 'CANCEL');

-- CreateEnum
CREATE TYPE "ReservationAuditAction" AS ENUM ('CREATED', 'UPDATED', 'CANCELLED');

-- AlterTable
ALTER TABLE "restaurant_booking_settings"
ADD COLUMN "management_link_duration_hours" INTEGER NOT NULL DEFAULT 24;

-- CheckConstraint
ALTER TABLE "restaurant_booking_settings"
ADD CONSTRAINT "restaurant_booking_settings_link_duration_check"
CHECK ("management_link_duration_hours" BETWEEN 1 AND 24);

-- AlterTable
ALTER TABLE "reservations"
ADD COLUMN "terms_policy_version" VARCHAR(64),
ADD COLUMN "terms_consent_at" TIMESTAMPTZ(3),
ADD COLUMN "terms_consent_method" "PrivacyConsentMethod",
ADD COLUMN "consent_language" VARCHAR(2),
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "reservations"
ADD CONSTRAINT "reservations_version_positive_check" CHECK ("version" > 0);

-- ReplaceCheckConstraint
ALTER TABLE "reservations"
DROP CONSTRAINT "reservations_privacy_consent_check";

ALTER TABLE "reservations"
ADD CONSTRAINT "reservations_privacy_consent_check"
CHECK (
    btrim("privacy_policy_version") <> ''
    AND (
        (
            "origin" = 'PHONE'
            AND "created_by_user_id" IS NOT NULL
            AND "privacy_consent_method" = 'VERBAL'
            AND "terms_policy_version" IS NULL
            AND "terms_consent_at" IS NULL
            AND "terms_consent_method" IS NULL
            AND "consent_language" IS NULL
        )
        OR (
            "origin" = 'STAFF'
            AND "created_by_user_id" IS NOT NULL
            AND "privacy_consent_method" = 'STAFF_RECORDED'
            AND "terms_policy_version" IS NULL
            AND "terms_consent_at" IS NULL
            AND "terms_consent_method" IS NULL
            AND "consent_language" IS NULL
        )
        OR (
            "origin" = 'PUBLIC'
            AND "created_by_user_id" IS NULL
            AND "privacy_consent_method" = 'WEB_CHECKBOX'
            AND "terms_policy_version" IS NOT NULL
            AND btrim("terms_policy_version") <> ''
            AND "terms_consent_at" IS NOT NULL
            AND "terms_consent_method" = 'WEB_CHECKBOX'
            AND "consent_language" IN ('it', 'en')
            AND "capacity_override" = false
            AND "capacity_override_reason" IS NULL
        )
    )
);

-- CreateTable
CREATE TABLE "reservation_management_tokens" (
    "id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "view_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "reservation_management_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reservation_management_tokens_expiry_check" CHECK ("view_expires_at" > "created_at")
);

-- CreateTable
CREATE TABLE "public_reservation_rate_limits" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "action" "PublicReservationRateLimitAction" NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "window_started_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "public_reservation_rate_limits_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "public_reservation_rate_limits_window_check" CHECK (
        "attempts" > 0 AND "expires_at" > "window_started_at"
    )
);

-- CreateTable
CREATE TABLE "reservation_audit_events" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "action" "ReservationAuditAction" NOT NULL,
    "actor_origin" "ReservationOrigin" NOT NULL,
    "correlation_id" UUID NOT NULL,
    "previous_state" JSONB,
    "new_state" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reservation_audit_events_state_check" CHECK (
        ("action" = 'CREATED' AND "previous_state" IS NULL AND "new_state" IS NOT NULL)
        OR ("action" = 'UPDATED' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL)
        OR ("action" = 'CANCELLED' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL)
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "reservation_management_tokens_reservation_id_key" ON "reservation_management_tokens"("reservation_id");
CREATE UNIQUE INDEX "reservation_management_tokens_token_hash_key" ON "reservation_management_tokens"("token_hash");
CREATE INDEX "reservation_management_tokens_expiry_idx" ON "reservation_management_tokens"("view_expires_at", "revoked_at");
CREATE UNIQUE INDEX "public_reservation_rate_limits_identity_key" ON "public_reservation_rate_limits"("restaurant_id", "action", "key_hash");
CREATE INDEX "public_reservation_rate_limits_expires_at_idx" ON "public_reservation_rate_limits"("expires_at");
CREATE INDEX "reservation_audit_events_reservation_created_idx" ON "reservation_audit_events"("reservation_id", "created_at");
CREATE INDEX "reservation_audit_events_restaurant_created_idx" ON "reservation_audit_events"("restaurant_id", "created_at");

-- AddForeignKey
ALTER TABLE "reservation_management_tokens" ADD CONSTRAINT "reservation_management_tokens_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public_reservation_rate_limits" ADD CONSTRAINT "public_reservation_rate_limits_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reservation_audit_events" ADD CONSTRAINT "reservation_audit_events_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reservation_audit_events" ADD CONSTRAINT "reservation_audit_events_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
