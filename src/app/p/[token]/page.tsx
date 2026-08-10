import type { Metadata } from "next";

import { PersonalReservation } from "@/app/p/[token]/personal-reservation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Gestisci prenotazione | Piccadilly",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
};

export default async function PersonalReservationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <PersonalReservation token={token} />;
}
