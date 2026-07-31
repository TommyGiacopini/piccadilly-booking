import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Piccadilly Booking",
  description: "Fondamenta tecniche del sistema di prenotazione Piccadilly.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
