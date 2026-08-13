import type { Metadata } from "next";

import { PersonalReservation } from "@/app/p/[token]/personal-reservation";
import { getPublicSettings } from "@/modules/configuration/application/public-settings-service";
import { resolvePublicLocale } from "@/modules/configuration/domain/public-settings";
import { resolvePublicBookingConfig } from "@/shared/config/public-booking-config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Gestisci prenotazione | Piccadilly",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
};

export default async function PersonalReservationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { token } = await params;
  const { lang } = await searchParams;
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
    <PersonalReservation
      contacts={settings.contacts}
      contents={settings.contents}
      initialLanguage={resolvePublicLocale(lang)}
      token={token}
    />
  );
}
