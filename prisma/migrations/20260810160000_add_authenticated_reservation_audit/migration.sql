-- AlterTable
ALTER TABLE "reservation_audit_events"
ADD COLUMN "actor_user_id" UUID,
ADD COLUMN "actor_role" "UserRole",
ADD COLUMN "capacity_override" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "capacity_override_reason" VARCHAR(500);

-- CheckConstraint
ALTER TABLE "reservation_audit_events"
ADD CONSTRAINT "reservation_audit_events_actor_check"
CHECK (
    (
        "actor_origin" = 'PUBLIC'
        AND "actor_user_id" IS NULL
        AND "actor_role" IS NULL
    )
    OR
    (
        "actor_origin" IN ('PHONE', 'STAFF')
        AND "actor_user_id" IS NOT NULL
        AND "actor_role" IS NOT NULL
    )
);

-- CheckConstraint
ALTER TABLE "reservation_audit_events"
ADD CONSTRAINT "reservation_audit_events_override_check"
CHECK (
    ("capacity_override" = false AND "capacity_override_reason" IS NULL)
    OR
    (
        "capacity_override" = true
        AND "capacity_override_reason" IS NOT NULL
        AND btrim("capacity_override_reason") <> ''
    )
);

-- CreateIndex
CREATE INDEX "reservation_audit_events_actor_created_idx"
ON "reservation_audit_events"("actor_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "reservation_audit_events"
ADD CONSTRAINT "reservation_audit_events_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
