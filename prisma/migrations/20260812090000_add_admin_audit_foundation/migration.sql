-- M9-A administrative/authentication audit foundation and reversible special-date lifecycle.
ALTER TABLE "special_date_overrides"
ADD COLUMN "archived_at" TIMESTAMPTZ(3);

DROP INDEX "special_dates_restaurant_date_idx";
CREATE INDEX "special_dates_restaurant_date_archived_idx"
ON "special_date_overrides"("restaurant_id", "date", "archived_at");

CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "category" VARCHAR(32) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "actor_user_id" UUID,
    "actor_role" "UserRole",
    "entity_type" VARCHAR(64),
    "entity_id" UUID,
    "correlation_id" UUID NOT NULL,
    "previous_state" JSONB,
    "new_state" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_events_actor_check" CHECK (
        ("actor_user_id" IS NULL AND "actor_role" IS NULL)
        OR ("actor_user_id" IS NOT NULL AND "actor_role" IS NOT NULL)
    ),
    CONSTRAINT "audit_events_entity_check" CHECK (
        ("entity_type" IS NULL AND "entity_id" IS NULL)
        OR ("entity_type" IS NOT NULL AND "entity_id" IS NOT NULL)
    )
);

CREATE INDEX "audit_events_restaurant_created_idx"
ON "audit_events"("restaurant_id", "created_at");
CREATE INDEX "audit_events_category_action_idx"
ON "audit_events"("restaurant_id", "category", "action", "created_at");
CREATE INDEX "audit_events_actor_created_idx"
ON "audit_events"("actor_user_id", "created_at");

ALTER TABLE "audit_events"
ADD CONSTRAINT "audit_events_restaurant_id_fkey"
FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_events"
ADD CONSTRAINT "audit_events_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- This deterministic function is retained so PostgreSQL integration tests can
-- exercise the exact transformation used for legacy fixtures.
CREATE OR REPLACE FUNCTION m9a_minimize_reservation_audit_snapshot(
    snapshot JSONB,
    fallback_origin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
    preferences JSONB := NULL;
    food_requests JSONB := NULL;
    requests JSONB := '{}'::JSONB;
    room_code TEXT := NULL;
    legacy_preference_present BOOLEAN := FALSE;
    high_chair BOOLEAN := FALSE;
    stroller BOOLEAN := FALSE;
    accessibility BOOLEAN := FALSE;
    children BOOLEAN := FALSE;
    celiac BOOLEAN := FALSE;
    allergies_present BOOLEAN := FALSE;
    intolerances_present BOOLEAN := FALSE;
    celebration_present BOOLEAN := FALSE;
    animals BOOLEAN := FALSE;
    notes_present BOOLEAN := FALSE;
BEGIN
    IF jsonb_typeof(snapshot) <> 'object' THEN
        RETURN '{}'::JSONB;
    END IF;

    IF jsonb_typeof(snapshot->'requests') = 'object' THEN
        requests := snapshot->'requests';
    END IF;

    IF snapshot ? 'preferences' THEN
        BEGIN
            IF jsonb_typeof(snapshot->'preferences') = 'string' THEN
                preferences := (snapshot->>'preferences')::JSONB;
            ELSIF jsonb_typeof(snapshot->'preferences') = 'object' THEN
                preferences := snapshot->'preferences';
            END IF;
        EXCEPTION WHEN OTHERS THEN
            preferences := NULL;
        END;
    END IF;

    IF snapshot ? 'allergies' THEN
        BEGIN
            IF jsonb_typeof(snapshot->'allergies') = 'string' THEN
                food_requests := (snapshot->>'allergies')::JSONB;
            ELSIF jsonb_typeof(snapshot->'allergies') = 'object' THEN
                food_requests := snapshot->'allergies';
            END IF;
        EXCEPTION WHEN OTHERS THEN
            food_requests := NULL;
        END;
    END IF;

    room_code := NULLIF(
        COALESCE(requests->>'roomCode', preferences->>'roomCode', ''),
        ''
    );
    legacy_preference_present :=
        COALESCE(requests->>'legacyPreferencePresent', 'false') = 'true'
        OR NULLIF(COALESCE(preferences->>'legacyText', ''), '') IS NOT NULL;
    high_chair := COALESCE(requests->>'highChair', preferences->>'highChair', 'false') = 'true';
    stroller := COALESCE(requests->>'stroller', preferences->>'stroller', 'false') = 'true';
    accessibility := COALESCE(requests->>'accessibility', preferences->>'accessibility', 'false') = 'true';
    children := COALESCE(requests->>'children', preferences->>'children', 'false') = 'true';
    celiac := COALESCE(requests->>'celiac', food_requests->>'celiac', 'false') = 'true';
    allergies_present :=
        COALESCE(requests->>'allergiesPresent', 'false') = 'true'
        OR NULLIF(COALESCE(food_requests->>'allergies', food_requests->>'legacyText', ''), '') IS NOT NULL;
    intolerances_present :=
        COALESCE(requests->>'intolerancesPresent', 'false') = 'true'
        OR NULLIF(COALESCE(food_requests->>'intolerances', ''), '') IS NOT NULL;
    celebration_present :=
        COALESCE(requests->>'celebrationPresent', 'false') = 'true'
        OR NULLIF(COALESCE(preferences->>'celebration', ''), '') IS NOT NULL;
    animals := COALESCE(requests->>'animals', preferences->>'animals', 'false') = 'true';
    notes_present :=
        COALESCE(requests->>'notesPresent', 'false') = 'true'
        OR NULLIF(COALESCE(snapshot->>'notes', ''), '') IS NOT NULL;

    RETURN jsonb_strip_nulls(
        jsonb_build_object(
            'localDate', snapshot->'localDate',
            'serviceType', snapshot->'serviceType',
            'arrivalTime', snapshot->'arrivalTime',
            'partySize', snapshot->'partySize',
            'status', snapshot->'status',
            'origin', COALESCE(snapshot->'origin', to_jsonb(fallback_origin)),
            'version', snapshot->'version',
            'requests', jsonb_build_object(
                'roomCode', room_code,
                'legacyPreferencePresent', legacy_preference_present,
                'highChair', high_chair,
                'stroller', stroller,
                'accessibility', accessibility,
                'children', children,
                'celiac', celiac,
                'foodRequestsPresent', celiac OR allergies_present OR intolerances_present,
                'allergiesPresent', allergies_present,
                'intolerancesPresent', intolerances_present,
                'celebrationPresent', celebration_present,
                'animals', animals,
                'notesPresent', notes_present
            ),
            'capacityOverride', COALESCE(snapshot->'capacityOverride', 'false'::JSONB),
            'capacityOverrideReason', snapshot->'capacityOverrideReason',
            'capacityOverrideResult', snapshot->'capacityOverrideResult'
        )
    );
END;
$$;

UPDATE "reservation_audit_events"
SET
    "previous_state" = CASE
        WHEN "previous_state" IS NULL THEN NULL
        ELSE m9a_minimize_reservation_audit_snapshot(
            "previous_state",
            "actor_origin"::TEXT
        )
    END,
    "new_state" = m9a_minimize_reservation_audit_snapshot(
        "new_state",
        "actor_origin"::TEXT
    );
