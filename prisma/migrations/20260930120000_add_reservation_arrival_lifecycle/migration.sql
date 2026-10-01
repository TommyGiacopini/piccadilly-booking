-- ExtendEnum
ALTER TYPE "ReservationAuditAction" ADD VALUE 'ARRIVAL_RECORDED';
ALTER TYPE "ReservationAuditAction" ADD VALUE 'ARRIVAL_REVERTED';

-- AddColumn
ALTER TABLE "reservations"
ADD COLUMN "arrived_at" TIMESTAMPTZ(3);

-- Extend the existing audit state invariant to minimized arrival snapshots.
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
    OR ("action" = 'ARRIVAL_RECORDED' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL)
    OR ("action" = 'ARRIVAL_REVERTED' AND "previous_state" IS NOT NULL AND "new_state" IS NOT NULL)
);
