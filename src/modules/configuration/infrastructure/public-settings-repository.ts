import "server-only";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type {
  PublicContacts,
  PublicContentKey,
  PublicContentLocale,
  PublicContentSet,
} from "@/modules/configuration/domain/public-settings";

export type PublicSettingsTransactionClient = Prisma.TransactionClient;
export type PublicSettingsReadClient = Pick<
  PrismaClient,
  "restaurant" | "restaurantPublicSettings" | "publicContent"
>;

export async function readPublicSettingsContext(
  client: PublicSettingsReadClient,
  restaurantId: string,
) {
  return client.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      timezone: true,
      publicSettings: true,
      publicContents: {
        orderBy: [{ locale: "asc" }, { contentKey: "asc" }],
      },
      bookingSettings: {
        select: { managementLinkDurationHours: true },
      },
    },
  });
}

export async function upsertPublicContacts(
  client: PublicSettingsTransactionClient,
  restaurantId: string,
  contacts: PublicContacts,
): Promise<void> {
  await client.restaurantPublicSettings.upsert({
    where: { restaurantId },
    create: { restaurantId, ...contacts },
    update: contacts,
  });
}

export async function upsertPublicContentSet(
  client: PublicSettingsTransactionClient,
  restaurantId: string,
  contents: PublicContentSet,
): Promise<void> {
  for (const [locale, localized] of Object.entries(contents) as Array<
    [PublicContentLocale, PublicContentSet[PublicContentLocale]]
  >) {
    for (const [contentKey, contentText] of Object.entries(localized) as Array<
      [PublicContentKey, string]
    >) {
      await client.publicContent.upsert({
        where: {
          restaurantId_locale_contentKey: {
            restaurantId,
            locale,
            contentKey,
          },
        },
        create: { restaurantId, locale, contentKey, contentText },
        update: { contentText },
      });
    }
  }
}

export async function updateManagementLinkDuration(
  client: PublicSettingsTransactionClient,
  restaurantId: string,
  managementLinkDurationHours: number,
): Promise<void> {
  const result = await client.restaurantBookingSettings.updateMany({
    where: { restaurantId },
    data: { managementLinkDurationHours },
  });
  if (result.count !== 1) {
    throw new Error("Restaurant booking settings are not available.");
  }
}
