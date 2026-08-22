-- ExtendEnum
ALTER TYPE "ReservationAuditAction" ADD VALUE 'ASSIGNED';
ALTER TYPE "ReservationAuditAction" ADD VALUE 'REASSIGNED';
ALTER TYPE "ReservationAuditAction" ADD VALUE 'UNASSIGNED';

-- Extend the existing state invariant to the minimized assignment snapshots.
ALTER TABLE "reservation_audit_events"
DROP CONSTRAINT "reservation_audit_events_state_check";

ALTER TABLE "reservation_audit_events"
ADD CONSTRAINT "reservation_audit_events_state_check" CHECK (
    ("action" = 'CREATED' AND "previous_state" IS NULL AND "new_state" IS NOT NULL)
    OR ("action" = 'UPDATED' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL)
    OR ("action" = 'CANCELLED' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL)
    OR ("action" = 'ASSIGNED' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL)
    OR ("action" = 'REASSIGNED' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL)
    OR ("action" = 'UNASSIGNED' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL)
);

-- Tenant-scoped alternate keys used by the new domain foreign keys.
CREATE UNIQUE INDEX "reservations_restaurant_id_id_key"
ON "reservations"("restaurant_id", "id");

CREATE UNIQUE INDEX "users_restaurant_id_id_key"
ON "users"("restaurant_id", "id");

CREATE UNIQUE INDEX "dining_tables_room_id_id_key"
ON "dining_tables"("room_id", "id");

-- CreateTable
CREATE TABLE "reservation_assignments" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "internal_notes" VARCHAR(1000),
    "assigned_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "cleared_at" TIMESTAMPTZ(3),

    CONSTRAINT "reservation_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reservation_assignments_internal_notes_check"
      CHECK ("internal_notes" IS NULL OR char_length("internal_notes") <= 1000)
);

-- CreateTable
CREATE TABLE "reservation_assignment_tables" (
    "restaurant_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "dining_table_id" UUID NOT NULL,

    CONSTRAINT "reservation_assignment_tables_pkey"
      PRIMARY KEY ("restaurant_id", "assignment_id", "dining_table_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reservation_assignments_restaurant_reservation_key"
ON "reservation_assignments"("restaurant_id", "reservation_id");

CREATE UNIQUE INDEX "reservation_assignments_restaurant_id_room_key"
ON "reservation_assignments"("restaurant_id", "id", "room_id");

CREATE INDEX "reservation_assignments_restaurant_cleared_idx"
ON "reservation_assignments"("restaurant_id", "cleared_at");

CREATE INDEX "reservation_assignments_restaurant_room_idx"
ON "reservation_assignments"("restaurant_id", "room_id");

CREATE INDEX "reservation_assignment_tables_restaurant_room_table_idx"
ON "reservation_assignment_tables"("restaurant_id", "room_id", "dining_table_id");

-- AddForeignKey
ALTER TABLE "reservation_assignments"
ADD CONSTRAINT "reservation_assignments_restaurant_reservation_fkey"
FOREIGN KEY ("restaurant_id", "reservation_id")
REFERENCES "reservations"("restaurant_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reservation_assignments"
ADD CONSTRAINT "reservation_assignments_restaurant_room_fkey"
FOREIGN KEY ("restaurant_id", "room_id")
REFERENCES "rooms"("restaurant_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reservation_assignments"
ADD CONSTRAINT "reservation_assignments_restaurant_assigned_by_fkey"
FOREIGN KEY ("restaurant_id", "assigned_by_user_id")
REFERENCES "users"("restaurant_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reservation_assignments"
ADD CONSTRAINT "reservation_assignments_restaurant_updated_by_fkey"
FOREIGN KEY ("restaurant_id", "updated_by_user_id")
REFERENCES "users"("restaurant_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reservation_assignment_tables"
ADD CONSTRAINT "reservation_assignment_tables_assignment_room_fkey"
FOREIGN KEY ("restaurant_id", "assignment_id", "room_id")
REFERENCES "reservation_assignments"("restaurant_id", "id", "room_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reservation_assignment_tables"
ADD CONSTRAINT "reservation_assignment_tables_restaurant_room_fkey"
FOREIGN KEY ("restaurant_id", "room_id")
REFERENCES "rooms"("restaurant_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reservation_assignment_tables"
ADD CONSTRAINT "reservation_assignment_tables_room_table_fkey"
FOREIGN KEY ("room_id", "dining_table_id")
REFERENCES "dining_tables"("room_id", "id")
ON DELETE RESTRICT ON UPDATE CASCADE;
