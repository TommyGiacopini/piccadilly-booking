import { AdminSectionNavigation } from "@/app/_components/staff/staff-shell";
import type { ReactNode } from "react";

export function ConfigurationShell({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <main className="min-h-screen px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="rounded-3xl bg-zinc-950 px-6 py-7 text-white sm:px-9">
          <p className="text-xs font-bold tracking-[0.2em] text-orange-400 uppercase">
            Piccadilly Booking · Area Admin
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
            {title}
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-300 sm:text-base">
            {description}
          </p>
        </header>

        <AdminSectionNavigation />

        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

export function StatusBanner({
  message,
  status,
}: {
  message?: string;
  status?: string;
}) {
  if (!status) {
    return null;
  }

  const isError = status === "error";
  const text = isError
    ? message || "Controlla i dati inseriti e riprova."
    : status === "archived"
      ? "Data speciale archiviata."
      : status === "reactivated"
        ? "Data speciale ripristinata."
        : "Configurazione salvata.";

  return (
    <div
      className={`mb-5 rounded-2xl border px-5 py-4 text-sm font-bold ${
        isError
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800"
      }`}
      role={isError ? "alert" : "status"}
    >
      {text}
    </div>
  );
}

export const fieldClassName =
  "mt-1.5 w-full rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-sm text-zinc-950 outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-100";

export const buttonClassName =
  "rounded-xl bg-zinc-950 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-orange-600 focus:outline-none focus:ring-4 focus:ring-orange-200";
