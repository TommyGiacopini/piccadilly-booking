"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { buttonClassName } from "@/app/_components/ui/button";
import type { StaffDraftController, StaffNavigationIntent } from "./staff-draft-host";

export function StaffNavigationGuard({ controller, intent }: { controller: StaffDraftController; intent: StaffNavigationIntent | null }) {
  const dialog = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  useLayoutEffect(() => {
    if (!intent || !dialog.current) return;
    controller.claimOverlay("navigation-guard", dialog.current, () => controller.resolveExit("STAY"));
    return () => controller.releaseOverlay("navigation-guard");
  }, [controller, intent]);
  if (!intent) return null;
  const records = intent.keys.map(key => controller.getSnapshot().drafts.records[key]).filter(record => record !== undefined);
  return <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/60 p-3">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="staff-draft-exit-title" tabIndex={-1} className="max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-surface border border-border bg-surface p-5">
      <h2 id="staff-draft-exit-title" className="text-heading-sm font-semibold">Modifiche non salvate</h2>
      <p className="mt-3 text-sm">{intent.purpose === "LOGOUT" ? "Il logout confermato elimina tutte le bozze della sessione, comprese quelle conservate e non aperte. Puoi restare oppure confermare questa perdita." : "Puoi restare o uscire conservando temporaneamente la bozza in questa scheda. Reload, chiusura e fine sessione non garantiscono recupero."}</p>
      {records.some(record => record.phase === "PENDING") ? <p className="mt-3 text-sm font-semibold">Una richiesta è in corso. Se già inviata, uscire non annulla l’operazione server. La verifica pre-invio non è ancora una mutation. I campi restano bloccati fino all’esito.</p> : null}
      {records.map(record => intent.purpose === "LOGOUT" ? <p className="mt-3 text-sm" key={record.key}>Bozza {record.kind}: {record.phase === "PENDING" ? "richiesta in corso, non annullata dal logout" : "modifiche non salvate"}</p> : <label key={record.key} className="mt-3 flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" disabled={record.phase === "PENDING"} checked={selected.includes(record.key)} onChange={event => setSelected(current => event.target.checked ? [...current, record.key] : current.filter(key => key !== record.key))} />
        Scarta soltanto la bozza {record.kind}{record.phase === "PENDING" ? " (richiesta in corso)" : ""}
      </label>)}
      <div className="mt-4 flex flex-wrap gap-2">
        <button className={buttonClassName("secondary")} onClick={() => controller.resolveExit("STAY")} type="button">Resta</button>
        <button className={buttonClassName()} onClick={() => controller.resolveExit("KEEP")} type="button">{intent.purpose === "LOGOUT" ? "Conferma logout e perdita delle bozze" : "Esci conservando la bozza"}</button>
        {intent.purpose !== "LOGOUT" ? <button className={buttonClassName("secondary")} disabled={!selected.some(key => intent.keys.includes(key)) || selected.some(key => controller.getSnapshot().drafts.records[key]?.phase === "PENDING")} onClick={() => { controller.resolveExit("DISCARD", selected.filter(key => intent.keys.includes(key))); setSelected([]); }} type="button">Scarta selezionate ed esci</button> : null}
      </div>
    </div>
  </div>;
}
