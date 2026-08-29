import Link from "next/link";

import { ExportPanel } from "@/app/dashboard/export-panel";
import { ReservationAssignmentPanel } from "@/app/dashboard/reservation-assignment-panel";
import { ReservationActions } from "@/app/dashboard/reservation-actions";
import type { AvailabilityResult } from "@/modules/availability/domain/types";
import { getDashboardDay } from "@/modules/dashboard/application/dashboard-query";
import type {
  DashboardFilters,
  DashboardReservation,
} from "@/modules/dashboard/domain/dashboard-domain";
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

function originLabel(origin: DashboardReservation["origin"]): string {
  return origin === "PUBLIC"
    ? "Pubblica"
    : origin === "PHONE"
      ? "Telefonica"
      : "Staff";
}

function serviceLabel(service: DashboardReservation["serviceType"]): string {
  return service === "LUNCH" ? "Pranzo" : "Cena";
}

function requestBadges(reservation: DashboardReservation): string[] {
  return [
    reservation.highChair ? "Seggiolone" : null,
    reservation.stroller ? "Passeggino" : null,
    reservation.accessibility ? "Accessibilità" : null,
    reservation.children ? "Bambini" : null,
    reservation.celiac ? "Celiachia" : null,
    reservation.allergies ? "Allergie" : null,
    reservation.intolerances ? "Intolleranze" : null,
    reservation.celebration ? "Ricorrenza" : null,
    reservation.animals ? "Animali" : null,
  ].filter((value): value is string => value !== null);
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
  const summaryCards = [
    ["Prenotazioni confermate", dashboard.summary.confirmedReservations],
    ["Coperti confermati", dashboard.summary.confirmedCovers],
    ["Cancellazioni", dashboard.summary.cancellations],
    ["Pubbliche", dashboard.summary.origins.PUBLIC],
    ["Telefoniche", dashboard.summary.origins.PHONE],
    ["Staff", dashboard.summary.origins.STAFF],
    ["Richieste alimentari", dashboard.summary.foodRequests],
    ["Seggioloni", dashboard.summary.highChairs],
    ["Passeggini", dashboard.summary.strollers],
    ["Accessibilità", dashboard.summary.accessibilityRequests],
    ["Assegnate", dashboard.summary.assignedReservations],
    ["Da assegnare", dashboard.summary.unassignedReservations],
    ["Coperti da assegnare", dashboard.summary.unassignedCovers],
  ] as const;

  return (
    <main className="min-h-screen pb-16">
      <header className="bg-zinc-950 text-white">
        <div className="mx-auto max-w-7xl px-5 py-7 sm:px-8">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <p className="text-xs font-black tracking-[0.2em] text-orange-400 uppercase">
                Dashboard operativa · {dashboard.restaurantName}
              </p>
              <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">
                {italianDate(dashboard.localDate)}
              </h1>
              <p className="mt-2 text-sm text-zinc-400">
                Giorno del ristorante in {dashboard.timezone} · sessione {user.username} ({user.role})
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {user.role === "ADMIN" ? (
                <Link className="rounded-xl border border-zinc-700 px-5 py-3 font-bold text-white hover:border-zinc-500" href="/admin/users">
                  Utenti
                </Link>
              ) : null}
              <Link className="rounded-xl border border-zinc-700 px-5 py-3 font-bold text-white hover:border-zinc-500" href="/cambia-password">
                Password
              </Link>
              <Link
                className="rounded-xl bg-orange-500 px-5 py-3 font-black text-white transition hover:bg-orange-600 focus:outline-none focus:ring-4 focus:ring-orange-300"
                href={`/dashboard/reservations/new?date=${dashboard.localDate}`}
              >
                + Telefonica
              </Link>
              <form action="/api/auth/logout" method="post">
                <button
                  className="rounded-xl border border-zinc-700 px-5 py-3 font-bold text-white hover:border-zinc-500 focus:outline-none focus:ring-4 focus:ring-zinc-700"
                  type="submit"
                >
                  Logout
                </button>
              </form>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 py-6 sm:px-8">
        {dashboard.invalidQuery ? (
          <p className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 font-bold text-amber-900" role="alert">
            Alcuni parametri non erano validi: sono stati applicati data e filtri sicuri.
          </p>
        ) : null}

        <nav className="flex flex-wrap items-center gap-3" aria-label="Navigazione data">
          <Link
            className="rounded-xl border border-zinc-300 bg-white px-4 py-2.5 font-bold text-zinc-800 focus:outline-none focus:ring-4 focus:ring-orange-100"
            href={dashboardHref(dashboard.previousDate, dashboard.filters)}
          >
            ← Giorno precedente
          </Link>
          <form className="flex flex-wrap items-end gap-3" method="get">
            <label className="text-sm font-bold text-zinc-700">
              Seleziona data
              <input
                className="ml-2 rounded-xl border border-zinc-300 bg-white px-3 py-2.5 focus:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-100"
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
            <button className="rounded-xl bg-zinc-950 px-4 py-2.5 font-bold text-white focus:outline-none focus:ring-4 focus:ring-orange-200" type="submit">
              Vai
            </button>
          </form>
          <Link
            className="rounded-xl border border-zinc-300 bg-white px-4 py-2.5 font-bold text-zinc-800 focus:outline-none focus:ring-4 focus:ring-orange-100"
            href={dashboardHref(dashboard.nextDate, dashboard.filters)}
          >
            Giorno successivo →
          </Link>
        </nav>

        <ExportPanel dashboardDate={dashboard.localDate} />

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

        <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7" aria-label="Riepilogo giornata">
          {summaryCards.map(([label, value]) => (
            <article className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm" data-summary-label={label} key={label}>
              <p className="text-2xl font-black text-zinc-950">{value}</p>
              <p className="mt-1 text-xs font-bold leading-4 text-zinc-500">{label}</p>
            </article>
          ))}
        </section>

        <section className="mt-5 rounded-2xl border border-orange-200 bg-orange-50 p-5" data-testid="final-room-covers">
          <h2 className="font-black text-orange-950">Coperti per sala definitiva</h2>
          <p className="mt-1 text-sm text-orange-900">
            Conteggio operativo delle sole prenotazioni confermate con assegnazione attiva.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {dashboard.summary.finalRoomCovers.map((room) => (
              <span className="rounded-full bg-white px-3 py-1.5 text-sm font-bold text-zinc-800" key={room.code}>
                {room.label}: {room.covers}
              </span>
            ))}
          </div>
        </section>

        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          <AvailabilityPanel label="Pranzo" availability={dashboard.availability.LUNCH} />
          <AvailabilityPanel label="Cena" availability={dashboard.availability.DINNER} />
        </div>

        <section className="mt-8">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-black tracking-widest text-orange-600 uppercase">Elenco operativo</p>
              <h2 className="mt-1 text-2xl font-black text-zinc-950">Prenotazioni ({dashboard.reservations.length})</h2>
            </div>
          </div>

          {dashboard.reservations.length === 0 ? (
            <p className="mt-4 rounded-2xl border border-zinc-200 bg-white p-8 text-center font-bold text-zinc-500">
              Nessuna prenotazione per i filtri selezionati.
            </p>
          ) : (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              {dashboard.reservations.map((reservation) => {
                const badges = requestBadges(reservation);
                return (
                  <article
                    className={`rounded-2xl border p-5 shadow-sm ${
                      reservation.status === "CANCELLED"
                        ? "border-zinc-300 bg-zinc-100 opacity-75"
                        : "border-zinc-200 bg-white"
                    }`}
                    data-reservation-id={reservation.id}
                    key={reservation.id}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-black text-orange-600">
                          {serviceLabel(reservation.serviceType)} · {reservation.arrivalTime}
                        </p>
                        <h3 className="mt-1 text-xl font-black text-zinc-950">
                          {reservation.customerFirstName} {reservation.customerLastName}
                        </h3>
                        <p className="mt-1 font-bold text-zinc-600">
                          {reservation.partySize} {reservation.partySize === 1 ? "persona" : "persone"}
                        </p>
                      </div>
                      <span className={`rounded-full px-3 py-1 text-xs font-black ${reservation.status === "CONFIRMED" ? "bg-emerald-100 text-emerald-900" : "bg-zinc-300 text-zinc-800"}`}>
                        {reservation.status === "CONFIRMED" ? "Confermata" : "Cancellata"}
                      </span>
                    </div>

                    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="font-bold text-zinc-500">Origine</dt>
                        <dd className="font-bold text-zinc-950">{originLabel(reservation.origin)}</dd>
                      </div>
                      <div>
                        <dt className="font-bold text-zinc-500">Preferenza cliente</dt>
                        <dd className="font-bold text-zinc-950" data-testid="customer-room-preference">{reservation.preferredRoom} <span className="font-normal text-zinc-500">(non definitiva)</span></dd>
                      </div>
                      <div>
                        <dt className="font-bold text-zinc-500">Telefono</dt>
                        <dd><a className="font-bold text-zinc-950 underline decoration-orange-400 underline-offset-4" href={`tel:${reservation.customerPhone}`}>{reservation.customerPhone}</a></dd>
                      </div>
                      <div>
                        <dt className="font-bold text-zinc-500">Inserita</dt>
                        <dd className="font-bold text-zinc-950">{new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short", timeZone: dashboard.timezone }).format(new Date(reservation.createdAt))}</dd>
                      </div>
                      {reservation.updatedAt !== reservation.createdAt ? (
                        <div>
                          <dt className="font-bold text-zinc-500">Ultimo aggiornamento</dt>
                          <dd className="font-bold text-zinc-950">{new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short", timeZone: dashboard.timezone }).format(new Date(reservation.updatedAt))}</dd>
                        </div>
                      ) : null}
                    </dl>

                    {badges.length > 0 ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {badges.map((badge) => <span className="rounded-full bg-orange-100 px-3 py-1 text-xs font-black text-orange-900" key={badge}>{badge}</span>)}
                      </div>
                    ) : null}

                    {reservation.allergies || reservation.intolerances || reservation.celebration || reservation.notes ? (
                      <div className="mt-4 space-y-2 rounded-xl bg-zinc-50 p-4 text-sm text-zinc-700">
                        {reservation.allergies ? <p><strong>Allergie:</strong> {reservation.allergies}</p> : null}
                        {reservation.intolerances ? <p><strong>Intolleranze:</strong> {reservation.intolerances}</p> : null}
                        {reservation.celebration ? <p><strong>Ricorrenza:</strong> {reservation.celebration}</p> : null}
                        {reservation.notes ? <p><strong>Note:</strong> {reservation.notes}</p> : null}
                      </div>
                    ) : null}

                    {reservation.overrideApplied ? (
                      <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-amber-950">
                        Override capacità: {reservation.overrideReason}
                      </p>
                    ) : null}

                    {reservation.notificationHealth === "NOT_DELIVERED" ? (
                      <p className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-black text-red-800" data-testid="notification-not-delivered">
                        Notifica non consegnata
                      </p>
                    ) : reservation.notificationHealth === "PARTIAL_SUCCESS" ? (
                      <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-black text-amber-900" data-testid="notification-partial-success">
                        Notifica consegnata soltanto su un canale
                      </p>
                    ) : null}

                    <section className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4" data-testid="assignment-summary">
                      <p className="text-xs font-black tracking-wider text-zinc-500 uppercase">
                        Assegnazione definitiva
                      </p>
                      {reservation.assignment ? (
                        <div className="mt-2 space-y-1 text-sm text-zinc-800">
                          <p className="font-black" data-testid="final-room-name">
                            {reservation.assignment.roomName}
                          </p>
                          <p className="font-bold" data-testid="assigned-table-names">
                            {reservation.assignment.tableCount === 1 ? "Tavolo" : "Tavoli"}: {reservation.assignment.tableNames.join(", ")}
                          </p>
                          {reservation.assignment.internalNotesPresent ? (
                            <p className="font-bold text-violet-800">Note interne presenti</p>
                          ) : null}
                          {reservation.assignment.hasInactiveReferences || reservation.assignment.hasUnavailableRoomReference ? (
                            <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-2 font-bold text-amber-950" data-testid="assignment-grandfathering-warning">
                              Riferimento grandfathered:
                              {reservation.assignment.hasInactiveReferences ? " sala o tavolo inattivo" : ""}
                              {reservation.assignment.hasInactiveReferences && reservation.assignment.hasUnavailableRoomReference ? ";" : ""}
                              {reservation.assignment.hasUnavailableRoomReference ? " sala indisponibile per il servizio" : ""}.
                            </p>
                          ) : null}
                          {reservation.status === "CANCELLED" ? (
                            <p className="font-bold text-zinc-600">Storico, escluso dai conteggi operativi.</p>
                          ) : null}
                        </div>
                      ) : reservation.status === "CONFIRMED" ? (
                        <p className="mt-2 inline-flex rounded-full bg-red-100 px-3 py-1 text-sm font-black text-red-800" data-testid="unassigned-badge">
                          DA ASSEGNARE
                        </p>
                      ) : (
                        <p className="mt-2 text-sm font-bold text-zinc-500">
                          Nessuna assegnazione storica.
                        </p>
                      )}
                    </section>

                    <ReservationAssignmentPanel
                      cancelled={reservation.status === "CANCELLED"}
                      hasAssignment={reservation.assignment !== null}
                      reservationId={reservation.id}
                    />

                    <ReservationActions
                      cancelled={reservation.status === "CANCELLED"}
                      reservationId={reservation.id}
                      version={reservation.version}
                    />
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
