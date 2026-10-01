"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { buttonClassName } from "@/app/_components/ui/button";
import { ReservationAssignmentPanel } from "@/app/dashboard/reservation-assignment-panel";
import { ReservationArrivalControl } from "@/app/dashboard/reservation-arrival-control";
import { ReservationActions } from "@/app/dashboard/reservation-actions";
import type {
  DashboardReservation,
  DashboardSummary,
} from "@/modules/dashboard/domain/dashboard-domain";
import {
  DEFAULT_STAFF_AGENDA_ORDER,
  selectStaffAgendaReservations,
  type StaffAgendaOrder,
} from "@/modules/dashboard/domain/staff-agenda";
import { reservationArrivalUiState } from "@/modules/reservations/domain/reservation-arrival";

type ArrivalOverride = { version: number; arrivedAt: string | null };

function reconcileArrivalOverrides(
  current: Record<string, ArrivalOverride>,
  reservations: DashboardReservation[],
): Record<string, ArrivalOverride> {
  const serverVersions = new Map(
    reservations.map((reservation) => [reservation.id, reservation.version]),
  );
  const entries = Object.entries(current);
  const retained = entries.filter(([reservationId, override]) => {
    const serverVersion = serverVersions.get(reservationId);
    return serverVersion !== undefined && serverVersion < override.version;
  });

  return retained.length === entries.length
    ? current
    : Object.fromEntries(retained);
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

function AgendaSummary({
  historical,
  summary,
}: {
  historical: boolean;
  summary: DashboardSummary;
}) {
  const items = [
    ["Prenotazioni confermate", summary.confirmedReservations],
    ["Coperti confermati", summary.confirmedCovers],
    ["Coperti arrivati", summary.arrivedCovers],
    [
      historical ? "Coperti senza arrivo registrato" : "Coperti attesi",
      summary.expectedCovers,
    ],
    ["Assegnate", summary.assignedReservations],
    ["Da assegnare", summary.unassignedReservations],
    ["Coperti da assegnare", summary.unassignedCovers],
    ["Cancellazioni", summary.cancellations],
  ] as const;

  return (
    <section
      aria-label="Riepilogo operativo"
      className="border-y border-border bg-surface"
    >
      <dl className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 xl:grid-cols-8 xl:divide-y-0">
        {items.map(([label, value]) => (
          <div
            className="min-w-0 px-3 py-3 sm:px-4"
            data-summary-label={label}
            key={label}
          >
            <dt className="text-xs font-medium text-text-muted">{label}</dt>
            <dd className="mt-0.5 tabular-nums text-heading-sm font-semibold text-text-primary">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <div
        className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-xs text-text-secondary"
        data-testid="final-room-covers"
      >
        <span className="font-semibold text-text-primary">Coperti per sala:</span>
        {summary.finalRoomCovers.map((room) => (
          <span className="tabular-nums" key={room.code}>
            {room.label}: {room.covers}
          </span>
        ))}
      </div>
    </section>
  );
}

function ReservationAgendaRow({
  reservation,
  historical,
  onArrivalCommitted,
  timezone,
}: {
  reservation: DashboardReservation;
  historical: boolean;
  onArrivalCommitted: (result: {
    reservationId: string;
    version: number;
    arrivedAt: string | null;
  }) => void;
  timezone: string;
}) {
  const badges = requestBadges(reservation);
  const insertedAt = new Intl.DateTimeFormat("it-IT", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(reservation.createdAt));
  const updatedAt = new Intl.DateTimeFormat("it-IT", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(reservation.updatedAt));
  const arrivalState = reservationArrivalUiState({
    arrivedAt: reservation.arrivedAt,
    status: reservation.status,
    isHistorical: historical,
  });

  return (
    <article
      className={`min-w-0 rounded-surface border bg-surface ${
        reservation.status === "CANCELLED"
          ? "border-border-strong bg-surface-muted"
          : "border-border"
      }`}
      data-reservation-id={reservation.id}
      data-reservation-version={reservation.version}
    >
      <div className="grid min-w-0 gap-3 border-b border-border px-4 py-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(7rem,.45fr)_minmax(8rem,.55fr)_auto] lg:items-center">
        <div className="min-w-0">
          <h3 className="[overflow-wrap:anywhere] text-lg font-semibold text-text-primary">
            {reservation.customerFirstName} {reservation.customerLastName}
          </h3>
          <p className="mt-0.5 text-xs text-text-muted">
            {originLabel(reservation.origin)} · inserita {insertedAt}
          </p>
        </div>

        <div>
          <p className="tabular-nums text-lg font-semibold text-text-primary">
            {reservation.partySize}
          </p>
          <p className="text-xs text-text-muted">
            {reservation.partySize === 1 ? "coperto" : "coperti"}
          </p>
        </div>

        <div>
          <p className="tabular-nums text-lg font-semibold text-text-primary">
            {reservation.arrivalTime}
          </p>
          <p className="text-xs text-text-muted">
            {serviceLabel(reservation.serviceType)} · orario di arrivo
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <span
            className={`w-fit rounded-full px-2.5 py-1 text-xs font-semibold ${
              reservation.status === "CONFIRMED"
                ? "bg-success/10 text-success"
                : "bg-border text-text-secondary"
            }`}
          >
            {reservation.status === "CONFIRMED" ? "Confermata" : "Cancellata"}
          </span>
          <span
            className={`w-fit rounded-full border px-2.5 py-1 text-xs font-semibold ${
              arrivalState === "ARRIVED"
                ? "border-success/30 bg-success/10 text-success"
                : arrivalState === "EXPECTED"
                  ? "border-border-strong bg-surface-muted text-text-primary"
                  : "border-border bg-surface-muted text-text-muted"
            }`}
            data-testid="arrival-state"
          >
            {arrivalState === "ARRIVED"
              ? "ARRIVATO"
              : arrivalState === "EXPECTED"
                ? "ATTESO"
                : "ARRIVO NON REGISTRATO"}
          </span>
        </div>
      </div>

      <div className="grid min-w-0 gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <dl className="grid min-w-0 gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="font-medium text-text-muted">Sala definitiva</dt>
              <dd className="mt-0.5 min-w-0 font-semibold text-text-primary">
                {reservation.assignment ? (
                  <span
                    className="[overflow-wrap:anywhere]"
                    data-testid="final-room-name"
                  >
                    {reservation.assignment.roomName}
                  </span>
                ) : reservation.status === "CONFIRMED" ? (
                  <span
                    className="inline-flex rounded-full border border-border bg-surface-muted px-2.5 py-1 text-xs text-text-secondary"
                    data-testid="unassigned-badge"
                  >
                    DA ASSEGNARE
                  </span>
                ) : (
                  "Non assegnata"
                )}
              </dd>
            </div>

            <div className="min-w-0">
              <dt className="font-medium text-text-muted">Tavolo</dt>
              <dd
                className="mt-0.5 [overflow-wrap:anywhere] font-semibold text-text-primary"
                data-testid="assigned-table-names"
              >
                {reservation.assignment
                  ? reservation.assignment.tableNames.join(", ")
                  : "—"}
              </dd>
            </div>

            <div className="min-w-0">
              <dt className="font-medium text-text-muted">Preferenza cliente</dt>
              <dd
                className="mt-0.5 [overflow-wrap:anywhere] font-semibold text-text-primary"
                data-testid="customer-room-preference"
              >
                {reservation.preferredRoom}{" "}
                <span className="font-normal text-text-muted">(non definitiva)</span>
              </dd>
            </div>

            <div className="min-w-0">
              <dt className="font-medium text-text-muted">Telefono</dt>
              <dd className="mt-0.5 min-w-0">
                <a
                  className="[overflow-wrap:anywhere] font-semibold text-text-primary underline decoration-brand-copper underline-offset-4"
                  href={`tel:${reservation.customerPhone}`}
                >
                  {reservation.customerPhone}
                </a>
              </dd>
            </div>
          </dl>

          {badges.length > 0 ? (
            <div aria-label="Richieste operative" className="flex flex-wrap gap-1.5">
              {badges.map((badge) => (
                <span
                  className="rounded-full bg-brand-primary-subtle px-2.5 py-1 text-xs font-medium text-brand-primary-active"
                  key={badge}
                >
                  {badge}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-muted">Nessuna richiesta operativa.</p>
          )}

          {reservation.allergies ||
          reservation.intolerances ||
          reservation.celebration ||
          reservation.notes ? (
            <div className="min-w-0 space-y-1.5 border-l-2 border-brand-copper pl-3 text-sm text-text-secondary">
              {reservation.allergies ? (
                <p className="[overflow-wrap:anywhere]">
                  <strong>Allergie:</strong> {reservation.allergies}
                </p>
              ) : null}
              {reservation.intolerances ? (
                <p className="[overflow-wrap:anywhere]">
                  <strong>Intolleranze:</strong> {reservation.intolerances}
                </p>
              ) : null}
              {reservation.celebration ? (
                <p className="[overflow-wrap:anywhere]">
                  <strong>Ricorrenza:</strong> {reservation.celebration}
                </p>
              ) : null}
              {reservation.notes ? (
                <p className="[overflow-wrap:anywhere]">
                  <strong>Note:</strong> {reservation.notes}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="min-w-0 border-t border-border pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4">
          <section data-testid="assignment-summary">
            <h4 className="text-xs font-semibold tracking-wide text-text-muted uppercase">
              Assegnazione
            </h4>
            {reservation.assignment ? (
              <div className="mt-1.5 space-y-1 text-sm text-text-secondary">
                {reservation.assignment.internalNotesPresent ? (
                  <p className="font-medium text-info">Note interne presenti</p>
                ) : null}
                {reservation.assignment.hasInactiveReferences ||
                reservation.assignment.hasUnavailableRoomReference ? (
                  <p
                    className="mt-2 rounded-control border border-warning/30 bg-warning/8 p-2.5 font-medium text-warning"
                    data-testid="assignment-grandfathering-warning"
                  >
                    Riferimento grandfathered:
                    {reservation.assignment.hasInactiveReferences
                      ? " sala o tavolo inattivo"
                      : ""}
                    {reservation.assignment.hasInactiveReferences &&
                    reservation.assignment.hasUnavailableRoomReference
                      ? ";"
                      : ""}
                    {reservation.assignment.hasUnavailableRoomReference
                      ? " sala indisponibile per il servizio"
                      : ""}
                    .
                  </p>
                ) : null}
                {reservation.status === "CANCELLED" ? (
                  <p>Storico, escluso dai conteggi operativi.</p>
                ) : null}
              </div>
            ) : reservation.status === "CANCELLED" ? (
              <p className="mt-1.5 text-sm text-text-muted">
                Nessuna assegnazione storica.
              </p>
            ) : null}
          </section>

          {reservation.updatedAt !== reservation.createdAt ? (
            <p className="mt-3 text-xs text-text-muted">
              Ultimo aggiornamento: {updatedAt}
            </p>
          ) : null}

          {reservation.overrideApplied ? (
            <p className="mt-3 rounded-control border border-warning/30 bg-warning/8 p-2.5 text-sm font-medium text-warning">
              Override capacità: {reservation.overrideReason}
            </p>
          ) : null}

          {reservation.notificationHealth === "NOT_DELIVERED" ? (
            <p
              className="mt-3 rounded-control border border-danger/30 bg-danger/8 p-2.5 text-sm font-semibold text-danger"
              data-testid="notification-not-delivered"
            >
              Notifica non consegnata
            </p>
          ) : reservation.notificationHealth === "PARTIAL_SUCCESS" ? (
            <p
              className="mt-3 rounded-control border border-warning/30 bg-warning/8 p-2.5 text-sm font-semibold text-warning"
              data-testid="notification-partial-success"
            >
              Notifica consegnata soltanto su un canale
            </p>
          ) : null}

          <ReservationAssignmentPanel
            cancelled={reservation.status === "CANCELLED"}
            hasAssignment={reservation.assignment !== null}
            reservationId={reservation.id}
          />
          <ReservationArrivalControl
            arrivedAt={reservation.arrivedAt}
            cancelled={reservation.status === "CANCELLED"}
            historical={historical}
            onCommitted={(result) =>
              onArrivalCommitted({
                reservationId: reservation.id,
                ...result,
              })
            }
            reservationId={reservation.id}
            version={reservation.version}
          />
          <ReservationActions
            cancelled={reservation.status === "CANCELLED"}
            reservationId={reservation.id}
            version={reservation.version}
          />
        </div>
      </div>
    </article>
  );
}

export function StaffAgenda({
  emptyStateIsFiltered,
  historical,
  newReservationHref,
  reservations,
  summary,
  timezone,
}: {
  emptyStateIsFiltered: boolean;
  historical: boolean;
  newReservationHref: string;
  reservations: DashboardReservation[];
  summary: DashboardSummary;
  timezone: string;
}) {
  const [arrivalOverrides, setArrivalOverrides] = useState<
    Record<string, ArrivalOverride>
  >({});
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<StaffAgendaOrder>(
    DEFAULT_STAFF_AGENDA_ORDER,
  );

  const reconciledArrivalOverrides = reconcileArrivalOverrides(
    arrivalOverrides,
    reservations,
  );
  if (reconciledArrivalOverrides !== arrivalOverrides) {
    setArrivalOverrides(reconciledArrivalOverrides);
  }

  const agendaReservations = useMemo(
    () =>
      reservations.map((reservation) => {
        const override = reconciledArrivalOverrides[reservation.id];
        return override && override.version > reservation.version
          ? { ...reservation, ...override }
          : reservation;
      }),
    [reconciledArrivalOverrides, reservations],
  );
  const visibleReservations = useMemo(
    () => selectStaffAgendaReservations(agendaReservations, { query, order }),
    [agendaReservations, order, query],
  );
  const arrivalSummary = useMemo(() => {
    const confirmed = agendaReservations.filter(
      (reservation) => reservation.status === "CONFIRMED",
    );
    return {
      ...summary,
      arrivedCovers: confirmed
        .filter((reservation) => reservation.arrivedAt !== null)
        .reduce((total, reservation) => total + reservation.partySize, 0),
      expectedCovers: confirmed
        .filter((reservation) => reservation.arrivedAt === null)
        .reduce((total, reservation) => total + reservation.partySize, 0),
    };
  }, [agendaReservations, summary]);
  const normalizedQuery = query.trim();

  return (
    <div className="min-w-0">
      <section
        aria-labelledby="agenda-controls-title"
        className="border border-border bg-surface p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold tracking-wide text-brand-primary uppercase">
              Controlli agenda
            </p>
            <h2
              className="mt-1 text-heading-sm font-semibold text-text-primary"
              id="agenda-controls-title"
            >
              Cerca e ordina
            </h2>
          </div>
          <Link
            aria-label="+ Telefonica — Nuova prenotazione telefonica"
            className={`${buttonClassName("primary")} w-full sm:w-auto`}
            href={newReservationHref}
          >
            Nuova prenotazione telefonica
          </Link>
        </div>

        <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(13rem,.35fr)_auto] lg:items-end">
          <div className="block min-w-0 text-sm font-medium text-text-secondary">
            <label htmlFor="agenda-search">Cerca prenotazione</label>
            <span
              className="mt-0.5 block text-xs font-normal text-text-muted"
              id="agenda-search-hint"
            >
              Nome, cognome o telefono
            </span>
            <input
              aria-describedby="agenda-search-hint"
              autoComplete="off"
              className="mt-1 min-h-11 w-full min-w-0 rounded-control border border-border-strong bg-surface px-3 py-2 text-text-primary"
              data-testid="agenda-search"
              id="agenda-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Es. Rossi o 0001234567"
              type="search"
              value={query}
            />
          </div>

          <label className="block min-w-0 text-sm font-medium text-text-secondary">
            Ordina agenda
            <select
              className="mt-1 min-h-11 w-full min-w-0 rounded-control border border-border-strong bg-surface px-3 py-2 text-text-primary"
              data-testid="agenda-order"
              onChange={(event) => setOrder(event.target.value as StaffAgendaOrder)}
              value={order}
            >
              <option value="OLDEST">Prenotazione più vecchia</option>
              <option value="SURNAME">Cognome A–Z</option>
              <option value="FIRST_NAME">Nome A–Z</option>
              <option value="ARRIVAL">Orario di arrivo</option>
            </select>
          </label>

          <button
            className="min-h-11 rounded-control border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text-primary hover:border-brand-primary disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!query}
            onClick={() => setQuery("")}
            type="button"
          >
            Cancella ricerca
          </button>
        </div>

        <p
          aria-atomic="true"
          aria-live="polite"
          className="mt-3 text-sm text-text-secondary"
          data-testid="agenda-result-count"
          role="status"
        >
          {visibleReservations.length}{" "}
          {visibleReservations.length === 1 ? "risultato" : "risultati"}
          {normalizedQuery ? ` per “${normalizedQuery}”` : ""}.
        </p>
      </section>

      <div className="mt-4">
        <AgendaSummary historical={historical} summary={arrivalSummary} />
      </div>

      <section aria-labelledby="agenda-list-title" className="mt-6 min-w-0">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-xs font-semibold tracking-wide text-brand-primary uppercase">
              Elenco operativo
            </p>
            <h2
              className="mt-1 text-heading-md font-semibold text-text-primary"
              id="agenda-list-title"
            >
              Agenda ({visibleReservations.length})
            </h2>
          </div>
          <p className="text-xs text-text-muted">Ordinamento: {order === "OLDEST" ? "prenotazione più vecchia" : order === "SURNAME" ? "cognome A–Z" : order === "FIRST_NAME" ? "nome A–Z" : "orario di arrivo"}</p>
        </div>

        {visibleReservations.length === 0 ? (
          <div className="mt-4 border border-border bg-surface px-5 py-8 text-center">
            <p className="font-semibold text-text-primary">
              {normalizedQuery
                ? "Nessun risultato per la ricerca."
                : emptyStateIsFiltered
                  ? "Nessuna prenotazione per i filtri selezionati."
                  : "Nessuna prenotazione nella data e nel servizio selezionati."}
            </p>
            {normalizedQuery ? (
              <button
                className="mt-3 min-h-11 rounded-control border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text-primary"
                onClick={() => setQuery("")}
                type="button"
              >
                Mostra tutta l’agenda
              </button>
            ) : null}
          </div>
        ) : (
          <ol className="mt-4 grid min-w-0 gap-3" role="list">
            {visibleReservations.map((reservation) => (
              <li className="min-w-0" key={reservation.id}>
                <ReservationAgendaRow
                  historical={historical}
                  onArrivalCommitted={(result) =>
                    setArrivalOverrides((current) => ({
                      ...current,
                      [result.reservationId]: {
                        arrivedAt: result.arrivedAt,
                        version: result.version,
                      },
                    }))
                  }
                  reservation={reservation}
                  timezone={timezone}
                />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
