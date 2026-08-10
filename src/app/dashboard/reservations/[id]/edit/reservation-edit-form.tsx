"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import type { StaffReservationDto } from "@/modules/reservations/domain/staff-dto";

const fieldClassName =
  "mt-2 block w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-950 outline-none transition focus:border-orange-500 focus:ring-4 focus:ring-orange-100";

function stringValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function checked(formData: FormData, name: string): boolean {
  return formData.get(name) === "on";
}

export function ReservationEditForm(props: {
  reservation: StaffReservationDto;
  rooms: { code: string; name: string }[];
}) {
  const [localDate, setLocalDate] = useState(props.reservation.localDate);
  const [serviceType, setServiceType] = useState<"LUNCH" | "DINNER">(
    props.reservation.serviceType,
  );
  const [partySize, setPartySize] = useState(String(props.reservation.partySize));
  const [arrivalTime, setArrivalTime] = useState(props.reservation.arrivalTime);
  const [slots, setSlots] = useState<
    { time: string; remainingCapacity: number; reason?: string }[]
  >([]);
  const [version, setVersion] = useState(props.reservation.version);
  const [availabilityMessage, setAvailabilityMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const initialRoomCode = props.rooms.some(
    (room) => room.code === props.reservation.roomCode,
  )
    ? props.reservation.roomCode
    : "";
  const partySizeIsValid = Number.isInteger(Number(partySize)) && Number(partySize) > 0;

  useEffect(() => {
    const controller = new AbortController();
    const covers = Number(partySize);

    if (!Number.isInteger(covers) || covers < 1) {
      return () => controller.abort();
    }

    const query = new URLSearchParams({
      date: localDate,
      service: serviceType,
      partySize: String(covers),
    });
    void fetch(`/api/staff/availability?${query.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          error?: string;
          slots?: { time: string; remainingCapacity: number; reason?: string }[];
        };
        if (!response.ok) throw new Error(body.error);

        const nextSlots = (body.slots ?? []).filter(
          (slot) => slot.reason !== "SLOT_IN_PAST",
        );
        if (
          localDate === props.reservation.localDate &&
          serviceType === props.reservation.serviceType &&
          !nextSlots.some((slot) => slot.time === props.reservation.arrivalTime)
        ) {
          nextSlots.unshift({
            time: props.reservation.arrivalTime,
            remainingCapacity: 0,
            reason: "CURRENT",
          });
        }
        setSlots(nextSlots);
        setAvailabilityMessage(
          "L’anteprima è indicativa; il server esclude questa prenotazione nel controllo definitivo.",
        );
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAvailabilityMessage("Slot non consultabili. Riprova.");
      });

    return () => controller.abort();
  }, [localDate, partySize, props.reservation, serviceType]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);

    const formData = new FormData(event.currentTarget);
    const capacityOverride = checked(formData, "capacityOverride");
    const payload = {
      version,
      localDate,
      serviceType,
      arrivalTime,
      partySize: Number(partySize),
      roomCode: stringValue(formData, "roomCode"),
      customerFirstName: stringValue(formData, "customerFirstName"),
      customerLastName: stringValue(formData, "customerLastName"),
      customerPhone: stringValue(formData, "customerPhone"),
      customerEmail: stringValue(formData, "customerEmail"),
      highChair: checked(formData, "highChair"),
      stroller: checked(formData, "stroller"),
      accessibility: checked(formData, "accessibility"),
      children: checked(formData, "children"),
      celiac: checked(formData, "celiac"),
      allergies: stringValue(formData, "allergies"),
      intolerances: stringValue(formData, "intolerances"),
      celebration: stringValue(formData, "celebration"),
      animals: checked(formData, "animals"),
      notes: stringValue(formData, "notes"),
      capacityOverride,
      capacityOverrideReason: capacityOverride
        ? stringValue(formData, "capacityOverrideReason")
        : null,
    };

    try {
      const response = await fetch(
        `/api/staff/reservations/${props.reservation.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = (await response.json()) as {
        changed?: boolean;
        error?: string;
        reservation?: StaffReservationDto;
      };

      if (!response.ok || !body.reservation) {
        setMessage({
          kind: "error",
          text: body.error ?? "Non è stato possibile aggiornare.",
        });
        return;
      }

      setVersion(body.reservation.version);
      setMessage({
        kind: "success",
        text:
          body.changed === false
            ? "Nessuna modifica da salvare. Versione e disponibilità sono state ricontrollate."
            : "Prenotazione aggiornata. Versione e disponibilità sono state ricontrollate.",
      });
    } catch {
      setMessage({ kind: "error", text: "Errore di rete. Riprova." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="mt-6 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-9" onSubmit={submit}>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-bold text-zinc-800">Data<input className={fieldClassName} name="localDate" onChange={(event) => setLocalDate(event.target.value)} required type="date" value={localDate} /></label>
        <label className="text-sm font-bold text-zinc-800">Servizio<select className={fieldClassName} name="serviceType" onChange={(event) => setServiceType(event.target.value as "LUNCH" | "DINNER")} value={serviceType}><option value="LUNCH">Pranzo</option><option value="DINNER">Cena</option></select></label>
        <label className="text-sm font-bold text-zinc-800">Persone<input className={fieldClassName} min="1" name="partySize" onChange={(event) => setPartySize(event.target.value)} required step="1" type="number" value={partySize} /></label>
        <label className="text-sm font-bold text-zinc-800">Slot<select className={fieldClassName} name="arrivalTime" onChange={(event) => setArrivalTime(event.target.value)} required value={arrivalTime}><option value="">Seleziona…</option>{(partySizeIsValid ? slots : []).map((slot) => <option key={slot.time} value={slot.time}>{slot.time}{slot.reason === "CURRENT" ? " · attuale" : ` · ${slot.remainingCapacity} posti residui`}</option>)}</select><span className="mt-2 block text-xs font-normal leading-5 text-zinc-500">{partySizeIsValid ? availabilityMessage : "Inserisci un numero di persone valido."}</span></label>
        <label className="text-sm font-bold text-zinc-800">Nome<input className={fieldClassName} defaultValue={props.reservation.customer.firstName} maxLength={80} name="customerFirstName" required /></label>
        <label className="text-sm font-bold text-zinc-800">Cognome<input className={fieldClassName} defaultValue={props.reservation.customer.lastName} maxLength={80} name="customerLastName" required /></label>
        <label className="text-sm font-bold text-zinc-800">Telefono<input className={fieldClassName} defaultValue={props.reservation.customer.phone} maxLength={40} name="customerPhone" required type="tel" /></label>
        <label className="text-sm font-bold text-zinc-800">Email<input className={fieldClassName} defaultValue={props.reservation.customer.email ?? ""} maxLength={254} name="customerEmail" type="email" /></label>
        <label className="text-sm font-bold text-zinc-800 sm:col-span-2">Sala preferita (non definitiva)<select className={fieldClassName} defaultValue={initialRoomCode} name="roomCode" required><option value="">Seleziona una sala attiva…</option>{props.rooms.map((room) => <option key={room.code} value={room.code}>{room.name}</option>)}</select></label>
      </div>

      {props.reservation.legacyPreference ? <p className="mt-4 rounded-xl bg-amber-50 p-4 text-sm font-bold text-amber-900">Preferenza M6 precedente: {props.reservation.legacyPreference}. Seleziona una sala configurata prima di salvare.</p> : null}

      <fieldset className="mt-6 rounded-2xl bg-zinc-100 p-5">
        <legend className="px-1 font-black text-zinc-950">Esigenze e indicatori</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["highChair", "Seggiolone", props.reservation.highChair],
            ["stroller", "Passeggino", props.reservation.stroller],
            ["accessibility", "Accessibilità", props.reservation.accessibility],
            ["children", "Presenza di bambini", props.reservation.children],
            ["celiac", "Celiachia", props.reservation.celiac],
            ["animals", "Animali", props.reservation.animals],
          ].map(([name, label, defaultChecked]) => <label className="flex items-center gap-3 text-sm font-bold text-zinc-800" key={String(name)}><input className="size-4 accent-orange-500" defaultChecked={Boolean(defaultChecked)} name={String(name)} type="checkbox" />{String(label)}</label>)}
        </div>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <label className="text-sm font-bold text-zinc-800">Allergie dichiarate<textarea className={fieldClassName} defaultValue={props.reservation.allergies ?? ""} maxLength={300} name="allergies" rows={2} /></label>
          <label className="text-sm font-bold text-zinc-800">Intolleranze<textarea className={fieldClassName} defaultValue={props.reservation.intolerances ?? ""} maxLength={300} name="intolerances" rows={2} /></label>
          <label className="text-sm font-bold text-zinc-800">Compleanno o ricorrenza<textarea className={fieldClassName} defaultValue={props.reservation.celebration ?? ""} maxLength={200} name="celebration" rows={2} /></label>
          <label className="text-sm font-bold text-zinc-800">Note<textarea className={fieldClassName} defaultValue={props.reservation.notes ?? ""} maxLength={1000} name="notes" rows={2} /></label>
        </div>
      </fieldset>

      <section className="mt-6 rounded-2xl border border-orange-200 bg-orange-50 p-5">
        <label className="flex items-center gap-3 text-sm font-black text-orange-950"><input className="size-4 accent-orange-600" name="capacityOverride" type="checkbox" />Override esplicito della sola capacità (Staff/Admin)</label>
        <p className="mt-2 text-xs text-orange-900">È valido solo se data, servizio, orario o persone causano un superamento reale. Un override già registrato resta invariato quando modifichi soltanto contatti o note.</p>
        <label className="mt-4 block text-sm font-bold text-orange-950">Motivo dell&apos;override<textarea className={fieldClassName} maxLength={500} name="capacityOverrideReason" rows={2} /></label>
      </section>

      {message ? <div className={`mt-6 rounded-2xl p-4 font-bold ${message.kind === "success" ? "bg-emerald-50 text-emerald-900" : "bg-red-50 text-red-800"}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</div> : null}

      <div className="mt-7 flex flex-wrap gap-3">
        <button className="rounded-xl bg-zinc-950 px-6 py-3.5 font-bold text-white hover:bg-orange-600 focus:outline-none focus:ring-4 focus:ring-orange-200 disabled:opacity-60" disabled={submitting} type="submit">{submitting ? "Salvataggio…" : "Salva modifiche"}</button>
        <Link className="rounded-xl border border-zinc-300 px-6 py-3.5 font-bold text-zinc-800 focus:outline-none focus:ring-4 focus:ring-zinc-200" href={`/dashboard?date=${localDate}`}>Torna alla dashboard</Link>
      </div>
    </form>
  );
}
