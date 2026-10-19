"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { StaffSensitiveRegion, useStaffDraftBinding, useStaffDraftHost, useStaffHostView, useStaffOverlay, useStaffResource } from "@/app/_components/staff/staff-draft-host";
import type { RoomAssignmentResult } from "@/modules/rooms/domain/room-assignment-workspace";
import { roomOperationalPresentation } from "@/modules/rooms/domain/room-operational-presentation";

const control = "min-h-11 min-w-11 rounded-lg border border-zinc-300 bg-white px-3 py-2 focus:outline-none focus:ring-4 focus:ring-orange-200 disabled:opacity-50";
function result(value: unknown, id: string): RoomAssignmentResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<RoomAssignmentResult>;
  return v.reservationId === id && typeof v.changed === "boolean" && Number.isInteger(v.reservationVersion) && v.reservationVersion! > 0 && v.assignment?.id && v.assignment.roomId ? v as RoomAssignmentResult : null;
}
/** Shared room-only editor. Hidden legacy fields never enter its command. */
export function RoomAssignmentEditor({ reservationId, targetRoomId, expectedDate, expectedService, onClose, onCommitted }: {
  reservationId: string; targetRoomId?: string; expectedDate?: string; expectedService?: "LUNCH" | "DINNER";
  onClose: () => void; onCommitted?: (message: string) => void;
}) {
  const resource = useStaffResource("ASSIGNMENT", reservationId), context = resource.data, router = useRouter();
  const staffResource = useStaffResource("STAFF", reservationId), staff = staffResource.data;
  const host = useStaffDraftHost(), ref = useRef<HTMLDivElement>(null), errorRef = useRef<HTMLDivElement>(null);
  const [review, setReview] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const values = useMemo(() => ({ roomId: context?.assignment?.room.id ?? "", expectedLocalDate: expectedDate ?? context?.reservation.localDate ?? "", expectedServiceType: expectedService ?? context?.reservation.serviceType ?? "DINNER" }), [expectedDate, expectedService, context?.assignment?.room.id, context?.reservation.localDate, context?.reservation.serviceType]);
  const binding = useStaffDraftBinding({ kind: "ROOM", resourceId: reservationId, values, version: context?.reservation.version ?? null,
    route: "/dashboard/reservations/" + reservationId,
    originPath: "/dashboard?date=" + (expectedDate ?? context?.reservation.localDate ?? "") + "&service=" + (expectedService ?? context?.reservation.serviceType ?? "DINNER"), allowed: !!context && context.reservation.status === "CONFIRMED" });
  const record = binding.record, pending = record?.phase === "PENDING", conflict = record?.phase === "DIRTY_CONFLICT";
  const appliedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (record && targetRoomId && appliedTarget.current !== record.instanceId) {
      appliedTarget.current = record.instanceId;
      if (record.phase === "CLEAN" && record.values.roomId !== targetRoomId) binding.patch({ roomId: targetRoomId });
    }
  }, [record, targetRoomId, binding]);
  function close() { host.requestExit(() => { const current = binding.key ? host.getSnapshot().drafts.records[binding.key] : null; if (current?.phase === "CLEAN") host.discard(current.key); onClose(); }, binding.key ? [binding.key] : []); }
  const ownsFocus = useStaffOverlay(true, "assignment-" + reservationId, ref, close);
  useEffect(() => { if (record?.error) errorRef.current?.focus(); }, [record?.error]);
  const roomId = String(record?.values.roomId ?? ""), currentId = context?.assignment?.room.id;
  const target = context?.rooms.find(r => r.id === roomId);
  const reservationName = staff ? [staff.customer.firstName, staff.customer.lastName].join(" ").trim() : "";
  // These are independent authorized reads, not an atomic snapshot. Do not
  // offer confirmation with missing identity or contradictory resource data.
  const identityReady = !!staff && !!context && reservationName.length > 0 && Number.isInteger(staff.partySize) && staff.partySize > 0 &&
    /^\d{2}:\d{2}$/u.test(staff.arrivalTime) && staff.id === context.reservation.id && staff.version === context.reservation.version &&
    staff.status === context.reservation.status && staff.localDate === context.reservation.localDate &&
    staff.serviceType === context.reservation.serviceType && staff.arrivalTime === context.reservation.arrivalTime;
  const canSelect = (id: string) => { const r = context?.rooms.find(r => r.id === id); return !!r && (id === currentId || r.isActive && (context?.reservation.isHistorical || r.isAvailableForService === true)); };
  async function save() {
    if (!record || pending || conflict || !identityReady || !canSelect(roomId)) return;
    const payload = JSON.stringify({ version: record.baseVersion, roomId, expectedLocalDate: record.values.expectedLocalDate, expectedServiceType: record.values.expectedServiceType });
    const outcome = await host.mutate({ key: record.key, url: "/api/staff/reservations/" + reservationId + "/room-assignment", method: "POST", payload,
      validate: value => { const v = result(value, reservationId); return v ? { resourceId: reservationId, version: v.reservationVersion, text: v.changed ? "Assegnazione salvata." : "Nessuna modifica: la sala era già aggiornata." } : null; } });
    if (outcome.confirmed && outcome.foreground) { host.discard(record.key); onCommitted?.(outcome.receipt?.text ?? "Assegnazione confermata."); onClose(); router.refresh(); }
  }
  async function reload() { setReview(false); const loaded = await Promise.all([resource.reload(), staffResource.reload()]); if (loaded.every(Boolean)) setReview(true); }
  function reapply(keepChoice: boolean) {
    if (!record || !context || !review || resource.reloadStatus !== "RELOADED_SNAPSHOT_CONFIRMED") return;
    host.review(record.key, { version: context.reservation.version, serverValues: { roomId: context.assignment?.room.id ?? "", expectedLocalDate: context.reservation.localDate, expectedServiceType: context.reservation.serviceType }, selectedFields: keepChoice ? ["roomId"] : [] });
    setReview(false); setNotice("Dati riletti adottati. Verifica la destinazione e conferma esplicitamente.");
  }
  return <div ref={ref} role={ownsFocus ? "dialog" : undefined} aria-modal={ownsFocus || undefined} inert={!ownsFocus}
    aria-labelledby={"assignment-title-" + reservationId} aria-describedby={record?.error ? "assignment-error-" + reservationId : identityReady ? "assignment-identity-" + reservationId : undefined}
    aria-busy={pending || !resource.ready || !staffResource.ready} tabIndex={-1} data-testid="assignment-dialog" className="fixed inset-0 z-50 overflow-y-auto bg-black/60 p-3 [overflow-wrap:anywhere] sm:p-6">
    <div className="mx-auto my-3 w-full max-w-2xl space-y-4 rounded-2xl bg-white p-5">
      <div className="flex items-start justify-between gap-3"><h2 id={"assignment-title-" + reservationId} className="text-xl font-semibold">Sala definitiva e riferimenti legacy</h2>
        <button className={control} type="button" aria-label="Chiudi gestione assegnazione" onClick={close}>×</button></div>
      {!context ? <><p role="status">Verifica accesso e caricamento dello stato corrente…</p>{resource.error ? <p role="alert">{resource.error}</p> : null}<button className={control} type="button" onClick={() => void resource.reload()}>Riprova lettura</button></> : null}
      <StaffSensitiveRegion allowed={!!context}>{context ? <>
        {identityReady ? <section id={"assignment-identity-" + reservationId} data-testid="assignment-reservation-summary" className="space-y-1 rounded-lg border-2 border-orange-400 bg-orange-50 p-3">
          <p className="font-semibold">Prenotazione: {reservationName}</p>
          <p>{staff.partySize} coperti · Arrivo previsto: {staff.arrivalTime}</p>
          <p>Sala attuale: {context.assignment ? roomOperationalPresentation(context.assignment.room).label : "DA ASSEGNARE"}</p>
          <p className="font-semibold">Sala di destinazione: {target ? roomOperationalPresentation(target).label : "Seleziona una sala"}</p>
        </section> : <div role="status"><p>Identificazione della prenotazione non disponibile o non allineata. Conferma sospesa fino alla lettura dei dati Staff.</p>
          {staffResource.error ? <p>{staffResource.error}</p> : null}<button className={control} type="button" disabled={pending || resource.reloadStatus === "RELOAD_IN_PROGRESS" || staffResource.reloadStatus === "RELOAD_IN_PROGRESS"} onClick={() => void reload()}>Rileggi identificazione e assegnazione</button></div>}
        <p>Preferenza storica di sala: <span>{context.reservation.originalRoomPreference.roomName ?? context.reservation.originalRoomPreference.roomCode ?? "Non specificata"}</span></p>
        <p>{context.reservation.status === "CANCELLED" ? "Cancellata · assegnazione solo storica" : context.reservation.isHistorical ? "Storica · correzione Staff/Admin consentita" : "Confermata"}</p>
        {context.assignment?.hasInactiveReferences || context.assignment?.hasUnavailableRoomReference ? <p role="status">Assegnazione grandfathered: riferimenti ora inattivi o indisponibili conservati. Puoi conservarli, ma non introdurne di nuovi.</p> : null}
        <section aria-label="Riferimenti legacy in sola lettura" className="rounded-lg border border-zinc-200 p-3">
          <p>Sala attuale: {context.assignment ? roomOperationalPresentation(context.assignment.room).label + (roomOperationalPresentation(context.assignment.room).category === "LEGACY" ? " · Area legacy" : "") : "DA ASSEGNARE"}</p>
          <p>Tavoli legacy: {context.assignment?.tables.map(t => t.name).join(", ") || "Nessun collegamento attivo"}</p>
          <p className="whitespace-pre-wrap">Note interne legacy: {context.assignment?.internalNotes ?? "Nessuna nota legacy attiva"}</p>
          <p className="text-sm">I collegamenti ai tavoli e le note legacy non vengono modificati da questo flusso. Le note autonome si consultano nel dettaglio.</p>
        </section>
        {binding.resumeRequired ? <button type="button" className={control} onClick={() => void binding.resume()}>Continua modifica sala</button> : null}
        {record ? <><label className="block font-semibold">Sala definitiva<select data-testid="assignment-room-select" className={control + " mt-2 block w-full"} disabled={pending || conflict || record.phase === "CONFIRMED"} value={roomId} onChange={e => { binding.patch({ roomId: e.target.value }); setNotice(null); }}>
          <option value="">Seleziona manualmente…</option>{context.rooms.map(room => <option key={room.id} value={room.id} disabled={!canSelect(room.id)}>{roomOperationalPresentation(room).label}{roomOperationalPresentation(room).category === "LEGACY" ? " · Area legacy" : ""}{room.id === currentId ? " · attuale" : !room.isActive ? " · inattiva" : !context.reservation.isHistorical && !room.isAvailableForService ? " · indisponibile per il servizio" : ""}</option>)}
        </select></label>
          <p className="font-semibold">Conferma: {context.assignment ? roomOperationalPresentation(context.assignment.room).label : "DA ASSEGNARE"} → {target ? roomOperationalPresentation(target).label : "Seleziona una sala"}</p>
          {record.error ? <div tabIndex={-1} ref={errorRef} role="alert" id={"assignment-error-" + reservationId} aria-describedby={identityReady ? "assignment-identity-" + reservationId : undefined}>{record.error}</div> : null}
          {notice ? <p role="status">{notice}</p> : null}
          {conflict || record.phase === "ERROR" ? <><button className={control} data-testid="assignment-reload-conflict" disabled={pending || resource.reloadStatus === "RELOAD_IN_PROGRESS"} type="button" onClick={() => void reload()}>Rileggi stato canonico</button>
            {resource.reloadStatus === "RELOAD_IN_PROGRESS" ? <p role="status">Rilettura in corso…</p> : null}{resource.reloadStatus === "RELOAD_FAILED" ? <p role="alert">Rilettura fallita. Scelta e versione base conservate.</p> : null}
            {review && resource.reloadStatus === "RELOADED_SNAPSHOT_CONFIRMED" ? <div className="flex flex-wrap gap-2"><button className={control} type="button" onClick={() => reapply(false)}>Adotta sala riletta</button><button className={control} type="button" onClick={() => reapply(true)}>Riapplica scelta su versione riletta</button></div> : null}</> : null}
          <button data-testid="assignment-save" className={control + " font-semibold"} disabled={!identityReady || !canSelect(roomId) || pending || conflict || record.phase === "ERROR"} type="button" onClick={() => void save()}>{pending ? "Salvataggio in corso…" : "Conferma sala"}</button>
        </> : null}
      </> : null}</StaffSensitiveRegion>
    </div>
  </div>;
}
export function ReservationAssignmentPanel(props: { reservationId: string; cancelled: boolean; hasAssignment: boolean; onOpenChange?: (open: boolean) => void }) {
  const host = useStaffDraftHost(), view = useStaffHostView(), [status, setStatus] = useState<string | null>(null), trigger = useRef<HTMLButtonElement>(null);
  // The surface marker survives authorization masking, without duplicating the
  // Agenda and detail editors for the same reservation.
  const owner = (props.onOpenChange ? "DETAIL:" : "AGENDA:") + props.reservationId;
  const open = view.roomSurface === owner;
  const initialOpen = useRef(open), initialCallback = useRef(props.onOpenChange);
  useEffect(() => { if (initialOpen.current) initialCallback.current?.(true); }, []);
  function close() { host.closeRoomSurface(owner); props.onOpenChange?.(false); requestAnimationFrame(() => { if (host.sessionVisible()) trigger.current?.focus(); }); }
  return <div className="mt-4"><button ref={trigger} className={control} type="button" onClick={() => host.requestExit(() => { host.invalidateRoomResource(props.reservationId); host.openRoomSurface(owner); props.onOpenChange?.(true); setStatus(null); })}>
    {props.cancelled ? "Vedi assegnazione storica" : props.hasAssignment ? "Gestisci assegnazione" : "Assegna sala"}</button>
    {status ? <p role="status">{status}</p> : null}
    {open ? <RoomAssignmentEditor reservationId={props.reservationId} onClose={close} onCommitted={setStatus} /> : null}
  </div>;
}
