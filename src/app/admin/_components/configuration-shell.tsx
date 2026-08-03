import Link from "next/link";
import type { ReactNode } from "react";

const links = [
  { href: "/admin/configuration", label: "Impostazioni" },
  { href: "/admin/rooms", label: "Sale e tavoli" },
  { href: "/admin/schedules", label: "Orari settimanali" },
  { href: "/admin/special-dates", label: "Date speciali" },
] as const;

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
            Piccadilly Booking · Configurazione tecnica
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
            {title}
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-300 sm:text-base">
            {description}
          </p>
        </header>

        <nav
          aria-label="Configurazione ristorante"
          className="mt-5 flex flex-wrap gap-2"
        >
          {links.map((link) => (
            <Link
              className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm font-bold text-zinc-800 transition hover:border-orange-500 hover:text-orange-700"
              href={link.href}
              key={link.href}
            >
              {link.label}
            </Link>
          ))}
          <Link
            className="rounded-full px-4 py-2 text-sm font-bold text-zinc-600 hover:text-zinc-950"
            href="/dashboard"
          >
            Dashboard tecnica
          </Link>
        </nav>

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
    : status === "deleted"
      ? "Data speciale rimossa."
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

