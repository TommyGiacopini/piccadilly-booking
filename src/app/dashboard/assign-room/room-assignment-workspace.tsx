"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StaffSensitiveRegion, useStaffDraftHost, useStaffHostView } from "@/app/_components/staff/staff-draft-host";
import { sameDraftSession, type StaffDraftIdentity } from "@/modules/dashboard/domain/staff-draft-state";
import { RoomAssignmentEditor } from "@/app/dashboard/reservation-assignment-panel";
import { ReservationDetailPanel } from "@/app/dashboard/reservation-detail-panel";
import { roomOperationalPresentation } from "@/modules/rooms/domain/room-operational-presentation";
import { orderWorkspaceReservations, workspaceQuerySchema, type RoomAssignmentWorkspace as Workspace, type WorkspaceQuery } from "@/modules/rooms/domain/room-assignment-workspace";
import { RoomAssignmentRows } from "./room-assignment-room-view";

const button = "min-h-11 min-w-11 rounded-lg border border-border bg-surface px-3 py-2 focus:ring-4 focus:ring-orange-200 disabled:opacity-50";
export function RoomAssignmentWorkspace({ data, owner }: { data: Workspace; owner: StaffDraftIdentity }) {
  const host = useStaffDraftHost(), view = useStaffHostView(), router = useRouter(), [refreshing, startTransition] = useTransition();
  const [selection, setSelection] = useState<{ id: string; context: string } | null>(null), [editing, setEditing] = useState<{ id: string; roomId: string } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null), [secondary, setSecondary] = useState(false), [status, setStatus] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const authorized = host.sessionVisible() && !!view.drafts.identity && sameDraftSession(view.drafts.identity, owner);
  useEffect(() => { void host.verifySession(); }, [host]);
  useEffect(() => { const refreshOnFocus = () => { startTransition(() => router.refresh()); }; window.addEventListener("focus", refreshOnFocus); return () => window.removeEventListener("focus", refreshOnFocus); }, [router]);
  const contextKey = data.query.date + ":" + data.query.service;
  // A selection is valid only in the service snapshot in which it was made.
  const selected = selection?.context === contextKey ? data.reservations.find(r => r.id === selection.id) : null;
  const room = data.rooms.find(r => r.code === data.query.room);
  const rows = orderWorkspaceReservations(data.reservations.filter(r => room ? r.roomId === room.id : r.roomId === null), data.query.order);
  function navigate(patch: Partial<WorkspaceQuery>) {
    const query = { ...data.query, ...patch }, params = new URLSearchParams(query);
    host.requestExit(() => { setSelection(null); setEditing(null); host.prepareNavigation(); router.push("/dashboard/assign-room?" + params); });
  }
  function refresh() { setStatus("Aggiornamento del servizio in corso. Lo snapshot resta quello indicato fino alla nuova lettura."); startTransition(() => router.refresh()); }
  function edit(id: string, target: string) {
    host.requestExit(() => { host.invalidateRoomResource(id); setEditing({ id, roomId: target }); setStatus(null); });
  }
  function detail(id: string) {
    host.requestExit(() => { if (window.innerWidth >= 1024) setDetailId(id); else { host.prepareNavigation(); router.push("/dashboard/reservations/" + id); } });
  }
  function closeEditor() { setEditing(null); requestAnimationFrame(() => heading.current?.focus()); }
  const mainRooms = data.rooms.filter(r => roomOperationalPresentation(r).category !== "LEGACY"), legacyRooms = data.rooms.filter(r => roomOperationalPresentation(r).category === "LEGACY");
  function cards(rooms: typeof data.rooms) { return <div className="grid gap-3 sm:grid-cols-3">{rooms.map(r => <section key={r.id} data-room-summary={r.code} className="rounded-xl border border-border p-3">
    <button type="button" className="min-h-11 text-left text-lg font-semibold underline" disabled={!workspaceQuerySchema.shape.room.safeParse(r.code).success} onClick={() => { const parsed = workspaceQuerySchema.shape.room.safeParse(r.code); if (parsed.success) navigate({ room: parsed.data }); }}>{roomOperationalPresentation(r).label}</button>
    <p>{r.reservations} prenotazioni · {r.covers} coperti</p><p className="text-sm">{!r.isActive ? "Sala inattiva" : r.isAvailable === null ? "Storico: disponibilità passata non ricostruita" : r.isAvailable ? "Disponibile per il servizio" : "Indisponibile per il servizio"}</p>
    <button className={button} type="button" aria-label={"Assegna selezionata a " + roomOperationalPresentation(r).label} disabled={!selected || !r.isActive || r.isAvailable === false || selected.roomId === r.id} onClick={() => selected && edit(selected.id, r.id)}>+</button>
  </section>)}</div>; }
  return <>
    <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold">ASSEGNA SALA</h1>
    {!authorized ? <><p role="status">Verifica della sessione e dello snapshot Staff…</p><button className={button} type="button" onClick={() => { void host.verifySession().then(() => router.refresh()); }}>Verifica e ricarica</button></> : null}
    <StaffSensitiveRegion allowed={authorized}>{authorized ? <div className="mt-4 space-y-5">
      <div className="flex flex-wrap items-end gap-3"><label>Data<input className={button + " block"} type="date" value={data.query.date} onChange={e => { if (e.target.value) navigate({ date: e.target.value }); }} /></label>
        <label>Servizio<select className={button + " block"} value={data.query.service} onChange={e => navigate({ service: e.target.value as "LUNCH" | "DINNER" })}><option value="LUNCH">Pranzo</option><option value="DINNER">Cena</option></select></label>
        <label>Ordina per<select className={button + " block"} value={data.query.order} onChange={e => navigate({ order: e.target.value as WorkspaceQuery["order"] })}><option value="ARRIVAL">Ora di arrivo</option><option value="ASSIGNMENT">Ingresso nella sala</option><option value="CREATION">Creazione prenotazione</option></select></label>
        <button className={button} type="button" disabled={refreshing} onClick={refresh}>Ricarica servizio</button>
        <button className={button} type="button" onClick={() => host.requestExit(() => { host.prepareNavigation(); router.push("/dashboard?date=" + data.query.date + "&service=" + data.query.service); })}>Torna Agenda</button>
      </div>
      <p className="text-sm">Snapshot servizio: {data.snapshotAt}. Riepiloghi informativi; non indicano capacità o posti disponibili per sala.</p>
      {status ? <p role="status">{status}</p> : null}
      {room ? <><h2 className="text-xl font-semibold">{roomOperationalPresentation(room).label} · {data.query.date} · {data.query.service === "DINNER" ? "Cena" : "Pranzo"}</h2><button className={button} type="button" onClick={() => navigate({ room: "ALL" })}>Tutte le sale</button><p>{room.reservations} prenotazioni · {room.covers} coperti</p></> : <>
        {cards(mainRooms)}<button type="button" className={button} aria-expanded={secondary} onClick={() => setSecondary(!secondary)}>Galleria e Terrazzo · aree legacy</button>{secondary ? cards(legacyRooms) : null}
        <h2 className="text-xl font-semibold">Da assegnare · {rows.length}</h2>
      </>}
      {selected ? <p role="status">Selezionata: {selected.name} · {selected.partySize} coperti · {selected.arrivalTime} <button className={button} type="button" onClick={() => setSelection(null)}>Deseleziona</button></p> : null}
      {rows.length ? <RoomAssignmentRows rows={rows} rooms={data.rooms} selectedId={selected?.id ?? null} onSelect={id => setSelection({ id, context: contextKey })} onChangeRoom={edit} onDetail={detail} /> : <p>Nessuna prenotazione in questa vista.</p>}
    </div> : null}</StaffSensitiveRegion>
    {editing && authorized ? <RoomAssignmentEditor key={editing.id} reservationId={editing.id} targetRoomId={editing.roomId} expectedDate={data.query.date} expectedService={data.query.service} onClose={closeEditor} onCommitted={() => { setStatus("Assegnazione salvata. Aggiornamento dello snapshot in corso."); startTransition(() => router.refresh()); }} /> : null}
    {detailId && authorized ? <ReservationDetailPanel reservationId={detailId} timezone={data.timezone} onClose={() => { setDetailId(null); router.refresh(); requestAnimationFrame(() => heading.current?.focus()); }} /> : null}
  </>;
}
