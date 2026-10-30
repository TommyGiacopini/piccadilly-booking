"use client";

import { useState } from "react";
import type { ExportPreviewDto, ExportPreviewRow } from "@/modules/exports/domain/export-contract";

function localInstant(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("it-IT", { timeZone: timezone, dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}
function composition(row: ExportPreviewRow): string {
  if (row.childrenCount === null) return row.legacyChildren
    ? "Composizione non specificata · Bambini segnalati senza conteggio" : "Composizione non specificata";
  return row.childrenCount === 0 ? "TA · Tutti adulti" : "Adulti " + row.adultsCount + " · Bimbi (" + row.childrenCount + ")";
}
function requests(row: ExportPreviewRow): string[] {
  return [
    row.gameRoomPreference === true ? "Giochi richiesti — non garantiti" : row.gameRoomPreference === false ? "Giochi non richiesti" : null,
    row.preferredRoom !== "Non indicata" ? "Preferenza storica: " + row.preferredRoom : null,
    row.highChair ? "Seggiolone" : null, row.stroller ? "Passeggino" : null,
    row.accessibility ? "Accessibilità" : null, row.celiac ? "Celiachia dichiarata" : null,
    row.allergies ? "Allergie: " + row.allergies : null, row.intolerances ? "Intolleranze: " + row.intolerances : null,
    row.celebration ? "Ricorrenza: " + row.celebration : null, row.animals ? "Animali" : null,
  ].filter((item): item is string => item !== null);
}
export function ExportPreview({ data }: { data: ExportPreviewDto }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(data.summary.reservationCount / 100));
  const start = page * 100, end = start + 100;
  return <section aria-labelledby="export-preview-results-title" className="mt-5 min-w-0" data-testid="export-preview-results">
    <h4 className="text-lg font-black" id="export-preview-results-title">Dati operativi — {data.restaurantName}</h4>
    <p className="mt-2 text-sm">{data.selection.period.date} · {data.selection.service === "LUNCH" ? "Pranzo" : "Cena"} · Ordine dentro ogni sala: {data.selection.order === "CREATED_ASC" ? "creazione crescente" : data.selection.order === "NAME_ASC" ? "cognome/nome A–Z" : "ora di arrivo"}</p>
    <p className="mt-1 text-sm text-zinc-600">Fonte: PostgreSQL · Lettura eseguita alle {localInstant(data.readAt, data.timezone)} ({data.timezone}). Eventuali modifiche successive possono cambiare un documento generato in seguito.</p>
    <p className="mt-3 font-bold">{data.summary.reservationCount} prenotazioni · {data.summary.partySizeTotal} coperti totali</p>
    <p className="text-sm">Adulti {data.summary.knownAdultsTotal} · Bambini {data.summary.knownChildrenTotal}
      {data.summary.unknownCompositionCount > 0 ? " — totali parziali: composizione sconosciuta per " + data.summary.unknownCompositionCount + " prenotazioni" : " — composizione interamente dichiarata"}.</p>
    {data.summary.reservationCount === 0 && <p className="mt-3" role="status">Nessuna prenotazione confermata per la selezione.</p>}
    {data.groups.map((group, groupIndex) => {
      const groupStart = data.groups.slice(0, groupIndex).reduce((sum, item) => sum + item.rows.length, 0);
      const rows = group.rows.slice(Math.max(0, start - groupStart), Math.max(0, Math.min(group.rows.length, end - groupStart)));
      if (group.rows.length && !rows.length) return null;
      return <section key={group.key} aria-labelledby={"preview-room-" + group.key} className="mt-5 min-w-0">
        <h5 id={"preview-room-" + group.key} className="font-black">{group.label}</h5>
        <p className="mb-2 text-sm">{group.summary.reservationCount} prenotazioni · {group.summary.partySizeTotal} coperti</p>
        {!group.rows.length ? <p className="text-sm text-zinc-600">Nessuna prenotazione confermata in questo gruppo.</p> :
          <div className="max-w-full overflow-x-auto rounded-lg border border-zinc-200" role="region" aria-label={"Tabella " + group.label} tabIndex={0}>
            <table className="w-full min-w-[760px] text-left text-sm">
              <caption className="sr-only">{group.label}, dati operativi della selezione corrente</caption>
              <thead className="bg-zinc-100"><tr>{["Nome e cognome", "Coperti", "Sala", "Tavolo", "Arrivo previsto", "Note/richieste", "Prenotata il"].map(label => <th className="px-3 py-2 align-top" scope="col" key={label}>{label}</th>)}</tr></thead>
              <tbody>{rows.map(row => <tr key={row.ordinal} className="border-t border-zinc-200">
                <th scope="row" className="max-w-48 break-words px-3 py-3 align-top">{row.customerFirstName} {row.customerLastName}</th>
                <td className="px-3 py-3 align-top"><strong>{row.partySize}</strong><p className="mt-1 min-w-28">{composition(row)}</p></td>
                <td className="px-3 py-3 align-top">{row.actualRoom?.label ?? "DA ASSEGNARE"}</td>
                <td className="px-3 py-3 align-top">{row.tableNames.join(", ") || "Non indicato"}</td>
                <td className="px-3 py-3 align-top">{row.arrivalTime}</td>
                <td className="min-w-44 max-w-80 break-words px-3 py-3 align-top">
                  {requests(row).length > 0 && <ul className="list-inside list-disc">{requests(row).map((text, index) => <li key={index}>{text}</li>)}</ul>}
                  {row.notes !== null && row.notes !== "" && <p className="mt-2 whitespace-pre-wrap"><strong>NC: </strong>{row.notes}</p>}
                  {!requests(row).length && !row.notes && "Nessuna richiesta indicata"}
                </td>
                <td className="px-3 py-3 align-top">{localInstant(row.createdAt, data.timezone)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
      </section>;
    })}
    {totalPages > 1 && <nav aria-label="Pagine anteprima" className="mt-4 flex flex-wrap items-center gap-3">
      <button type="button" className="min-h-11 rounded-lg border px-4 focus:ring-4 focus:ring-orange-200" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Pagina precedente</button>
      <span role="status">Pagina {page + 1} di {totalPages} · Tutte le {data.summary.reservationCount} righe sono consultabili</span>
      <button type="button" className="min-h-11 rounded-lg border px-4 focus:ring-4 focus:ring-orange-200" disabled={page + 1 === totalPages} onClick={() => setPage(value => value + 1)}>Pagina successiva</button>
    </nav>}
  </section>;
}

