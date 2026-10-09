"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type {
  AssignmentRoomDto,
  ReservationAssignmentContextDto,
} from "@/modules/rooms/domain/reservation-assignment";

interface AssignmentErrorResponse {
  error?: string;
  code?: string;
}

interface AssignmentMutationResponse extends AssignmentErrorResponse {
  changed?: boolean;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function roomStateLabel(
  room: AssignmentRoomDto,
  historical: boolean,
): string | null {
  if (!room.isActive) return "inattiva";
  if (!historical && room.isAvailableForService === false) {
    return "indisponibile per il servizio";
  }
  return null;
}

export function ReservationAssignmentPanel(props: {
  reservationId: string;
  cancelled: boolean;
  hasAssignment: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [context, setContext] =
    useState<ReservationAssignmentContextDto | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [selectedTableIds, setSelectedTableIds] = useState<string[]>([]);
  const [internalNotes, setInternalNotes] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [tablesReset, setTablesReset] = useState(false);
  const submittingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !submittingRef.current) {
        event.preventDefault();
        setOpen(false);
      }
      if (event.key !== "Tab" || !dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled)',
      )];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (!controls.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      trigger?.focus();
    };
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if (dialogError && !loading && !submitting) {
      errorRef.current?.focus();
    } else if (!dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
      if (!dialog.contains(document.activeElement)) dialog.focus();
    }
  }, [open, dialogError, loading, submitting]);

  function applyContext(next: ReservationAssignmentContextDto) {
    setContext(next);
    setSelectedRoomId(next.assignment?.room.id ?? "");
    setSelectedTableIds(next.assignment?.tables.map((table) => table.id) ?? []);
    setInternalNotes(next.assignment?.internalNotes ?? "");
    setConfirmingClear(false);
    setTablesReset(false);
  }

  async function readContext(): Promise<ReservationAssignmentContextDto> {
    const response = await fetch(
      `/api/staff/reservations/${props.reservationId}/assignment`,
      { cache: "no-store" },
    );
    const body = (await response.json()) as
      | ReservationAssignmentContextDto
      | AssignmentErrorResponse;

    if (!response.ok || !("reservation" in body)) {
      throw new Error(
        "error" in body && body.error
          ? body.error
          : "Non è stato possibile leggere l'assegnazione.",
      );
    }
    return body;
  }

  async function openPanel() {
    setOpen(true);
    setLoading(true);
    setDialogError(null);
    setConflict(false);
    setStatusMessage(null);

    try {
      applyContext(await readContext());
    } catch (error) {
      setDialogError(
        error instanceof Error
          ? error.message
          : "Non è stato possibile leggere l'assegnazione.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function reloadAfterConflict() {
    setLoading(true);
    setDialogError(null);

    try {
      applyContext(await readContext());
      setConflict(false);
      setStatusMessage(null);
      router.refresh();
    } catch (error) {
      setDialogError(
        error instanceof Error
          ? error.message
          : "Non è stato possibile ricaricare l'assegnazione.",
      );
    } finally {
      setLoading(false);
    }
  }

  function mutationFailed(body: AssignmentErrorResponse, status: number) {
    if (body.code === "VERSION_CONFLICT") {
      setConflict(true);
      setDialogError(
        "La prenotazione è cambiata mentre lavoravi. La tua scelta non è stata salvata: ricarica lo stato e rivalutala.",
      );
      return;
    }

    setDialogError(
      body.error ??
        (status === 409
          ? "Lo stato operativo è cambiato. Ricarica prima di riprovare."
          : "Non è stato possibile salvare l'assegnazione."),
    );
  }

  async function saveAssignment() {
    if (!context || !canSave || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setDialogError(null);
    setConflict(false);

    try {
      const response = await fetch(
        `/api/staff/reservations/${props.reservationId}/assignment`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            version: context.reservation.version,
            roomId: selectedRoomId,
            tableIds: [...selectedTableIds].sort((left, right) =>
              left.localeCompare(right),
            ),
            internalNotes: internalNotes === "" ? null : internalNotes,
          }),
        },
      );
      const body = (await response.json()) as AssignmentMutationResponse;

      if (!response.ok) {
        mutationFailed(body, response.status);
        return;
      }

      setOpen(false);
      setContext(null);
      setStatusMessage(
        body.changed === false
          ? "Nessuna modifica: l'assegnazione era già aggiornata."
          : "Assegnazione salvata.",
      );
      router.refresh();
    } catch {
      setDialogError("Errore di rete. La scelta non è stata salvata.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function clearAssignment() {
    if (!context?.assignment || submittingRef.current || conflict) return;
    submittingRef.current = true;
    setSubmitting(true);
    setDialogError(null);
    setConflict(false);

    try {
      const response = await fetch(
        `/api/staff/reservations/${props.reservationId}/assignment`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: context.reservation.version }),
        },
      );
      const body = (await response.json()) as AssignmentMutationResponse;

      if (!response.ok) {
        mutationFailed(body, response.status);
        return;
      }

      setOpen(false);
      setContext(null);
      setStatusMessage(
        body.changed === false
          ? "L'assegnazione era già stata rimossa."
          : "Assegnazione rimossa logicamente.",
      );
      router.refresh();
    } catch {
      setDialogError("Errore di rete. L'assegnazione non è stata rimossa.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const selectedRoom = context?.rooms.find(
    (room) => room.id === selectedRoomId,
  );
  const currentRoomId = context?.assignment?.room.id ?? null;
  const currentTableIds = new Set(
    context?.assignment?.tables.map((table) => table.id) ?? [],
  );
  const noteCodePoints = codePointLength(internalNotes);
  const validTableCount =
    selectedTableIds.length <= 20;
  const canSave =
    context?.reservation.status === "CONFIRMED" &&
    selectedRoom !== undefined &&
    roomCanBeSelected(selectedRoom) &&
    validTableCount &&
    noteCodePoints <= 1_000 &&
    !submitting && !loading && !conflict;

  function roomCanBeSelected(room: AssignmentRoomDto): boolean {
    if (room.id === currentRoomId) return true;
    if (!room.isActive) return false;
    return (
      context?.reservation.isHistorical === true ||
      room.isAvailableForService === true
    );
  }

  function changeRoom(roomId: string) {
    if (roomId === selectedRoomId) return;
    setSelectedRoomId(roomId);
    setSelectedTableIds([]);
    setTablesReset(true);
  }

  function toggleTable(tableId: string) {
    setSelectedTableIds((current) => {
      if (current.includes(tableId)) {
        return current.filter((candidate) => candidate !== tableId);
      }
      if (current.length >= 20) return current;
      return [...current, tableId];
    });
  }

  return (
    <div className="mt-4">
      <button
        ref={triggerRef}
        className="min-h-11 rounded-lg border border-orange-300 bg-orange-50 px-4 py-2 text-sm font-black text-orange-950 transition hover:bg-orange-100 focus:outline-none focus:ring-4 focus:ring-orange-200"
        onClick={() => void openPanel()}
        type="button"
      >
        {props.cancelled
          ? "Vedi assegnazione storica"
          : props.hasAssignment
            ? "Gestisci assegnazione"
            : "Assegna sala"}
      </button>

      {statusMessage ? (
        <p className="mt-2 text-sm font-bold text-emerald-800" role="status">
          {statusMessage}
        </p>
      ) : null}

      {open ? (
        <div
          ref={dialogRef}
          aria-busy={loading || submitting}
          aria-describedby={dialogError ? `assignment-error-${props.reservationId}` : undefined}
          aria-labelledby={`assignment-title-${props.reservationId}`}
          aria-modal="true"
          className="fixed inset-0 z-50 overflow-y-auto bg-zinc-950/70 p-3 [overflow-wrap:anywhere] sm:p-6"
          data-testid="assignment-dialog"
          role="dialog"
          tabIndex={-1}
        >
          <div className="mx-auto my-2 w-full max-w-3xl rounded-2xl bg-white p-5 shadow-2xl sm:my-8 sm:p-7">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-black tracking-widest text-orange-600 uppercase">
                  Collocazione operativa
                </p>
                <h2
                  className="mt-1 text-2xl font-black text-zinc-950"
                  id={`assignment-title-${props.reservationId}`}
                >
                  Sala definitiva e tavoli
                </h2>
              </div>
              <button
                aria-label="Chiudi gestione assegnazione"
                className="min-h-11 min-w-11 rounded-lg border border-zinc-300 px-3 font-black text-zinc-700 focus:outline-none focus:ring-4 focus:ring-zinc-200"
                disabled={submitting}
                onClick={() => setOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>

            {loading ? (
              <p className="mt-6 rounded-xl bg-zinc-100 p-4 font-bold text-zinc-600" role="status">
                Caricamento dello stato corrente…
              </p>
            ) : context ? (
              <div className="mt-6 space-y-5">
                <section className="grid gap-3 rounded-xl border border-zinc-200 p-4 sm:grid-cols-2">
                  <div>
                    <p className="text-xs font-black text-zinc-500 uppercase">
                      Preferenza storica di sala
                    </p>
                    <p className="mt-1 font-black text-zinc-950">
                      {context.reservation.originalRoomPreference.roomName ??
                        context.reservation.originalRoomPreference.roomCode ??
                        (context.reservation.originalRoomPreference
                          .legacyPreferencePresent
                          ? "Preferenza storica"
                          : "Non specificata")}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-black text-zinc-500 uppercase">
                      Stato prenotazione
                    </p>
                    <p className="mt-1 font-black text-zinc-950">
                      {context.reservation.status === "CANCELLED"
                        ? "Cancellata · assegnazione solo storica"
                        : context.reservation.isHistorical
                          ? "Storica · correzione Staff/Admin consentita"
                          : "Confermata"}
                    </p>
                  </div>
                </section>

                {context.assignment?.hasInactiveReferences ||
                context.assignment?.hasUnavailableRoomReference ? (
                  <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-bold text-amber-950" role="status">
                    Assegnazione grandfathered: contiene riferimenti ora
                    {context.assignment.hasInactiveReferences
                      ? " inattivi"
                      : ""}
                    {context.assignment.hasInactiveReferences &&
                    context.assignment.hasUnavailableRoomReference
                      ? " e"
                      : ""}
                    {context.assignment.hasUnavailableRoomReference
                      ? " indisponibili per il servizio"
                      : ""}
                    . Puoi conservarli, ma non introdurne di nuovi.
                  </p>
                ) : null}

                {context.reservation.status === "CANCELLED" ? (
                  <section className="rounded-xl bg-zinc-100 p-5">
                    {context.assignment ? (
                      <div className="space-y-3">
                        <p className="font-black text-zinc-950">
                          Sala definitiva: {context.assignment.room.name}
                        </p>
                        <p className="text-sm font-bold text-zinc-700">
                          Tavoli: {context.assignment.tables.map((table) => table.name).join(", ") || "DA ASSEGNARE"}
                        </p>
                        <p className="whitespace-pre-wrap text-sm text-zinc-700">
                          <strong>Note interne:</strong>{" "}
                          {context.assignment.internalNotes ?? "Nessuna"}
                        </p>
                      </div>
                    ) : (
                      <p className="font-bold text-zinc-600">
                        Nessuna assegnazione storica presente.
                      </p>
                    )}
                  </section>
                ) : (
                  <>
                    <label className="block text-sm font-black text-zinc-800">
                      Sala definitiva
                      <select
                        className="mt-2 block min-h-12 w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-base outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-100"
                        data-testid="assignment-room-select"
                        disabled={submitting || conflict}
                        onChange={(event) => changeRoom(event.target.value)}
                        value={selectedRoomId}
                      >
                        <option value="">Seleziona manualmente…</option>
                        {context.rooms.map((room) => {
                          const state = roomStateLabel(
                            room,
                            context.reservation.isHistorical,
                          );
                          return (
                            <option
                              disabled={!roomCanBeSelected(room)}
                              key={room.id}
                              value={room.id}
                            >
                              {room.name}
                              {room.id === currentRoomId ? " · attuale" : ""}
                              {state ? ` · ${state}` : ""}
                            </option>
                          );
                        })}
                      </select>
                    </label>

                    <fieldset className="min-w-0 rounded-xl border border-zinc-200 p-4" aria-describedby={`assignment-tables-help-${props.reservationId}`}>
                      <legend className="px-1 font-black text-zinc-950">
                        Tavoli · opzionale ({selectedTableIds.length}/20)
                      </legend>
                      <p className="text-sm text-text-secondary" id={`assignment-tables-help-${props.reservationId}`}>
                        Puoi salvare la sala ora e aggiungere i tavoli più tardi.
                      </p>
                      {tablesReset ? (
                        <p className="mt-2 text-sm text-text-secondary" role="status">
                          Sala cambiata: la selezione tavoli è stata azzerata. I tavoli precedenti non saranno mantenuti al salvataggio.
                        </p>
                      ) : null}
                      {selectedTableIds.length > 0 ? (
                        <button className="mt-3 min-h-11 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-text-secondary focus:outline-none focus:ring-4 focus:ring-orange-200" disabled={submitting || conflict} onClick={() => setSelectedTableIds([])} type="button">
                          Rimuovi tutti i tavoli
                        </button>
                      ) : null}
                      {!selectedRoom ? (
                        <p className="mt-3 text-sm font-bold text-zinc-500">
                          Seleziona prima la sala definitiva.
                        </p>
                      ) : selectedRoom.tables.length === 0 ? (
                        <p className="mt-3 text-sm text-text-secondary">
                          Nessun tavolo configurato. Puoi salvare la sala senza tavoli.
                        </p>
                      ) : (
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          {selectedRoom.tables.map((table) => {
                            const selected = selectedTableIds.includes(table.id);
                            const retainedInactive =
                              selectedRoom.id === currentRoomId &&
                              currentTableIds.has(table.id);
                            const selectable = table.isActive || retainedInactive;
                            return (
                              <label
                                className={`flex min-h-16 items-start gap-3 rounded-xl border p-3 ${
                                  selected
                                    ? "border-orange-400 bg-orange-50"
                                    : "border-zinc-200 bg-white"
                                } ${selectable ? "cursor-pointer" : "cursor-not-allowed opacity-55"}`}
                                key={table.id}
                              >
                                <input
                                  checked={selected}
                                  className="mt-1 size-5 accent-orange-600"
                                  disabled={submitting || conflict || !selectable || (!selected && selectedTableIds.length >= 20)}
                                  onChange={() => toggleTable(table.id)}
                                  type="checkbox"
                                />
                                <span className="min-w-0">
                                  <span className="block font-black text-zinc-950">
                                    {table.name}
                                    {!table.isActive ? " · inattivo" : ""}
                                  </span>
                                  <span className="mt-1 block text-xs font-bold text-zinc-500">
                                    Posti informativi: min {table.minimumSeats}, max {table.maximumSeats}
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </fieldset>

                    <label className="block text-sm font-black text-zinc-800">
                      Note interne Staff/Admin
                      <textarea
                        className="mt-2 block min-h-28 w-full rounded-xl border border-zinc-300 px-4 py-3 text-base outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-100"
                        data-testid="assignment-internal-notes"
                        disabled={submitting || conflict}
                        aria-describedby={`assignment-notes-help-${props.reservationId}`}
                        aria-invalid={noteCodePoints > 1_000}
                        onChange={(event) => setInternalNotes(event.target.value)}
                        rows={4}
                        value={internalNotes}
                      />
                      <span
                        id={`assignment-notes-help-${props.reservationId}`}
                        className={`mt-1 block text-xs font-bold ${noteCodePoints > 1_000 ? "text-red-700" : "text-zinc-500"}`}
                      >
                        {noteCodePoints}/1000 caratteri Unicode. Non sono note visibili al cliente.
                      </span>
                    </label>

                    {!validTableCount && selectedRoom ? (
                      <p className="text-sm font-bold text-red-700" role="alert">
                        Seleziona al massimo 20 tavoli distinti.
                      </p>
                    ) : null}

                    <div className="flex flex-wrap gap-3 border-t border-zinc-200 pt-5">
                      <button
                        className="min-h-12 rounded-xl bg-orange-500 px-5 py-3 font-black text-zinc-950 hover:bg-orange-600 focus:outline-none focus:ring-4 focus:ring-orange-200 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid="assignment-save"
                        disabled={!canSave}
                        onClick={() => void saveAssignment()}
                        type="button"
                      >
                        {submitting ? "Salvataggio…" : "Salva assegnazione"}
                      </button>

                      {context.assignment && !confirmingClear ? (
                        <button
                          className="min-h-12 rounded-xl border border-red-300 px-5 py-3 font-black text-red-700 hover:bg-red-50 focus:outline-none focus:ring-4 focus:ring-red-100"
                          disabled={submitting || conflict}
                          onClick={() => setConfirmingClear(true)}
                          type="button"
                        >
                          Rimuovi assegnazione
                        </button>
                      ) : null}
                    </div>

                    {confirmingClear ? (
                      <div className="rounded-xl border border-red-200 bg-red-50 p-4" role="alertdialog">
                        <p className="font-black text-red-950">
                          Confermi la rimozione logica dell&apos;assegnazione?
                        </p>
                        <p className="mt-1 text-sm text-red-800">
                          La preferenza storica di sala resterà invariata.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            className="min-h-11 rounded-lg bg-red-700 px-4 py-2 font-black text-white disabled:opacity-50"
                            data-testid="assignment-clear-confirm"
                            disabled={submitting}
                            onClick={() => void clearAssignment()}
                            type="button"
                          >
                            {submitting ? "Rimozione…" : "Sì, rimuovi"}
                          </button>
                          <button
                            className="min-h-11 rounded-lg bg-white px-4 py-2 font-bold text-zinc-800"
                            disabled={submitting}
                            onClick={() => setConfirmingClear(false)}
                            type="button"
                          >
                            Indietro
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            {dialogError ? (
              <div ref={errorRef} id={`assignment-error-${props.reservationId}`} tabIndex={-1} className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-800 outline-none focus:ring-4 focus:ring-red-100" role="alert">
                <p>{dialogError}</p>
                {conflict ? (
                  <button
                    className="mt-3 min-h-11 rounded-lg bg-zinc-950 px-4 py-2 font-black text-white focus:outline-none focus:ring-4 focus:ring-orange-200"
                    data-testid="assignment-reload-conflict"
                    disabled={loading || submitting}
                    onClick={() => void reloadAfterConflict()}
                    type="button"
                  >
                    Ricarica stato corrente
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
