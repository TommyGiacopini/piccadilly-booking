"use client";

import Link from "next/link";
import { useStaffResource, StaffSensitiveRegion } from "@/app/_components/staff/staff-draft-host";
import { ReservationPrivateNotesEditor } from "./reservation-private-notes-panel";
import { ReservationAssignmentPanel } from "./reservation-assignment-panel";
import { ReservationArrivalControl } from "./reservation-arrival-control";
import { ReservationActions } from "./reservation-actions";
import { useAgendaContext } from "./agenda-context";
import { reservationCompositionPresentation } from "@/modules/dashboard/domain/reservation-row-presentation";

export function ReservationDetailContent({ reservationId, timezone, onAssignmentOpenChange }: {
  reservationId: string; timezone: string; onAssignmentOpenChange?: (open: boolean) => void;
}) {
  const resource = useStaffResource("STAFF", reservationId), assignment = useStaffResource("ASSIGNMENT", reservationId), notes = useStaffResource("NI", reservationId);
  const agenda = useAgendaContext(), reservation = resource.data;
  function rereadSections() { void resource.reload(); void assignment.reload(); void notes.reload(); }
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone }).format(new Date());
  const versions = [reservation?.version, assignment.data?.reservation.version, notes.data?.reservation.version].filter(value => value !== undefined);
  return <div className="min-w-0 space-y-4">
    <h1 className="text-2xl font-semibold" tabIndex={-1}>Dettaglio prenotazione</h1>
    <p className="text-xs text-text-muted">Le sezioni sono lette separatamente; non costituiscono uno snapshot atomico.</p>
    {new Set(versions).size > 1 ? <p role="status" className="rounded-control border border-warning p-3">Versioni differenti tra sezioni. Rileggi i dati prima di rivalutare le modifiche.</p> : null}
    {resource.error ? <p role="alert">{resource.error}</p> : null}
    {!reservation ? <><p role="status">Verifica accesso e caricamento prenotazione…</p><button type="button" onClick={() => void resource.reload()}>Riprova lettura prenotazione</button></> : null}
    <StaffSensitiveRegion allowed={!!reservation}>{reservation ? <>
      <section className="rounded-control border border-border p-3" aria-label="Informazioni prenotazione">
        <h2 className="text-xl font-semibold [overflow-wrap:anywhere]">{reservation.customer.lastName} {reservation.customer.firstName}</h2>
        <p>{reservation.localDate} · {reservation.serviceType === "LUNCH" ? "Pranzo" : "Cena"} · {reservation.arrivalTime} · {reservation.partySize} coperti</p>
        <p>{reservationCompositionPresentation(reservation).label} · {reservation.status === "CONFIRMED" ? "Confermata" : "Cancellata"} · {reservation.origin}</p>
        <p className="text-sm">ID: {reservation.id} · Versione: {reservation.version}</p>
      </section>
      <section className="text-sm [overflow-wrap:anywhere]" aria-label="Contatti"><h2 className="font-semibold">Dati contatto</h2>
        <a href={"tel:" + reservation.customer.phone} className="underline">{reservation.customer.phone}</a><p>{reservation.customer.email ?? "Email non disponibile"}</p></section>
      <section className="text-sm [overflow-wrap:anywhere]"><h2 className="font-semibold">Esigenze e preferenze dichiarate</h2>
        <p>{[reservation.highChair && "Seggiolone", reservation.stroller && "Passeggino", reservation.accessibility && "Accessibilità", reservation.celiac && "Celiachia", reservation.animals && "Animali", reservation.gameRoomPreference && "Sala giochi richiesta"].filter(Boolean).join(" · ") || "Nessun indicatore"}</p>
        <p>Preferenza cliente: {reservation.legacyPreference ?? reservation.roomCode} (non definitiva)</p>
        {reservation.allergies ? <p>Allergie: {reservation.allergies}</p> : null}{reservation.legacyAllergy ? <p>Allergia storica: {reservation.legacyAllergy}</p> : null}
        {reservation.intolerances ? <p>Intolleranze: {reservation.intolerances}</p> : null}{reservation.celebration ? <p>Ricorrenza: {reservation.celebration}</p> : null}
      </section>
      <section className="text-sm"><h2 className="font-semibold">NC condivise</h2><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{reservation.notes ?? "Assenti"}</p></section>
      <section className="text-sm"><h2 className="font-semibold">Arrival</h2><ReservationArrivalControl arrivedAt={reservation.arrivedAt} cancelled={reservation.status === "CANCELLED"} historical={reservation.localDate < today} reservationId={reservation.id} version={reservation.version}
        onCommitted={rereadSections} /></section>
      <section className="text-sm"><h2 className="font-semibold">Sala definitiva e tavoli</h2>
        {assignment.error ? <p role="alert">{assignment.error}</p> : null}
        <p>{assignment.data ? assignment.data.assignment ? assignment.data.assignment.room.name + " · " + assignment.data.assignment.tables.map(table => table.name).join(", ") : "Da assegnare" : "Assegnazione non disponibile"}</p>
        <ReservationAssignmentPanel reservationId={reservation.id} cancelled={reservation.status === "CANCELLED"} hasAssignment={!!assignment.data?.assignment} onOpenChange={open => { onAssignmentOpenChange?.(open); if (!open) rereadSections(); }} />
      </section>
      <ReservationPrivateNotesEditor reservationId={reservation.id} localDate={reservation.localDate} />
      <section className="text-sm"><h2 className="font-semibold">Metadata disponibili</h2><p>Ultimo aggiornamento: {new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short", timeZone: timezone }).format(new Date(reservation.updatedAt))}</p>
        {reservation.override.applied ? <p>Override capacità: {reservation.override.reason}</p> : null}</section>
      <ReservationActions reservationId={reservation.id} version={reservation.version} cancelled={reservation.status === "CANCELLED"} onCommitted={rereadSections} inline />
      <Link href={agenda.origin(reservation.localDate)} onNavigate={event => { event.preventDefault(); agenda.navigate(agenda.origin(reservation.localDate)); }} className="inline-flex min-h-11 items-center underline">Torna Agenda</Link>
    </> : null}</StaffSensitiveRegion>
  </div>;
}
