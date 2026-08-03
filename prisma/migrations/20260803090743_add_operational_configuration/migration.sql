-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('LUNCH', 'DINNER');

-- CreateEnum
CREATE TYPE "DayOfWeek" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateEnum
CREATE TYPE "SpecialDateScope" AS ENUM ('ALL', 'LUNCH', 'DINNER');

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "rooms_display_order_check" CHECK ("display_order" >= 0)
);

-- CreateTable
CREATE TABLE "dining_tables" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "minimum_seats" INTEGER NOT NULL,
    "maximum_seats" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dining_tables_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dining_tables_seats_check" CHECK ("minimum_seats" > 0 AND "maximum_seats" >= "minimum_seats"),
    CONSTRAINT "dining_tables_display_order_check" CHECK ("display_order" >= 0)
);

-- CreateTable
CREATE TABLE "weekly_service_schedules" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "day_of_week" "DayOfWeek" NOT NULL,
    "service_type" "ServiceType" NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "slot_interval_minutes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "weekly_service_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "weekly_service_schedules_time_check" CHECK ("start_time" < "end_time"),
    CONSTRAINT "weekly_service_schedules_slot_check" CHECK ("slot_interval_minutes" > 0)
);

-- CreateTable
CREATE TABLE "restaurant_booking_settings" (
    "restaurant_id" UUID NOT NULL,
    "rolling_capacity_covers" INTEGER NOT NULL,
    "rolling_window_minutes" INTEGER NOT NULL,
    "lunch_modification_cutoff" TIME(0) NOT NULL,
    "dinner_modification_cutoff" TIME(0) NOT NULL,
    "friday_dinner_booking_cutoff" TIME(0) NOT NULL,
    "saturday_dinner_booking_cutoff" TIME(0) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "restaurant_booking_settings_pkey" PRIMARY KEY ("restaurant_id"),
    CONSTRAINT "restaurant_booking_settings_capacity_check" CHECK ("rolling_capacity_covers" > 0),
    CONSTRAINT "restaurant_booking_settings_window_check" CHECK ("rolling_window_minutes" = 30)
);

-- CreateTable
CREATE TABLE "special_date_overrides" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "scope" "SpecialDateScope" NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "special_start_time" TIME(0),
    "special_end_time" TIME(0),
    "special_capacity_covers" INTEGER,
    "operational_notes" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "special_date_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "special_date_overrides_capacity_check" CHECK ("special_capacity_covers" IS NULL OR "special_capacity_covers" > 0),
    CONSTRAINT "special_date_overrides_time_check" CHECK (
        ("special_start_time" IS NULL AND "special_end_time" IS NULL)
        OR ("special_start_time" IS NOT NULL AND "special_end_time" IS NOT NULL AND "special_start_time" < "special_end_time")
    ),
    CONSTRAINT "special_date_overrides_closed_values_check" CHECK (
        NOT "is_closed"
        OR ("special_start_time" IS NULL AND "special_end_time" IS NULL AND "special_capacity_covers" IS NULL)
    )
);

-- CreateIndex
CREATE INDEX "rooms_restaurant_active_order_idx" ON "rooms"("restaurant_id", "is_active", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_restaurant_id_code_key" ON "rooms"("restaurant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_restaurant_id_name_key" ON "rooms"("restaurant_id", "name");

-- CreateIndex
CREATE INDEX "dining_tables_room_active_order_idx" ON "dining_tables"("room_id", "is_active", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "dining_tables_room_id_name_key" ON "dining_tables"("room_id", "name");

-- CreateIndex
CREATE INDEX "weekly_schedules_restaurant_service_enabled_idx" ON "weekly_service_schedules"("restaurant_id", "service_type", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_schedules_restaurant_day_service_key" ON "weekly_service_schedules"("restaurant_id", "day_of_week", "service_type");

-- CreateIndex
CREATE INDEX "special_dates_restaurant_date_idx" ON "special_date_overrides"("restaurant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "special_dates_restaurant_date_scope_key" ON "special_date_overrides"("restaurant_id", "date", "scope");

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_service_schedules" ADD CONSTRAINT "weekly_service_schedules_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_booking_settings" ADD CONSTRAINT "restaurant_booking_settings_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_date_overrides" ADD CONSTRAINT "special_date_overrides_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
