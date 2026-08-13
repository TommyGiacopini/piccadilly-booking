-- CreateEnum
CREATE TYPE "RoomServiceAvailabilityPolicy" AS ENUM ('DEFAULT_AVAILABLE', 'EXPLICIT_ONLY');

-- Verify the fixed room catalog before assigning its immutable policy.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "rooms"
    WHERE "code" NOT IN ('sala-1', 'sala-2', 'sala-3', 'galleria', 'terrazzo')
  ) THEN
    RAISE EXCEPTION 'M9-D requires the approved fixed room catalog';
  END IF;

  IF EXISTS (
    SELECT "restaurant_id"
    FROM "rooms"
    GROUP BY "restaurant_id"
    HAVING COUNT(*) <> 5
       OR COUNT(*) FILTER (WHERE "code" = 'sala-1') <> 1
       OR COUNT(*) FILTER (WHERE "code" = 'sala-2') <> 1
       OR COUNT(*) FILTER (WHERE "code" = 'sala-3') <> 1
       OR COUNT(*) FILTER (WHERE "code" = 'galleria') <> 1
       OR COUNT(*) FILTER (WHERE "code" = 'terrazzo') <> 1
  ) THEN
    RAISE EXCEPTION 'M9-D requires exactly one approved room for each catalog code';
  END IF;
END $$;

-- AlterTable
ALTER TABLE "rooms"
ADD COLUMN "service_availability_policy" "RoomServiceAvailabilityPolicy" NOT NULL DEFAULT 'DEFAULT_AVAILABLE';

UPDATE "rooms"
SET "service_availability_policy" = 'EXPLICIT_ONLY'
WHERE "code" IN ('galleria', 'terrazzo');

-- CreateTable
CREATE TABLE "service_instances" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "service_type" "ServiceType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_instances_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_instances_version_check" CHECK ("version" > 0)
);

-- CreateTable
CREATE TABLE "service_room_availability" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "service_instance_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "is_available" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_room_availability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rooms_restaurant_id_id_key" ON "rooms"("restaurant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "service_instances_restaurant_date_service_key" ON "service_instances"("restaurant_id", "local_date", "service_type");

-- CreateIndex
CREATE UNIQUE INDEX "service_instances_restaurant_id_id_key" ON "service_instances"("restaurant_id", "id");

-- CreateIndex
CREATE INDEX "service_instances_restaurant_date_service_idx" ON "service_instances"("restaurant_id", "local_date", "service_type");

-- CreateIndex
CREATE UNIQUE INDEX "service_room_availability_instance_room_key" ON "service_room_availability"("service_instance_id", "room_id");

-- CreateIndex
CREATE INDEX "service_room_availability_restaurant_instance_idx" ON "service_room_availability"("restaurant_id", "service_instance_id");

-- CreateIndex
CREATE INDEX "service_room_availability_restaurant_room_idx" ON "service_room_availability"("restaurant_id", "room_id");

-- AddForeignKey
ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_room_availability" ADD CONSTRAINT "service_room_availability_restaurant_instance_fkey" FOREIGN KEY ("restaurant_id", "service_instance_id") REFERENCES "service_instances"("restaurant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_room_availability" ADD CONSTRAINT "service_room_availability_restaurant_room_fkey" FOREIGN KEY ("restaurant_id", "room_id") REFERENCES "rooms"("restaurant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
