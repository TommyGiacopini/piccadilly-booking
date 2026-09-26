import type { Metadata } from "next";
import localFont from "next/font/local";

import { StagingBanner } from "@/app/_components/staging-banner";
import { getAppEnvironment } from "@/shared/config/app-environment";

import "./globals.css";

const inter = localFont({
  src: [
    {
      path: "./fonts/Inter-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/Inter-Medium.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/Inter-SemiBold.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "./fonts/Inter-Bold.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--font-inter",
  display: "swap",
  fallback: ["Segoe UI", "Arial", "Helvetica", "sans-serif"],
});

export function generateMetadata(): Metadata {
  const isStaging = getAppEnvironment() === "staging";
  return {
    title: {
      default: "Piccadilly Booking",
      template: "%s · Piccadilly Booking",
    },
    description: "Prenotazioni online e area riservata Piccadilly.",
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
    <html className={inter.variable} lang="it">
      <body>
        <StagingBanner />
        {children}
      </body>
    </html>
  );
}
