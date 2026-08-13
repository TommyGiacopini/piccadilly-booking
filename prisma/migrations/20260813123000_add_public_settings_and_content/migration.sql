-- CreateEnum
CREATE TYPE "PublicContentLocale" AS ENUM ('IT', 'EN');

-- CreateEnum
CREATE TYPE "PublicContentKey" AS ENUM (
  'BOOKING_PAGE_TITLE',
  'BOOKING_PAGE_INTRO',
  'UNAVAILABLE_MESSAGE',
  'CONTACT_PROMPT',
  'CONFIRMATION_MESSAGE',
  'MANAGEMENT_PAGE_TITLE',
  'MANAGEMENT_PAGE_INTRO'
);

-- CreateTable
CREATE TABLE "restaurant_public_settings" (
  "restaurant_id" UUID NOT NULL,
  "public_phone" VARCHAR(16) NOT NULL,
  "public_booking_base_url" VARCHAR(255) NOT NULL,
  "public_email" VARCHAR(254),
  "whatsapp_number" VARCHAR(16),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "restaurant_public_settings_pkey" PRIMARY KEY ("restaurant_id"),
  CONSTRAINT "restaurant_public_settings_phone_check"
    CHECK ("public_phone" ~ '^\+[0-9]{8,15}$'),
  CONSTRAINT "restaurant_public_settings_whatsapp_check"
    CHECK ("whatsapp_number" IS NULL OR "whatsapp_number" ~ '^\+[0-9]{8,15}$'),
  CONSTRAINT "restaurant_public_settings_booking_url_check"
    CHECK (
      "public_booking_base_url" ~ '^https://[^/?#]+/$'
      AND "public_booking_base_url" !~ '@'
    )
);

-- CreateTable
CREATE TABLE "public_contents" (
  "id" UUID NOT NULL,
  "restaurant_id" UUID NOT NULL,
  "locale" "PublicContentLocale" NOT NULL,
  "content_key" "PublicContentKey" NOT NULL,
  "content_text" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "public_contents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_contents_text_length_check"
    CHECK (
      char_length("content_text") BETWEEN 1 AND
        CASE
          WHEN "content_key" IN ('BOOKING_PAGE_TITLE', 'MANAGEMENT_PAGE_TITLE') THEN 120
          ELSE 1000
        END
    ),
  CONSTRAINT "public_contents_text_control_check"
    CHECK (translate("content_text", E'\n', '') !~ '[[:cntrl:]]')
);

-- CreateIndex
CREATE INDEX "restaurant_public_settings_restaurant_idx"
  ON "restaurant_public_settings"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "public_contents_restaurant_locale_key_key"
  ON "public_contents"("restaurant_id", "locale", "content_key");

-- CreateIndex
CREATE INDEX "public_contents_restaurant_locale_key_idx"
  ON "public_contents"("restaurant_id", "locale", "content_key");

-- AddForeignKey
ALTER TABLE "restaurant_public_settings"
  ADD CONSTRAINT "restaurant_public_settings_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public_contents"
  ADD CONSTRAINT "public_contents_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
