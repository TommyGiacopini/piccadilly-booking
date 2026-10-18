"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useStaffDraftHost, useStaffOverlay } from "@/app/_components/staff/staff-draft-host";
import { ReservationDetailContent } from "./reservation-detail-content";
import { useAgendaContext } from "./agenda-context";

// Its parent fixes the surface when opening; CSS resize never changes its key.
export function ReservationDetailPanel({ reservationId, timezone, onClose }: { reservationId: string; timezone: string; onClose: () => void }) {
  const controller = useStaffDraftHost(), agenda = useAgendaContext(), ref = useRef<HTMLDivElement>(null), [assignmentOpen, setAssignmentOpen] = useState(false);
  function close() { controller.requestExit(() => { controller.closePrivateNotes(reservationId); onClose(); }); }
  const ownsFocus = useStaffOverlay(!assignmentOpen, "reservation-detail-" + reservationId, ref, close);
  return <div className="fixed inset-0 z-50 bg-black/50" onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={ref} role={ownsFocus ? "dialog" : undefined} aria-modal={ownsFocus || undefined} aria-label="Dettaglio prenotazione" tabIndex={-1}
      className="absolute inset-y-0 right-0 w-full max-w-2xl overflow-y-auto bg-surface p-4 shadow-xl sm:p-6">
      <div className="mb-4 flex flex-wrap justify-between gap-3"><button type="button" className="min-h-11 underline" onClick={close}>Chiudi dettaglio</button>
        <Link className="inline-flex min-h-11 items-center underline" href={"/dashboard/reservations/" + reservationId} onNavigate={event => { event.preventDefault(); agenda.navigate("/dashboard/reservations/" + reservationId); }}>Apri come pagina</Link></div>
      <ReservationDetailContent reservationId={reservationId} timezone={timezone} onAssignmentOpenChange={setAssignmentOpen} />
    </div>
  </div>;
}
