import type { Metadata } from "next";

import { PublicBookingForm } from "@/app/prenota/public-booking-form";
import { getPublicSettings } from "@/modules/configuration/application/public-settings-service";
import { resolvePublicLocale } from "@/modules/configuration/domain/public-settings";
import { resolvePublicBookingConfig } from "@/shared/config/public-booking-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Prenota | Piccadilly",
  description: "Prenotazione online del Risto Pizza Piccadilly.",
};

export default async function PublicBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const { lang } = await searchParams;
  const initialLanguage = resolvePublicLocale(lang);
  const restaurantId = resolvePublicBookingConfig().restaurantId;
  const settings = await getPublicSettings(restaurantId);

  if (!settings) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-white">
        <p role="status">Configurazione pubblica non disponibile.</p>
      </main>
    );
  }

  return (
    <PublicBookingForm
      contacts={settings.contacts}
      contents={settings.contents}
      initialLanguage={initialLanguage}
    />
  );
}
