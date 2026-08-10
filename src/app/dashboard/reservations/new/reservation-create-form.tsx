"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

interface ReservationCreateFormProps {
  defaultDate: string;
  initialRooms: { code: string; name: string }[];
  privacyPolicyVersion: string;
}

interface SubmissionIdentity {
  signature: string;
  key: string;
}

interface AvailabilityResponse {
  error?: string;
  isOpen?: boolean;
  slots?: {
    time: string;
    available: boolean;
    remainingCapacity: number;
    reason?: string;
  }[];
  rooms?: { code: string; name: string }[];
}

const fieldClassName =
  "mt-2 block w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-950 outline-none transition focus:border-orange-500 focus:ring-4 focus:ring-orange-100";

function stringValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function checked(formData: FormData, name: string): boolean {
  return formData.get(name) === "on";
}

export function ReservationCreateForm({
  defaultDate,
  initialRooms,
  privacyPolicyVersion,
}: ReservationCreateFormProps) {
  const [localDate, setLocalDate] = useState(defaultDate);
  const [serviceType, setServiceType] = useState<"LUNCH" | "DINNER">(
    "DINNER",
  );
  const [partySize, setPartySize] = useState("2");
  const [slots, setSlots] = useState<AvailabilityResponse["slots"]>([]);
  const [rooms, setRooms] = useState(initialRooms);
  const [availabilityMessage, setAvailabilityMessage] = useState(
    "Caricamento degli slot configurati…",
  );
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const submissionIdentity = useRef<SubmissionIdentity | null>(null);
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
        const body = (await response.json()) as AvailabilityResponse;
        if (!response.ok) throw new Error(body.error);

        const configuredSlots = (body.slots ?? []).filter(
          (slot) => slot.reason !== "SLOT_IN_PAST",
        );
        setSlots(configuredSlots);
        setRooms(body.rooms ?? initialRooms);
        setAvailabilityMessage(
          body.isOpen
            ? configuredSlots.length > 0
              ? "Scegli uno slot. Gli slot pieni richiedono override esplicito."
              : "Non ci sono slot futuri per questo servizio."
            : "Il servizio selezionato è chiuso.",
        );
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSlots([]);
        setAvailabilityMessage("Disponibilità non consultabile. Riprova.");
      });

    return () => controller.abort();
  }, [initialRooms, localDate, partySize, serviceType]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);

    const formData = new FormData(event.currentTarget);
    const capacityOverride = checked(formData, "capacityOverride");
    const payload = {
      localDate,
      serviceType,
      arrivalTime: stringValue(formData, "arrivalTime"),
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
      verbalConsentConfirmed: checked(formData, "verbalConsentConfirmed"),
      capacityOverride,
      capacityOverrideReason: capacityOverride
        ? stringValue(formData, "capacityOverrideReason")
        : null,
    };
    const signature = JSON.stringify(payload);

    if (submissionIdentity.current?.signature !== signature) {
      submissionIdentity.current = { signature, key: crypto.randomUUID() };
    }

    try {
      const response = await fetch("/api/staff/reservations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": submissionIdentity.current.key,
        },
        body: signature,
      });
      const body = (await response.json()) as {
        error?: string;
        replayed?: boolean;
        reservation?: { id: string };
      };

      if (!response.ok || !body.reservation) {
        setMessage({
          kind: "error",
          text: body.error ?? "Non è stato possibile creare la prenotazione.",
        });
        return;
      }

      setMessage({
        kind: "success",
        text: body.replayed
          ? "Questa richiesta era già stata registrata: nessun duplicato creato."
          : "Prenotazione telefonica salvata e capacità aggiornata.",
      });
    } catch {
      setMessage({
        kind: "error",
        text: "Errore di rete. Riprova: verrà riutilizzata la stessa chiave di idempotenza.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="mt-6 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-9"
      onSubmit={submit}
    >
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-bold text-zinc-800">
          Data
          <input
            className={fieldClassName}
            name="localDate"
            onChange={(event) => setLocalDate(event.target.value)}
            required
            type="date"
            value={localDate}
          />
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Servizio
          <select
            className={fieldClassName}
            name="serviceType"
            onChange={(event) =>
              setServiceType(event.target.value as "LUNCH" | "DINNER")
            }
            value={serviceType}
          >
            <option value="LUNCH">Pranzo</option>
            <option value="DINNER">Cena</option>
          </select>
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Persone
          <input
            className={fieldClassName}
            min="1"
            name="partySize"
            onChange={(event) => setPartySize(event.target.value)}
            required
            step="1"
            type="number"
            value={partySize}
          />
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Slot configurato
          <select className={fieldClassName} name="arrivalTime" required>
            <option value="">Seleziona…</option>
            {(partySizeIsValid ? slots : [])?.map((slot) => (
              <option key={slot.time} value={slot.time}>
                {slot.time} · {slot.remainingCapacity} posti residui
                {slot.reason === "CAPACITY_EXCEEDED" ? " · pieno" : ""}
              </option>
            ))}
          </select>
          <span className="mt-2 block text-xs font-normal leading-5 text-zinc-500">
            {partySizeIsValid
              ? availabilityMessage
              : "Inserisci un numero di persone valido."}
          </span>
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Nome
          <input className={fieldClassName} maxLength={80} name="customerFirstName" required />
        </label>
        <label className="text-sm font-bold text-zinc-800">
          Cognome
          <input className={fieldClassName} maxLength={80} name="customerLastName" required />
        </label>
        <label className="text-sm font-bold text-zinc-800">
          Telefono
          <input className={fieldClassName} maxLength={40} name="customerPhone" required type="tel" />
        </label>
        <label className="text-sm font-bold text-zinc-800">
          Email (facoltativa)
          <input className={fieldClassName} maxLength={254} name="customerEmail" type="email" />
        </label>

        <label className="text-sm font-bold text-zinc-800 sm:col-span-2">
          Sala preferita (non garantita)
          <select className={fieldClassName} name="roomCode" required>
            <option value="">Seleziona…</option>
            {rooms.map((room) => (
              <option key={room.code} value={room.code}>{room.name}</option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="mt-6 rounded-2xl bg-zinc-100 p-5">
        <legend className="px-1 font-black text-zinc-950">Esigenze e indicatori</legend>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["highChair", "Seggiolone"],
            ["stroller", "Passeggino"],
            ["accessibility", "Accessibilità"],
            ["children", "Presenza di bambini"],
            ["celiac", "Celiachia"],
            ["animals", "Animali"],
          ].map(([name, label]) => (
            <label className="flex items-center gap-3 text-sm font-bold text-zinc-800" key={name}>
              <input className="size-4 accent-orange-500" name={name} type="checkbox" />
              {label}
            </label>
          ))}
        </div>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <label className="text-sm font-bold text-zinc-800">Allergie dichiarate<textarea className={fieldClassName} maxLength={300} name="allergies" rows={2} /></label>
          <label className="text-sm font-bold text-zinc-800">Intolleranze<textarea className={fieldClassName} maxLength={300} name="intolerances" rows={2} /></label>
          <label className="text-sm font-bold text-zinc-800">Compleanno o ricorrenza<textarea className={fieldClassName} maxLength={200} name="celebration" rows={2} /></label>
          <label className="text-sm font-bold text-zinc-800">Note<textarea className={fieldClassName} maxLength={1000} name="notes" rows={2} /></label>
        </div>
      </fieldset>

      <section className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
        <label className="flex items-start gap-3 text-sm font-bold text-emerald-950">
          <input className="mt-1 size-4 accent-emerald-600" name="verbalConsentConfirmed" required type="checkbox" />
          <span>
            Confermo di avere acquisito verbalmente il consenso privacy.
            Il server registrerà metodo, versione {privacyPolicyVersion}, orario e utente della sessione.
          </span>
        </label>
      </section>

      <section className="mt-6 rounded-2xl border border-orange-200 bg-orange-50 p-5">
        <label className="flex items-center gap-3 text-sm font-black text-orange-950">
          <input className="size-4 accent-orange-600" name="capacityOverride" type="checkbox" />
          Override esplicito della sola capacità (Staff/Admin)
        </label>
        <p className="mt-2 text-xs leading-5 text-orange-900">
          Usalo solo su uno slot pieno. Non consente sale inesistenti, slot invalidi o servizi chiusi.
        </p>
        <label className="mt-4 block text-sm font-bold text-orange-950">
          Motivo dell&apos;override
          <textarea className={fieldClassName} maxLength={500} name="capacityOverrideReason" rows={2} />
        </label>
      </section>

      {message ? (
        <div className={`mt-6 rounded-2xl px-5 py-4 text-sm font-bold ${message.kind === "success" ? "border border-emerald-200 bg-emerald-50 text-emerald-900" : "border border-red-200 bg-red-50 text-red-800"}`} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </div>
      ) : null}

      <div className="mt-7 flex flex-wrap gap-3">
        <button className="rounded-xl bg-zinc-950 px-6 py-3.5 font-bold text-white transition hover:bg-orange-600 focus:outline-none focus:ring-4 focus:ring-orange-200 disabled:cursor-wait disabled:opacity-60" disabled={submitting} type="submit">
          {submitting ? "Salvataggio…" : "Salva prenotazione telefonica"}
        </button>
        <Link className="rounded-xl border border-zinc-300 px-6 py-3.5 font-bold text-zinc-800 focus:outline-none focus:ring-4 focus:ring-zinc-200" href={`/dashboard?date=${localDate}`}>
          Torna alla dashboard
        </Link>
      </div>
    </form>
  );
}
