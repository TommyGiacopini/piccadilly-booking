ALTER TABLE "reservations"
  ALTER COLUMN "preferences" TYPE TEXT,
  ALTER COLUMN "allergies" TYPE TEXT;

ALTER TABLE "reservations"
  ADD COLUMN "children_count" INTEGER,
  ADD COLUMN "game_room_preference" BOOLEAN;

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_children_count_check" CHECK (
    "children_count" IS NULL OR
    ("children_count" >= 0 AND "children_count" <= "party_size")
  ),
  ADD CONSTRAINT "reservations_party_composition_check" CHECK (
    ("children_count" IS NULL AND "game_room_preference" IS NULL) OR
    ("children_count" IS NOT NULL AND "children_count" = 0 AND "game_room_preference" IS NULL) OR
    ("children_count" IS NOT NULL AND "children_count" > 0 AND "game_room_preference" IS NOT NULL)
  );
