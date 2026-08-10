import type { Metadata } from "next";

import { PublicBookingForm } from "@/app/prenota/public-booking-form";

export const metadata: Metadata = {
  title: "Prenota | Piccadilly",
  description: "Prenotazione online del Risto Pizza Piccadilly.",
};

export default function PublicBookingPage() {
  return <PublicBookingForm />;
}
