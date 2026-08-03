-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationOrigin" AS ENUM ('STAFF', 'PHONE');

-- CreateEnum
CREATE TYPE "PrivacyConsentMethod" AS ENUM ('VERBAL', 'STAFF_RECORDED');

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "service_type" "ServiceType" NOT NULL,
    "arrival_time" TIME(0) NOT NULL,
    "party_size" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "origin" "ReservationOrigin" NOT NULL,
    "customer_first_name" VARCHAR(80) NOT NULL,
    "customer_last_name" VARCHAR(80) NOT NULL,
    "customer_phone" VARCHAR(40) NOT NULL,
    "customer_email" VARCHAR(254),
    "notes" VARCHAR(1000),
    "preferences" VARCHAR(1000),
    "allergies" VARCHAR(1000),
    "privacy_policy_version" VARCHAR(64) NOT NULL,
    "privacy_consent_at" TIMESTAMPTZ(3) NOT NULL,
    "privacy_consent_method" "PrivacyConsentMethod" NOT NULL,
    "created_by_user_id" UUID,
    "capacity_override" BOOLEAN NOT NULL DEFAULT false,
    "capacity_override_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_idempotency_keys" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "key_hash" CHAR(64) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "reservation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservation_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CheckConstraint
ALTER TABLE "reservations"
ADD CONSTRAINT "reservations_party_size_positive_check"
CHECK ("party_size" > 0);

-- CheckConstraint
ALTER TABLE "reservations"
ADD CONSTRAINT "reservations_capacity_override_reason_check"
CHECK (
    ("capacity_override" = false AND "capacity_override_reason" IS NULL)
    OR
    ("capacity_override" = true AND "capacity_override_reason" IS NOT NULL AND btrim("capacity_override_reason") <> '')
);

-- CheckConstraint
ALTER TABLE "reservations"
ADD CONSTRAINT "reservations_privacy_consent_check"
CHECK (
    "created_by_user_id" IS NOT NULL
    AND btrim("privacy_policy_version") <> ''
    AND (
        ("origin" = 'PHONE' AND "privacy_consent_method" = 'VERBAL')
        OR
        ("origin" = 'STAFF' AND "privacy_consent_method" = 'STAFF_RECORDED')
    )
);

-- CheckConstraint
ALTER TABLE "reservations"
ADD CONSTRAINT "reservations_cancellation_state_check"
CHECK (
    ("status" = 'CONFIRMED' AND "cancelled_at" IS NULL)
    OR
    ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL)
);

-- CheckConstraint
ALTER TABLE "reservation_idempotency_keys"
ADD CONSTRAINT "reservation_idempotency_keys_expiry_check"
CHECK ("expires_at" > "created_at");

-- CreateIndex
CREATE INDEX "reservations_capacity_lookup_idx" ON "reservations"("restaurant_id", "local_date", "service_type", "status", "arrival_time");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_idempotency_keys_reservation_id_key" ON "reservation_idempotency_keys"("reservation_id");

-- CreateIndex
CREATE INDEX "reservation_idempotency_keys_expires_at_idx" ON "reservation_idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_idempotency_keys_restaurant_key_hash_key" ON "reservation_idempotency_keys"("restaurant_id", "key_hash");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_idempotency_keys" ADD CONSTRAINT "reservation_idempotency_keys_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_idempotency_keys" ADD CONSTRAINT "reservation_idempotency_keys_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
