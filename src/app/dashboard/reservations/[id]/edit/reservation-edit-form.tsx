"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { StaffSensitiveRegion, useStaffDraftBinding, useStaffResource } from "@/app/_components/staff/staff-draft-host";
import { useAgendaContext } from "@/app/dashboard/agenda-context";
import { StaffReservationFields, reservationFormPayload, reservationFormValues } from "@/app/dashboard/reservations/new/reservation-create-form";
import { rescheduledAgendaHref } from "@/modules/dashboard/domain/agenda-navigation";

const fieldLabels: Record<string, string> = { localDate: "Data", serviceType: "Servizio", arrivalTime: "Orario", partySize: "Coperti", compositionMode: "Composizione", compositionCount: "Numero bambini", compositionGames: "Richiesta giochi", customerFirstName: "Nome", customerLastName: "Cognome", customerPhone: "Telefono", customerEmail: "Email", notes: "NC condivisa", highChair: "Seggiolone", stroller: "Passeggino", accessibility: "Accessibilità", celiac: "Celiachia", animals: "Animali", allergies: "Allergie", intolerances: "Intolleranze", celebration: "Ricorrenza", capacityOverride: "Override", capacityOverrideReason: "Motivo override" };
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function ReservationEditForm({ reservationId }: { reservationId: string }) {
  const resource = useStaffResource("STAFF", reservationId), agenda = useAgendaContext(), pathname = usePathname();
  const reservation = resource.data;
  const initial = useMemo(() => reservation ? reservationFormValues(reservation.localDate, reservation.serviceType, reservation) : {}, [reservation]);
  const binding = useStaffDraftBinding({ kind: "EDIT", resourceId: reservationId, values: initial, version: reservation?.version ?? null,
    route: pathname, originPath: agenda.origin(reservation?.localDate ?? "2000-01-01"), allowed: resource.ready });
  const error = useRef<HTMLDivElement>(null), [review, setReview] = useState(false), [selected, setSelected] = useState<readonly string[]>([]);
  useEffect(() => { if (binding.record?.error) error.current?.focus(); }, [binding.record?.error]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const record = binding.key ? binding.controller.getSnapshot().drafts.records[binding.key] : null;
    if (!record || record.phase === "PENDING" || reservation?.status !== "CONFIRMED") return;
    const fields = reservationFormPayload(record.values), payload = JSON.stringify({ version: record.baseVersion, ...fields });
    const outcome = await binding.controller.mutate({ key: record.key, url: `/api/staff/reservations/${reservationId}`, method: "PATCH", payload,
      validate: body => {
        if (!object(body) || !object(body.reservation) || body.reservation.id !== reservationId || !Number.isInteger(body.reservation.version) ||
          typeof body.reservation.localDate !== "string" || (body.reservation.serviceType !== "LUNCH" && body.reservation.serviceType !== "DINNER")) return null;
        const destination = rescheduledAgendaHref(body.reservation.localDate, body.reservation.serviceType);
        const rescheduled = fields.localDate !== record.baseline.localDate || fields.serviceType !== record.baseline.serviceType || fields.arrivalTime !== record.baseline.arrivalTime;
        return { resourceId: reservationId, version: Number(body.reservation.version),
          text: body.changed === false ? "Nessuna modifica da salvare. Versione e disponibilità sono state ricontrollate." : "Prenotazione aggiornata. Versione e disponibilità sono state ricontrollate.",
          ...(rescheduled ? { destinationPath: destination } : {}) };
      } });
    if (outcome.confirmed && outcome.foreground && outcome.receipt) {
      binding.controller.setAgenda({ feedback: outcome.receipt.text, destinationHref: outcome.receipt.destinationPath ?? null, focusReservationId: reservationId });
      agenda.navigate(outcome.receipt.originPath, []);
    }
  }
  const record = binding.record, cancelled = reservation?.status === "CANCELLED";
  const latest = reservation ? reservationFormValues(reservation.localDate, reservation.serviceType, reservation) : {};
  return <>
    {resource.error ? <div role="alert" className="mt-5 border border-danger p-3"><p>{resource.error}</p><button className="min-h-11 underline" type="button" onClick={() => void resource.reload()}>Riprova lettura</button></div> : null}
    {binding.resumeRequired ? <div className="mt-5 border border-warning p-4"><p>È disponibile una bozza Edit temporanea. Verrà verificato nuovamente l’accesso prima di mostrarla.</p><button className="min-h-11 underline" type="button" onClick={() => void binding.resume()}>Continua modifica</button></div> : null}
    {!record && !resource.error && !binding.resumeRequired ? <p className="mt-5" role="status">Verifica dell’accesso e caricamento della prenotazione…</p> : null}
    <StaffSensitiveRegion allowed={record !== null && reservation !== null}>{record && reservation ? <form className="mt-6 min-w-0 rounded-surface border border-border bg-surface p-4 sm:p-7" onSubmit={submit}>
      {cancelled ? <p className="mb-4 font-semibold">Prenotazione cancellata: NC e dati prenotazione in sola lettura. La bozza non è stata salvata.</p> : null}
      <StaffReservationFields values={record.values} patch={binding.patch} pending={binding.pending || cancelled} original={reservation} baseline={record.baseline} phone={false} />
      {record.error ? <div ref={error} role="alert" tabIndex={-1} className="mt-4 rounded-control border border-danger p-3 text-danger">{record.error}</div> : null}
      {record.error || review ? <section className="mt-4 rounded-control border border-warning p-4" aria-label="Rivalutazione della bozza">
        <p className="text-sm">La rilettura aggiorna un contesto separato: non sostituisce la bozza o la sua versione. Un409 può riguardare anche stato o capacità.</p>
        <button type="button" className="mt-2 min-h-11 underline" disabled={binding.pending} onClick={async () => { await resource.reload(); setReview(true); setSelected([]); }}>Rileggi dati canonici separatamente</button>
        {review && !resource.error ? <>
          <p className="mt-3 text-sm">Versione della bozza: {record.baseVersion}. Versione canonica riletta: {reservation.version}.</p>
          <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left">Scegli esplicitamente i campi della tua bozza da riapplicare; gli altri mantengono il valore canonico riletto.</caption><thead><tr><th>Riapplica</th><th>Campo</th><th>Bozza</th><th>Canonico</th></tr></thead><tbody>{Object.entries(fieldLabels).map(([field, label]) => <tr className="border-t border-border" key={field}><td><input type="checkbox" aria-label={`Riapplica ${label}`} checked={selected.includes(field)} onChange={event => setSelected(current => event.target.checked ? [...current, field] : current.filter(key => key !== field))} /></td><th className="p-2 font-medium">{label}</th><td className="max-w-xs p-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{String(record.values[field] ?? "")}</td><td className="max-w-xs p-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{String(latest[field] ?? "")}</td></tr>)}</tbody></table></div>
          <button type="button" className="mt-3 min-h-11 underline" disabled={binding.pending || cancelled} onClick={() => { binding.controller.review(record.key, { version: reservation.version, serverValues: latest, selectedFields: selected }); setReview(false); }}>Usa il confronto e prepara la bozza</button>
          <p className="mt-2 text-xs">Questa scelta non salva. Premi Salva modifiche dopo aver verificato tutti i campi.</p>
        </> : null}
      </section> : null}
      <div className="mt-5 flex flex-wrap gap-3"><button className="min-h-11 rounded-control bg-brand-primary px-5 py-2 text-brand-on-primary disabled:opacity-50" disabled={binding.pending || cancelled} type="submit">{binding.pending ? "Salvataggio…" : "Salva modifiche"}</button>
        <Link className="inline-flex min-h-11 items-center rounded-control border border-border px-4" href={record.originPath} onNavigate={event => { event.preventDefault(); agenda.navigate(record.originPath, [record.key]); }}>Torna Agenda</Link>
        <Link className="inline-flex min-h-11 items-center underline" href={`/dashboard/reservations/${reservationId}`} onNavigate={event => { event.preventDefault(); agenda.navigate(`/dashboard/reservations/${reservationId}`, [record.key]); }}>Apri dettaglio e note interne</Link>
      </div>
    </form> : null}</StaffSensitiveRegion>
  </>;
}
