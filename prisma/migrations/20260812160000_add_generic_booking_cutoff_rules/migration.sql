-- M9-C generic public booking cutoff rules and fixed V1 timing invariants.
CREATE TABLE "booking_cutoff_rules" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "day_of_week" "DayOfWeek" NOT NULL,
    "service_type" "ServiceType" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "cutoff_time" TIME(0) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_cutoff_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "booking_cutoff_rules_restaurant_day_service_key"
ON "booking_cutoff_rules"("restaurant_id", "day_of_week", "service_type");

CREATE INDEX "booking_cutoff_rules_restaurant_enabled_idx"
ON "booking_cutoff_rules"("restaurant_id", "is_enabled", "day_of_week", "service_type");

ALTER TABLE "booking_cutoff_rules"
ADD CONSTRAINT "booking_cutoff_rules_restaurant_id_fkey"
FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "booking_cutoff_rules" (
    "id",
    "restaurant_id",
    "day_of_week",
    "service_type",
    "is_enabled",
    "cutoff_time",
    "created_at",
    "updated_at"
)
SELECT
    gen_random_uuid(),
    "restaurant_id",
    'FRIDAY'::"DayOfWeek",
    'DINNER'::"ServiceType",
    true,
    "friday_dinner_booking_cutoff",
    "created_at",
    "updated_at"
FROM "restaurant_booking_settings";

INSERT INTO "booking_cutoff_rules" (
    "id",
    "restaurant_id",
    "day_of_week",
    "service_type",
    "is_enabled",
    "cutoff_time",
    "created_at",
    "updated_at"
)
SELECT
    gen_random_uuid(),
    "restaurant_id",
    'SATURDAY'::"DayOfWeek",
    'DINNER'::"ServiceType",
    true,
    "saturday_dinner_booking_cutoff",
    "created_at",
    "updated_at"
FROM "restaurant_booking_settings";

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "restaurant_booking_settings" settings
        LEFT JOIN "booking_cutoff_rules" friday_rule
          ON friday_rule."restaurant_id" = settings."restaurant_id"
         AND friday_rule."day_of_week" = 'FRIDAY'::"DayOfWeek"
         AND friday_rule."service_type" = 'DINNER'::"ServiceType"
        LEFT JOIN "booking_cutoff_rules" saturday_rule
          ON saturday_rule."restaurant_id" = settings."restaurant_id"
         AND saturday_rule."day_of_week" = 'SATURDAY'::"DayOfWeek"
         AND saturday_rule."service_type" = 'DINNER'::"ServiceType"
        WHERE friday_rule."id" IS NULL
           OR saturday_rule."id" IS NULL
           OR friday_rule."is_enabled" IS NOT true
           OR saturday_rule."is_enabled" IS NOT true
           OR friday_rule."cutoff_time" <> settings."friday_dinner_booking_cutoff"
           OR saturday_rule."cutoff_time" <> settings."saturday_dinner_booking_cutoff"
    ) THEN
        RAISE EXCEPTION 'M9-C public booking cutoff backfill verification failed';
    END IF;
END;
$$;

ALTER TABLE "restaurant_booking_settings"
DROP COLUMN "friday_dinner_booking_cutoff",
DROP COLUMN "saturday_dinner_booking_cutoff";

UPDATE "weekly_service_schedules"
SET "slot_interval_minutes" = 15
WHERE "slot_interval_minutes" <> 15;

ALTER TABLE "weekly_service_schedules"
DROP CONSTRAINT "weekly_service_schedules_slot_check";

ALTER TABLE "weekly_service_schedules"
ADD CONSTRAINT "weekly_service_schedules_slot_check"
CHECK ("slot_interval_minutes" = 15);

UPDATE "restaurant_booking_settings"
SET "rolling_window_minutes" = 30
WHERE "rolling_window_minutes" <> 30;

ALTER TABLE "restaurant_booking_settings"
DROP CONSTRAINT "restaurant_booking_settings_window_check";

ALTER TABLE "restaurant_booking_settings"
ADD CONSTRAINT "restaurant_booking_settings_window_check"
CHECK ("rolling_window_minutes" = 30);
