"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  MAX_PRIVATE_NOTES_CODE_POINTS, privateNotesCodePointLength, reservationPrivateNotesInputSchema,
  type ReservationPrivateNotesContext,
} from "@/modules/reservations/domain/reservation-notes";
import { buttonClassName } from "@/app/_components/ui/button";

export function ReservationPrivateNotesPanel({ reservationId }: { reservationId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [context, setContext] = useState<ReservationPrivateNotesContext | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [feedback, setFeedback] = useState("");
  const busy = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  const titleId = `private-notes-title-${reservationId}`;
  const textareaId = `private-notes-text-${reservationId}`;

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const returnTo = trigger.current;
    element?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy.current) { event.preventDefault(); setOpen(false); }
      if (event.key !== "Tab" || !element) return;
      const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (!controls.includes(document.activeElement as HTMLElement)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); returnTo?.focus(); };
  }, [open]);
  useEffect(() => { if (error && !loading && !pending) errorElement.current?.focus(); }, [error, loading, pending]);
  useEffect(() => {
    if (open && (pending || loading) && !dialog.current?.contains(document.activeElement)) dialog.current?.focus();
  }, [open, pending, loading]);

  async function load() {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError(null); setFeedback("");
    try {
      const response = await fetch(`/api/staff/reservations/${reservationId}/private-notes`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.reservation) throw new Error("Le note non sono disponibili. Riprova.");
      const next = body as ReservationPrivateNotesContext;
      setContext(next); setDraft(next.privateNotes ?? ""); setReloadRequired(false);
    } catch {
      setError("Non è stato possibile leggere le note interne."); setReloadRequired(true);
    } finally { busy.current = false; setLoading(false); }
  }
  async function save() {
    if (busy.current || !context || reloadRequired || context.reservation.status === "CANCELLED") return;
    const payload = reservationPrivateNotesInputSchema.safeParse({ version: context.reservation.version, privateNotes: draft });
    if (!payload.success) { setError("La nota deve contenere al massimo 1000 caratteri Unicode validi."); return; }
    busy.current = true; setPending(true); setError(null); setFeedback("");
    try {
      const response = await fetch(`/api/staff/reservations/${reservationId}/private-notes`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload.data),
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 409) {
          setError("La prenotazione è cambiata. La bozza è conservata: ricarica la nota e rivaluta il testo.");
          setReloadRequired(true);
        } else { setError("Non è stato possibile salvare la nota interna."); }
        return;
      }
      setContext({ ...context, reservation: { ...context.reservation, version: body.reservationVersion },
        privateNotes: body.privateNotes, privateNotesPresent: body.privateNotes !== null });
      setDraft(body.privateNotes ?? "");
      setFeedback(body.changed ? "Nota interna salvata." : "Nota già aggiornata.");
      router.refresh();
    } catch {
      setError("Esito del salvataggio non verificato. Ricarica la nota prima di riprovare.");
      setReloadRequired(true);
    } finally { busy.current = false; setPending(false); }
  }
  const readOnly = context?.reservation.status === "CANCELLED";
  return (
    <div className="mt-3 min-w-0" data-testid="private-notes-panel">
      <button ref={trigger} className={buttonClassName("secondary")}
        onClick={() => { setOpen(true); setContext(null); void load(); }}>Apri note interne</button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3">
          <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
            className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-surface border border-border bg-surface p-4 shadow-xl sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <h2 id={titleId} className="text-xl font-semibold">Note interne della prenotazione</h2>
              <button className={buttonClassName("secondary")} disabled={pending}
                onClick={() => setOpen(false)}>Chiudi note interne</button>
            </div>
            <p className="mt-2 text-sm text-text-muted">Private per Staff e Admin. Escluse da PDF ed Excel.</p>
            {loading ? <p role="status" className="mt-4">Caricamento note…</p> : null}
            {error ? <p ref={errorElement} role="alert" tabIndex={-1} className="mt-4 rounded-control border border-danger p-3 text-danger">{error}</p> : null}
            {context && !loading ? (
              <div className="mt-4 min-w-0 space-y-4">
                <section className="min-w-0 text-sm">
                  <h3 className="font-semibold">Nota condivisa con il cliente (NC)</h3>
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{context.reservation.notes ?? "Assente"}</p>
                  <p className="mt-1 text-xs text-text-muted">Modificabile dal cliente e dal personale tramite i flussi di prenotazione.</p>
                </section>
                <section>
                  <label htmlFor={textareaId} className="block text-sm font-semibold">Nota interna autonoma (NI)</label>
                  <p className="mt-1 text-xs text-text-muted">{context.privateNotesPresent ? "Presente" : "Assente"} · indipendente dalla sala</p>
                  {readOnly ? <p className="mt-2 text-sm font-semibold">Prenotazione cancellata: sola lettura.</p> : null}
                  <textarea id={textareaId} rows={6} value={draft} readOnly={readOnly}
                    disabled={pending} aria-describedby={`${textareaId}-count`}
                    className="mt-2 w-full rounded-control border border-border-strong bg-surface p-3 text-sm focus:outline-2 focus:outline-brand-primary"
                    onChange={(event) => setDraft(event.target.value)} />
                  <p id={`${textareaId}-count`} className="mt-1 text-xs text-text-muted">{privateNotesCodePointLength(draft)} / {MAX_PRIVATE_NOTES_CODE_POINTS} caratteri</p>
                </section>
                <section className="min-w-0 rounded-control border border-border p-3 text-sm">
                  <h3 className="font-semibold">NI legacy dell’assegnazione</h3>
                  <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{context.legacyAssignment?.internalNotes ?? "Assente"}</p>
                  {context.legacyAssignment ? <p className="mt-1 text-xs text-text-muted">Assegnazione {context.legacyAssignment.state === "ACTIVE" ? "attiva" : "rimossa"} · consultazione separata</p> : null}
                  {!context.privateNotesPresent && context.legacyAssignment?.internalNotesPresent ? <p className="mt-2">Nota autonoma assente; è presente soltanto una nota legacy.</p> : null}
                </section>
                <div className="flex flex-wrap gap-2">
                  {!readOnly ? <button className={buttonClassName()} disabled={pending || reloadRequired}
                    onClick={() => void save()}>{pending ? "Salvataggio…" : "Salva nota interna"}</button> : null}
                  <button className={buttonClassName("secondary")} disabled={pending}
                    onClick={() => void load()}>Ricarica nota e sostituisci bozza</button>
                </div>
                <p role="status" aria-live="polite" className="text-sm text-success">{feedback}</p>
              </div>
            ) : !loading ? <button className={buttonClassName("secondary")} onClick={() => void load()}>Riprova lettura</button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
