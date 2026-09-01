import type { Metadata } from "next";

import { StagingBanner } from "@/app/_components/staging-banner";
import { getAppEnvironment } from "@/shared/config/app-environment";

import "./globals.css";

export function generateMetadata(): Metadata {
  const isStaging = getAppEnvironment() === "staging";
  return {
    title: "Piccadilly Booking",
    description: "Fondamenta tecniche del sistema di prenotazione Piccadilly.",
    robots: isStaging
      ? { index: false, follow: false, noarchive: true }
      : undefined,
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it">
      <body>
        <StagingBanner />
        {children}
      </body>
    </html>
  );
}
