"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ServiceType = "LUNCH" | "DINNER";
type Proposal =
  | { kind: "SERVICE_ROOM_AVAILABILITY"; localDate: string; serviceType: ServiceType; roomId: string; isAvailable: boolean }
  | { kind: "ROOM_CATALOG"; roomId: string; displayOrder: number; isActive: boolean }
  | { kind: "DINING_TABLE"; tableId: string; name: string; minimumSeats: number; maximumSeats: number; displayOrder: number; isActive: boolean };
interface ImpactItem {
  classification: string;
  classifications: string[];
  localDate: string | null;
  serviceType: ServiceType | null;
  roomCode: string;
  reservationCount: number;
  covers: number;
  preferenceReservationCount: number;
  assignmentReservationCount: number;
  previousAvailable: boolean;
  proposedAvailable: boolean;
}
interface Preview {
  proposal: Proposal;
  fingerprint: string;
  changed: boolean;
  confirmationRequired: boolean;
  impact: { reservationCount: number; covers: number; preferenceReservationCount: number; assignmentReservationCount: number; items: ImpactItem[] };
}
interface RoomDto {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
  serviceAvailabilityPolicy: "DEFAULT_AVAILABLE" | "EXPLICIT_ONLY";
  diningTables: Array<{ id: string; name: string; minimumSeats: number; maximumSeats: number; displayOrder: number; isActive: boolean }>;
}
interface ConfigurationDto {
  service: {
    localDate: string;
    serviceType: ServiceType;
    lifecycle: "VIRTUAL" | "MATERIALIZED" | "HISTORICAL";
    service: { isOpen: boolean };
    rooms: Array<{ id: string; configuredAvailable: boolean; isAvailable: boolean }>;
  };
  rooms: RoomDto[];
}

const field = "mt-1 w-full min-w-0 rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950";
const button = "rounded-xl bg-zinc-950 px-4 py-2.5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50";

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const result = (await response.json()) as Record<string, unknown>;
  return { response, result };
}

export function RoomManagementPanel({ configuration }: { configuration: ConfigurationDto }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<Preview | null>(null);
  const effectiveByRoom = new Map(configuration.service.rooms.map((room) => [room.id, room]));
  const historical = configuration.service.lifecycle === "HISTORICAL";

  async function apply(preview: Preview) {
    const { response, result } = await postJson("/api/admin/room-configuration/apply", { proposal: preview.proposal, fingerprint: preview.fingerprint });
    if (!response.ok) {
      if (result.code === "IMPACT_CHANGED") {
        const updatedPreview = result.preview as Preview | undefined;
        setPending(
          updatedPreview?.changed && updatedPreview.confirmationRequired
            ? updatedPreview
            : null,
        );
        throw new Error(
          "L'impatto è cambiato. Ripeti l'azione prima di applicare la configurazione.",
        );
      }
      throw new Error(typeof result.error === "string" ? result.error : "Salvataggio non riuscito.");
    }
    setPending(null);
    setMessage(result.changed === false ? "Nessuna modifica da applicare." : "Configurazione salvata.");
    router.refresh();
  }

  async function propose(proposal: Proposal) {
    setBusy(true);
    setMessage(null);
    try {
      const { response, result } = await postJson("/api/admin/room-configuration/preview", proposal);
      if (!response.ok || !result.preview) throw new Error(typeof result.error === "string" ? result.error : "Anteprima non disponibile.");
      const preview = result.preview as Preview;
      if (!preview.changed) setMessage("Nessuna modifica da applicare.");
      else if (preview.confirmationRequired) setPending(preview);
      else await apply(preview);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operazione non riuscita.");
    } finally { setBusy(false); }
  }

  async function mutateTable(body: unknown) {
    setBusy(true);
    setMessage(null);
    try {
      const { response, result } = await postJson("/api/admin/room-configuration/tables", body);
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Salvataggio tavolo non riuscito.");
      setMessage(result.changed === false ? "Nessuna modifica da applicare." : "Tavolo salvato.");
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Operazione non riuscita."); }
    finally { setBusy(false); }
  }

  return (
    <div className="min-w-0 space-y-5">
      <form className="grid gap-4 rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:grid-cols-[1fr_1fr_auto] sm:items-end" method="get">
        <label className="text-sm font-bold">Data<input className={field} defaultValue={configuration.service.localDate} name="date" required type="date" /></label>
        <label className="text-sm font-bold">Servizio<select className={field} defaultValue={configuration.service.serviceType} name="service"><option value="LUNCH">Pranzo</option><option value="DINNER">Cena</option></select></label>
        <button className={button} type="submit">Consulta</button>
      </form>

      <div className="flex flex-wrap gap-2 text-xs font-black uppercase tracking-wide">
        <span className="rounded-full bg-zinc-200 px-3 py-1">{configuration.service.lifecycle}</span>
        <span className={`rounded-full px-3 py-1 ${configuration.service.service.isOpen ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>{configuration.service.service.isOpen ? "Servizio aperto" : "Servizio chiuso"}</span>
      </div>
      {historical ? <p className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm font-bold text-amber-900">Servizio storico: consultazione sola lettura.</p> : null}
      {message ? <p className="rounded-2xl border border-zinc-300 bg-white p-4 text-sm font-bold" role="status">{message}</p> : null}

      {configuration.rooms.map((room) => {
        const effective = effectiveByRoom.get(room.id);
        return (
          <section className="min-w-0 rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6" key={room.id}>
            <div className="flex min-w-0 flex-col justify-between gap-4 lg:flex-row lg:items-start">
              <div className="min-w-0"><h2 className="truncate text-xl font-black">{room.name}</h2><p className="break-all text-xs text-zinc-500">{room.code} · {room.serviceAvailabilityPolicy === "DEFAULT_AVAILABLE" ? "Disponibile per default" : "Solo attivazione esplicita"}</p></div>
              <button className={effective?.configuredAvailable ? "rounded-xl border border-red-300 px-4 py-2 text-sm font-black text-red-800 disabled:opacity-50" : "rounded-xl bg-emerald-700 px-4 py-2 text-sm font-black text-white disabled:opacity-50"} disabled={busy || historical} onClick={() => void propose({ kind: "SERVICE_ROOM_AVAILABILITY", localDate: configuration.service.localDate, serviceType: configuration.service.serviceType, roomId: room.id, isAvailable: !effective?.configuredAvailable })} type="button">{effective?.configuredAvailable ? "Rendi non disponibile" : "Rendi disponibile"}</button>
            </div>
            <form className="mt-5 grid gap-3 border-t border-zinc-200 pt-5 sm:grid-cols-[140px_1fr_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void propose({ kind: "ROOM_CATALOG", roomId: room.id, displayOrder: Number(data.get("displayOrder")), isActive: data.get("isActive") === "on" }); }}>
              <label className="text-xs font-bold">Ordine<input className={field} defaultValue={room.displayOrder} min="0" name="displayOrder" required type="number" /></label>
              <label className="flex items-center gap-2 pb-2 text-sm font-bold"><input defaultChecked={room.isActive} name="isActive" type="checkbox" />Sala attiva globalmente</label>
              <button className={button} disabled={busy} type="submit">Salva sala</button>
            </form>

            <div className="mt-6 space-y-3">
              <h3 className="text-sm font-black uppercase tracking-wide text-zinc-600">Tavoli</h3>
              {room.diningTables.map((table) => (
                <form className="grid min-w-0 gap-3 rounded-2xl bg-zinc-100 p-4 md:grid-cols-6 md:items-end" key={table.id} onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void propose({ kind: "DINING_TABLE", tableId: table.id, name: String(data.get("name") ?? ""), minimumSeats: Number(data.get("minimumSeats")), maximumSeats: Number(data.get("maximumSeats")), displayOrder: Number(data.get("displayOrder")), isActive: data.get("isActive") === "on" }); }}>
                  <label className="min-w-0 text-xs font-bold md:col-span-2">Nome<input className={field} defaultValue={table.name} maxLength={40} name="name" required /></label>
                  <label className="text-xs font-bold">Min<input className={field} defaultValue={table.minimumSeats} min="1" name="minimumSeats" required type="number" /></label>
                  <label className="text-xs font-bold">Max<input className={field} defaultValue={table.maximumSeats} min="1" name="maximumSeats" required type="number" /></label>
                  <label className="text-xs font-bold">Ordine<input className={field} defaultValue={table.displayOrder} min="0" name="displayOrder" required type="number" /></label>
                  <div className="flex items-center justify-between gap-2"><label className="flex items-center gap-2 text-xs font-bold"><input defaultChecked={table.isActive} name="isActive" type="checkbox" />Attivo</label><button className={button} disabled={busy} type="submit">Salva</button></div>
                </form>
              ))}
              <form className="grid min-w-0 gap-3 rounded-2xl border border-dashed border-zinc-300 p-4 md:grid-cols-6 md:items-end" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void mutateTable({ action: "CREATE_TABLE", roomId: room.id, name: data.get("name"), minimumSeats: Number(data.get("minimumSeats")), maximumSeats: Number(data.get("maximumSeats")), displayOrder: Number(data.get("displayOrder")) }); }}>
                <label className="min-w-0 text-xs font-bold md:col-span-2">Nuovo tavolo<input className={field} maxLength={40} name="name" required /></label>
                <label className="text-xs font-bold">Min<input className={field} min="1" name="minimumSeats" required type="number" /></label>
                <label className="text-xs font-bold">Max<input className={field} min="1" name="maximumSeats" required type="number" /></label>
                <label className="text-xs font-bold">Ordine<input className={field} min="0" name="displayOrder" required type="number" /></label>
                <button className={button} disabled={busy} type="submit">Aggiungi</button>
              </form>
            </div>
          </section>
        );
      })}

      {pending ? <div aria-modal="true" className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-4 sm:p-8" role="dialog"><section className="mx-auto max-w-2xl rounded-3xl bg-white p-6"><p className="text-xs font-black uppercase tracking-widest text-orange-700">Conferma esplicita</p><h2 className="mt-2 text-2xl font-black">Prenotazioni coinvolte</h2><p className="mt-3 text-sm text-zinc-600">La configurazione non modifica le prenotazioni né le assegnazioni esistenti. I riferimenti interessati resteranno visibili come grandfathered.</p><div className="mt-5 grid gap-3 sm:grid-cols-3"><p className="rounded-2xl bg-zinc-100 p-4 font-black">{pending.impact.reservationCount} prenotazioni · {pending.impact.covers} coperti</p><p className="rounded-2xl bg-zinc-100 p-4 font-black">{pending.impact.assignmentReservationCount} assegnazioni finali</p><p className="rounded-2xl bg-zinc-100 p-4 font-black">{pending.impact.preferenceReservationCount} preferenze</p></div><div className="mt-6 flex justify-end gap-3"><button className="rounded-xl border border-zinc-300 px-4 py-2 font-bold" disabled={busy} onClick={() => setPending(null)} type="button">Annulla</button><button className="rounded-xl bg-orange-600 px-4 py-2 font-black text-white disabled:opacity-50" disabled={busy} onClick={() => { setBusy(true); void apply(pending).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Operazione non riuscita.")).finally(() => setBusy(false)); }} type="button">Conferma e applica</button></div></section></div> : null}
    </div>
  );
}
