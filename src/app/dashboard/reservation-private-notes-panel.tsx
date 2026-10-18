"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { StaffSensitiveRegion, useStaffDraftBinding, useStaffDraftHost, useStaffHostView, useStaffOverlay, useStaffResource } from "@/app/_components/staff/staff-draft-host";
import { useAgendaContext } from "./agenda-context";
import { MAX_PRIVATE_NOTES_CODE_POINTS, privateNotesCodePointLength, reservationPrivateNotesInputSchema } from "@/modules/reservations/domain/reservation-notes";
import { buttonClassName } from "@/app/_components/ui/button";

export function ReservationPrivateNotesEditor({ reservationId, localDate }: { reservationId: string; localDate: string }) {
  const controller = useStaffDraftHost(), resource = useStaffResource("NI", reservationId), agenda = useAgendaContext(), pathname = usePathname();
  const context = resource.data, initial = useMemo(() => ({ privateNotes: context?.privateNotes ?? "" }), [context?.privateNotes]);
  const binding = useStaffDraftBinding({ kind: "NI", resourceId: reservationId, values: initial, version: context?.reservation.version ?? null,
    route: pathname === "/dashboard" ? "/dashboard/reservations/" + reservationId : pathname, originPath: agenda.origin(localDate), allowed: !!context });
  const [validationError, setValidationError] = useState<string | null>(null), [review, setReview] = useState(false), [adopting, setAdopting] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const record = binding.record, readOnly = context?.reservation.status === "CANCELLED";
  const reviewReady = resource.reloadStatus === "RELOADED_SNAPSHOT_CONFIRMED" && !resource.error;
  useEffect(() => { if (record?.error || validationError) errorRef.current?.focus(); }, [record?.error, validationError]);
  async function save() {
    const current = binding.key ? controller.getSnapshot().drafts.records[binding.key] : null;
    if (!current || current.phase === "PENDING" || readOnly) return;
    const payload = reservationPrivateNotesInputSchema.safeParse({ version: current.baseVersion, privateNotes: current.values.privateNotes });
    if (!payload.success) { setValidationError("La nota deve contenere al massimo 1000 caratteri Unicode validi."); return; }
    setValidationError(null);
    await controller.mutate({ key: current.key, url: "/api/staff/reservations/" + reservationId + "/private-notes", method: "PUT", payload: JSON.stringify(payload.data), validate: body => {
      if (!body || typeof body !== "object" || !("reservationVersion" in body) || !Number.isInteger(body.reservationVersion) || !("changed" in body) || typeof body.changed !== "boolean") return null;
      return { resourceId: reservationId, version: Number(body.reservationVersion), text: body.changed ? "Nota interna salvata." : "Nota già aggiornata." };
    } });
  }
  return <section data-testid="private-notes-editor" className="mt-5 min-w-0 space-y-3">
    <h2 className="text-lg font-semibold">Note interne della prenotazione</h2>
    <p className="text-sm text-text-muted">Private per Staff e Admin. Escluse da PDF ed Excel. Una rilettura non sostituisce la bozza.</p>
    {resource.error ? <p role="alert">{resource.error}</p> : null}
    {!context ? <><p role="status">Caricamento note…</p><button onClick={() => void resource.reload()} type="button">Riprova lettura</button></> : null}
    {binding.resumeRequired ? <button className={buttonClassName("secondary")} type="button" onClick={() => void binding.resume()}>Continua modifica NI</button> : null}
    <StaffSensitiveRegion allowed={!!context && !!record}>{context && record ? <>
      <section className="text-sm"><h3 className="font-semibold">Nota condivisa con il cliente (NC)</h3><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{context.reservation.notes ?? "Assente"}</p><p>Modificabile tramite Staff Edit; nessuna attribuzione materiale automatica.</p></section>
      <label className="block text-sm font-semibold" htmlFor={"ni-" + reservationId}>Nota interna autonoma (NI)</label>
      {readOnly ? <p>Prenotazione cancellata: sola lettura.</p> : null}
      <textarea id={"ni-" + reservationId} rows={5} value={String(record.values.privateNotes ?? "")} readOnly={readOnly} disabled={binding.pending}
        onChange={event => binding.patch({ privateNotes: event.target.value })} className="w-full min-w-0 rounded-control border border-border-strong bg-surface p-3" />
      <p className="text-xs">{privateNotesCodePointLength(String(record.values.privateNotes ?? ""))} / {MAX_PRIVATE_NOTES_CODE_POINTS} caratteri</p>
      <section className="rounded-control border border-border p-3 text-sm"><h3 className="font-semibold">NI legacy dell’assegnazione</h3><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{context.legacyAssignment?.internalNotes ?? "Assente"}</p>
        {context.legacyAssignment ? <p>Assegnazione {context.legacyAssignment.state === "ACTIVE" ? "attiva" : "rimossa"} · consultazione separata</p> : null}
        {!context.privateNotesPresent && context.legacyAssignment?.internalNotesPresent ? <p>Nota autonoma assente; è presente soltanto una nota legacy.</p> : null}</section>
      {record.error || validationError ? <p ref={errorRef} tabIndex={-1} role="alert" className="text-danger">{validationError ?? record.error}</p> : null}
      <div className="flex flex-wrap gap-2">{!readOnly ? <button className={buttonClassName()} disabled={binding.pending || record.phase === "DIRTY_CONFLICT" || record.phase === "ERROR"} type="button" onClick={() => void save()}>{binding.pending ? "Salvataggio…" : "Salva nota interna"}</button> : null}
        <button className={buttonClassName("secondary")} disabled={binding.pending} type="button" onClick={() => { setReview(true); setAdopting(false); void resource.reload(); }}>Rileggi nota senza sostituire bozza</button></div>
      {review ? <section className="rounded-control border border-warning p-3 text-sm" data-reload-status={resource.reloadStatus}><h3 className="font-semibold">Rivalutazione esplicita</h3>
        {resource.reloadStatus === "RELOAD_IN_PROGRESS" ? <p role="status">Rilettura NI in corso. Bozza e versione base invariate.</p> : null}
        {reviewReady ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">Nota canonica riletta: {context.privateNotes ?? "Assente"} · versione {context.reservation.version}</p> : <p>Lo snapshot corrente non è una rilettura confermata. Adozione e riapplicazione non disponibili.</p>}
        <p>La bozza resta separata. Verifica le differenze prima di adottare una nuova base.</p>
        <div className="flex flex-wrap gap-3"><button type="button" disabled={binding.pending || !reviewReady || readOnly} onClick={() => { if (!reviewReady) return; controller.review(record.key, { version: context.reservation.version, serverValues: initial, selectedFields: ["privateNotes"] }); setReview(false); }}>Riapplica la mia bozza sulla versione riletta</button>
          <button type="button" disabled={binding.pending || !reviewReady} onClick={() => { if (reviewReady) setAdopting(true); }}>Adotta la nota canonica dopo conferma</button></div>
          {adopting ? <div><p>Scartare soltanto il testo della bozza NI corrente?</p><button type="button" disabled={binding.pending || !reviewReady} onClick={() => { if (!reviewReady) return; controller.review(record.key, { version: context.reservation.version, serverValues: initial, selectedFields: [] }); setReview(false); setAdopting(false); }}>Conferma scarto e adotta nota canonica</button><button type="button" onClick={() => setAdopting(false)}>Mantieni bozza</button></div> : null}</section> : null}
      {record.receipt ? <p role="status" className="text-success">{record.receipt.text}</p> : null}
    </> : null}</StaffSensitiveRegion>
  </section>;
}

// Both entry surfaces share one editor and one authorized GET owner.
export function ReservationPrivateNotesPanel({ reservationId, localDate = "2000-01-01" }: { reservationId: string; localDate?: string }) {
  const dialog = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), controller = useStaffDraftHost(), view = useStaffHostView();
  const open = view.privateNotesSurface === reservationId;
  const close = () => controller.requestExit(() => { controller.closePrivateNotes(reservationId); requestAnimationFrame(() => (trigger.current ?? document.getElementById("agenda-controls-title"))?.focus()); });
  const ownsFocus = useStaffOverlay(open, "ni-" + reservationId, dialog, close);
  return <div className="mt-3" data-testid="private-notes-panel"><button ref={trigger} className={buttonClassName("secondary")} onClick={() => controller.requestExit(() => controller.openPrivateNotes(reservationId))}>Apri note interne</button>
    {open ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div ref={dialog} role={ownsFocus ? "dialog" : undefined} aria-modal={ownsFocus || undefined} aria-label="Note interne della prenotazione" inert={!ownsFocus} tabIndex={-1} className="max-h-[90dvh] w-full max-w-xl overflow-auto rounded-surface bg-surface p-4">
        <button type="button" className={buttonClassName("secondary")} onClick={close}>Chiudi note interne</button><ReservationPrivateNotesEditor reservationId={reservationId} localDate={localDate} />
      </div></div> : null}
  </div>;
}
