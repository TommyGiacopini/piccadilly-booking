import Link from "next/link";

import { buttonClassName } from "@/app/_components/ui/button";
import { ExportPanel } from "@/app/dashboard/export-panel";
import { StaffAgenda } from "@/app/dashboard/staff-agenda";
import type { AvailabilityResult } from "@/modules/availability/domain/types";
import { getDashboardDay } from "@/modules/dashboard/application/dashboard-query";
import type { DashboardFilters } from "@/modules/dashboard/domain/dashboard-domain";
import { requireAuthenticatedUser } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface DashboardPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function italianDate(localDate: string): string {
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${localDate}T12:00:00.000Z`));
}

function dashboardHref(
  date: string,
  filters: DashboardFilters,
): string {
  const query = new URLSearchParams({
    date,
    service: filters.service,
    status: filters.status,
    origin: filters.origin,
    assignment: filters.assignment,
    finalRoom: filters.finalRoom,
  });
  return `/dashboard?${query.toString()}`;
}

function AvailabilityPanel(props: {
  label: string;
  availability: AvailabilityResult;
}) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-black tracking-widest text-orange-600 uppercase">
            Disponibilità residua
          </p>
          <h2 className="mt-1 text-xl font-black text-zinc-950">{props.label}</h2>
        </div>
        {props.availability.capacityLimit ? (
          <p className="text-sm font-bold text-zinc-500">
            limite {props.availability.capacityLimit} / finestra {props.availability.rollingWindowMinutes} min
          </p>
        ) : null}
      </div>

      {!props.availability.isOpen ? (
        <p className="mt-4 rounded-xl bg-zinc-100 p-4 font-bold text-zinc-600">
          Servizio chiuso
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-7">
          {props.availability.slots.map((slot) => (
            <div
              className={`rounded-xl border px-2 py-2 text-center ${
                slot.reason === "SLOT_IN_PAST"
                  ? "border-zinc-200 bg-zinc-100 text-zinc-400"
                  : slot.remainingCapacity === 0
                    ? "border-red-200 bg-red-50 text-red-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-900"
              }`}
              key={slot.time}
            >
              <p className="text-sm font-black">{slot.time}</p>
              <p className="text-xs font-bold">{slot.remainingCapacity} posti</p>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs leading-5 text-zinc-500">
        Margine minimo nelle finestre mobili che includono lo slot. Le cancellate non incidono.
      </p>
    </section>
  );
}

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps) {
  const user = await requireAuthenticatedUser("/dashboard");
  const query = await searchParams;
  const dashboard = await getDashboardDay({
    restaurantId: user.restaurantId,
    rawDate: single(query.date),
    rawService: single(query.service),
    rawStatus: single(query.status),
    rawOrigin: single(query.origin),
    rawAssignment: single(query.assignment),
    rawFinalRoom: single(query.finalRoom),
  });
  const hasSecondaryFilters =
    dashboard.filters.status !== "ALL" ||
    dashboard.filters.origin !== "ALL" ||
    dashboard.filters.assignment !== "ALL" ||
    dashboard.filters.finalRoom !== "ALL";

  return (
    <main className="min-h-screen min-w-0 pb-16">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto max-w-[90rem] px-4 py-6 sm:px-6 lg:px-8">
          <p className="text-xs font-semibold tracking-wide text-brand-primary uppercase">
            Dashboard operativa · {dashboard.restaurantName}
          </p>
          <h1 className="mt-1 text-heading-lg font-semibold text-text-primary">
            Agenda
          </h1>
          <h2 className="mt-1 text-lg font-medium text-text-secondary">
            {italianDate(dashboard.localDate)}
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            Giorno del ristorante in {dashboard.timezone}
          </p>
        </div>
      </header>

      <div className="mx-auto min-w-0 max-w-[90rem] px-4 py-5 sm:px-6 lg:px-8">
        {dashboard.invalidQuery ? (
          <p className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 font-bold text-amber-900" role="alert">
            Alcuni parametri non erano validi: sono stati applicati data e filtri sicuri.
          </p>
        ) : null}

        <nav
          className="flex min-w-0 flex-wrap items-end gap-3"
          aria-label="Navigazione data"
        >
          <Link
            className={buttonClassName("secondary")}
            href={dashboardHref(dashboard.previousDate, dashboard.filters)}
          >
            ← Giorno precedente
          </Link>
          <form className="flex min-w-0 flex-1 flex-wrap items-end gap-3" method="get">
            <label className="min-w-0 flex-1 text-sm font-medium text-text-secondary sm:max-w-64">
              Seleziona data
              <input
                className="mt-1 min-h-11 w-full min-w-0 rounded-control border border-border-strong bg-surface px-3 py-2 text-text-primary"
                defaultValue={dashboard.localDate}
                name="date"
                type="date"
              />
            </label>
            <input name="service" type="hidden" value={dashboard.filters.service} />
            <input name="status" type="hidden" value={dashboard.filters.status} />
            <input name="origin" type="hidden" value={dashboard.filters.origin} />
            <input name="assignment" type="hidden" value={dashboard.filters.assignment} />
            <input name="finalRoom" type="hidden" value={dashboard.filters.finalRoom} />
            <button className={buttonClassName("primary")} type="submit">
              Vai
            </button>
          </form>
          <Link
            className={buttonClassName("secondary")}
            href={dashboardHref(dashboard.nextDate, dashboard.filters)}
          >
            Giorno successivo →
          </Link>
        </nav>

        <form className="mt-5 grid gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-6" method="get">
          <input name="date" type="hidden" value={dashboard.localDate} />
          <label className="text-sm font-bold text-zinc-700">
            Servizio
            <select className="mt-1 block w-full rounded-xl border border-zinc-300 px-3 py-2.5 focus:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-100" defaultValue={dashboard.filters.service} name="service">
              <option value="ALL">Tutti</option>
              <option value="LUNCH">Pranzo</option>
              <option value="DINNER">Cena</option>
            </select>
          </label>
          <label className="text-sm font-bold text-zinc-700">
            Stato
            <select className="mt-1 block w-full rounded-xl border border-zinc-300 px-3 py-2.5 focus:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-100" defaultValue={dashboard.filters.status} name="status">
              <option value="ALL">Tutti</option>
              <option value="CONFIRMED">Confermate</option>
              <option value="CANCELLED">Cancellate</option>
            </select>
          </label>
          <label className="text-sm font-bold text-zinc-700">
            Origine
            <select className="mt-1 block w-full rounded-xl border border-zinc-300 px-3 py-2.5 focus:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-100" defaultValue={dashboard.filters.origin} name="origin">
              <option value="ALL">Tutte</option>
              <option value="PUBLIC">Pubblica</option>
              <option value="PHONE">Telefonica</option>
              <option value="STAFF">Staff</option>
            </select>
          </label>
          <label className="text-sm font-bold text-zinc-700">
            Assegnazione
            <select className="mt-1 block w-full rounded-xl border border-zinc-300 px-3 py-2.5 focus:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-100" data-testid="assignment-status-filter" defaultValue={dashboard.filters.assignment} name="assignment">
              <option value="ALL">Tutte</option>
              <option value="UNASSIGNED">Da assegnare</option>
              <option value="ASSIGNED">Assegnate</option>
            </select>
          </label>
          <label className="text-sm font-bold text-zinc-700">
            Sala definitiva
            <select className="mt-1 block w-full rounded-xl border border-zinc-300 px-3 py-2.5 focus:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-100" data-testid="final-room-filter" defaultValue={dashboard.filters.finalRoom} name="finalRoom">
              <option value="ALL">Tutte</option>
              {dashboard.rooms.map((room) => (
                <option key={room.code} value={room.code}>{room.name}</option>
              ))}
            </select>
          </label>
          <button className="self-end rounded-xl bg-orange-500 px-5 py-2.5 font-black text-white hover:bg-orange-600 focus:outline-none focus:ring-4 focus:ring-orange-200" type="submit">
            Applica filtri
          </button>
        </form>

        <div className="mt-5 min-w-0">
          <StaffAgenda
            emptyStateIsFiltered={hasSecondaryFilters}
            newReservationHref={`/dashboard/reservations/new?date=${dashboard.localDate}`}
            reservations={dashboard.reservations}
            summary={dashboard.summary}
            timezone={dashboard.timezone}
          />
        </div>

        <ExportPanel dashboardDate={dashboard.localDate} />

        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          <AvailabilityPanel label="Pranzo" availability={dashboard.availability.LUNCH} />
          <AvailabilityPanel label="Cena" availability={dashboard.availability.DINNER} />
        </div>

      </div>
    </main>
  );
}
