"use client";
import { reservationCompositionPresentation } from "@/modules/dashboard/domain/reservation-row-presentation";
import { roomOperationalPresentation } from "@/modules/rooms/domain/room-operational-presentation";
import type { WorkspaceReservation, WorkspaceRoom } from "@/modules/rooms/domain/room-assignment-workspace";

export function RoomAssignmentRows({ rows, rooms, selectedId, onSelect, onChangeRoom, onDetail }: {
  rows: readonly WorkspaceReservation[]; rooms: readonly WorkspaceRoom[]; selectedId: string | null;
  onSelect: (id: string) => void; onChangeRoom: (id: string, roomId: string) => void; onDetail: (id: string) => void;
}) {
  return <ul className="space-y-3">{rows.map(row => <li key={row.id} data-room-reservation={row.id} className="min-w-0 rounded-xl border border-border bg-surface p-3 [overflow-wrap:anywhere]">
    <div className="flex flex-wrap items-center gap-3"><label className="flex min-h-11 items-center gap-2 font-semibold"><input type="radio" name="workspace-reservation" checked={selectedId === row.id} onChange={() => onSelect(row.id)} />{row.name}</label>
      <strong>{row.partySize} coperti</strong><strong>{row.arrivalTime}</strong><span>{reservationCompositionPresentation(row).label}</span>
      <button className="min-h-11 underline" type="button" onClick={() => onDetail(row.id)}>Dettaglio e note</button>
      {row.roomId ? <label className="ml-auto">Sala<select className="ml-2 min-h-11 max-w-full rounded border border-border bg-white p-2" aria-label={"Cambia sala per " + row.name} value={row.roomId} onChange={e => onChangeRoom(row.id, e.target.value)}>
        {rooms.map(room => <option key={room.id} value={room.id} disabled={room.id !== row.roomId && (!room.isActive || room.isAvailable === false)}>{roomOperationalPresentation(room).label}</option>)}
      </select></label> : null}
    </div>
    <div className="mt-2 flex flex-wrap gap-2 text-sm" aria-label="Indicatori note">
      <span>NC condivisa {row.notesPresent ? <strong>presente</strong> : "assente"}</span>
      <span>NI autonoma {row.privateNotesPresent ? <strong>presente</strong> : "assente"}</span>
      <span>NI legacy {row.legacyNotesPresent ? <strong>presente · {row.legacyNotesState === "CLEARED" ? "rimossa" : "attiva"}</strong> : "assente"}</span>
    </div>
    {row.requirements.length ? <p className="mt-2 font-semibold">{row.requirements.join(" · ")}</p> : null}
    {row.legacyTableCount > 0 ? <p className="text-sm">Collegamenti tavoli legacy conservati: {row.legacyTableCount}. Cambio sala bloccato.</p> : null}
    {row.roomId ? <p className="text-xs text-text-muted">{row.roomAssignedAt ? "Ingresso nella sala: " + row.roomAssignedAt : "Momento di assegnazione non disponibile"}</p> : null}
  </li>)}</ul>;
}
