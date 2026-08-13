"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { PublicContactLinks } from "@/app/_components/public-contact-links";
import type {
  PublicContacts,
  PublicContentSet,
} from "@/modules/configuration/domain/public-settings";

interface AvailabilitySlot {
  time: string;
  available: boolean;
  remainingCapacity: number;
}

interface RoomOption {
  code: string;
  name: string;
}

interface AvailabilityResponse {
  slots?: AvailabilitySlot[];
  rooms?: RoomOption[];
  isOpen?: boolean;
  error?: string;
}

const text = {
  it: {
    eyebrow: "Prenotazione online",
    language: "Language",
    date: "Data",
    service: "Servizio",
    lunch: "Pranzo",
    dinner: "Cena",
    partySize: "Persone",
    slot: "Orario disponibile",
    room: "Sala preferita",
    firstName: "Nome",
    lastName: "Cognome",
    phone: "Telefono",
    email: "Email (facoltativa)",
    needs: "Esigenze e dettagli",
    highChair: "Seggiolone",
    stroller: "Passeggino",
    accessibility: "Accessibilità",
    children: "Presenza di bambini",
    celiac: "Celiachia",
    animals: "Animali",
    allergies: "Allergie (facoltative)",
    intolerances: "Intolleranze (facoltative)",
    celebration: "Compleanno o ricorrenza (facoltativo)",
    notes: "Note (facoltative)",
    privacy: "Accetto l’informativa privacy tecnica di prova.",
    terms: "Accetto le condizioni di prenotazione tecniche di prova.",
    disclaimer:
      "La sala indicata rappresenta una preferenza. Il Piccadilly si riserva il diritto di modificare la collocazione del tavolo per esigenze organizzative, disponibilità o condizioni atmosferiche.",
    loading: "Verifica disponibilità…",
    submit: "Conferma prenotazione",
    submitting: "Conferma in corso…",
    link: "Apri il tuo link personale",
    keepLink: "Conserva questo link: serve per consultare, modificare o annullare.",
    genericError: "Non è stato possibile completare la richiesta.",
  },
  en: {
    eyebrow: "Online booking",
    language: "Lingua",
    date: "Date",
    service: "Service",
    lunch: "Lunch",
    dinner: "Dinner",
    partySize: "Guests",
    slot: "Available time",
    room: "Preferred room",
    firstName: "First name",
    lastName: "Last name",
    phone: "Phone",
    email: "Email (optional)",
    needs: "Needs and details",
    highChair: "High chair",
    stroller: "Stroller",
    accessibility: "Accessibility",
    children: "Children",
    celiac: "Coeliac needs",
    animals: "Animals",
    allergies: "Allergies (optional)",
    intolerances: "Intolerances (optional)",
    celebration: "Birthday or occasion (optional)",
    notes: "Notes (optional)",
    privacy: "I accept the technical demo privacy notice.",
    terms: "I accept the technical demo booking terms.",
    disclaimer:
      "The selected room is a preference. Piccadilly may change the table location for operational, availability or weather reasons.",
    loading: "Checking availability…",
    submit: "Confirm booking",
    submitting: "Confirming…",
    link: "Open your personal link",
    keepLink: "Keep this link to view, change or cancel your booking.",
    genericError: "The request could not be completed.",
  },
} as const;

const inputClass =
  "mt-2 block w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-950 outline-none transition focus:border-orange-500 focus:ring-4 focus:ring-orange-100";

function value(formData: FormData, name: string): string {
  const field = formData.get(name);
  return typeof field === "string" ? field : "";
}

function checked(formData: FormData, name: string): boolean {
  return formData.get(name) === "on";
}

export function PublicBookingForm({
  contacts,
  contents,
  initialLanguage,
}: {
  contacts: PublicContacts;
  contents: PublicContentSet;
  initialLanguage: "it" | "en";
}) {
  const [language, setLanguage] = useState<"it" | "en">(initialLanguage);
  const [date, setDate] = useState("");
  const [service, setService] = useState<"LUNCH" | "DINNER">("DINNER");
  const [partySize, setPartySize] = useState(2);
  const [availability, setAvailability] = useState<AvailabilityResponse>({});
  const [availabilityPending, setAvailabilityPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [managementPath, setManagementPath] = useState<string | null>(null);
  const submission = useRef<{ signature: string; key: string } | null>(null);
  const copy = text[language];
  const editorial = contents[language === "it" ? "IT" : "EN"];

  function selectLanguage(nextLanguage: "it" | "en") {
    setLanguage(nextLanguage);
    const url = new URL(window.location.href);
    url.searchParams.set("lang", nextLanguage);
    window.history.replaceState(null, "", url);
  }

  useEffect(() => {
    if (!date || !Number.isInteger(partySize) || partySize < 1) {
      return;
    }

    const controller = new AbortController();
    void fetch(
      `/api/public/availability?date=${encodeURIComponent(date)}&service=${service}&partySize=${partySize}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        const body = (await response.json()) as AvailabilityResponse;
        if (!response.ok) {
          throw new Error(
            language === "it" ? body.error ?? copy.genericError : copy.genericError,
          );
        }
        setAvailability(body);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setAvailability({
            error: error instanceof Error ? error.message : copy.genericError,
          });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setAvailabilityPending(false);
      });

    return () => controller.abort();
  }, [copy.genericError, date, language, partySize, service]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    const formData = new FormData(event.currentTarget);
    const payload = {
      localDate: date,
      serviceType: service,
      arrivalTime: value(formData, "arrivalTime"),
      partySize,
      roomCode: value(formData, "roomCode"),
      customerFirstName: value(formData, "customerFirstName"),
      customerLastName: value(formData, "customerLastName"),
      customerPhone: value(formData, "customerPhone"),
      customerEmail: value(formData, "customerEmail"),
      highChair: checked(formData, "highChair"),
      stroller: checked(formData, "stroller"),
      accessibility: checked(formData, "accessibility"),
      children: checked(formData, "children"),
      celiac: checked(formData, "celiac"),
      allergies: value(formData, "allergies"),
      intolerances: value(formData, "intolerances"),
      celebration: value(formData, "celebration"),
      animals: checked(formData, "animals"),
      notes: value(formData, "notes"),
      language,
      privacyAccepted: checked(formData, "privacyAccepted"),
      termsAccepted: checked(formData, "termsAccepted"),
    };
    const signature = JSON.stringify(payload);

    if (submission.current?.signature !== signature) {
      submission.current = { signature, key: crypto.randomUUID() };
    }

    try {
      const response = await fetch("/api/public/reservations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": submission.current.key,
        },
        body: signature,
      });
      const body = (await response.json()) as {
        error?: string;
        managementPath?: string;
      };

      if (!response.ok || !body.managementPath) {
        setMessage(
          language === "it" ? body.error ?? copy.genericError : copy.genericError,
        );
        return;
      }

      setManagementPath(body.managementPath);
      submission.current = null;
    } catch {
      setMessage(copy.genericError);
    } finally {
      setSubmitting(false);
    }
  }

  if (managementPath) {
    return (
      <main className="min-h-screen bg-zinc-950 px-5 py-12 text-white sm:px-8">
        <section className="mx-auto max-w-2xl rounded-[2rem] bg-white p-8 text-zinc-950 shadow-2xl sm:p-12">
          <div className="mb-8 h-2 w-20 rounded-full bg-orange-500" />
          <p className="text-sm font-black tracking-[0.2em] text-orange-600 uppercase">
            Piccadilly
          </p>
          <h1 className="mt-3 text-4xl font-black whitespace-pre-line">{editorial.CONFIRMATION_MESSAGE}</h1>
          <p className="mt-5 leading-7 text-zinc-600">{copy.keepLink}</p>
          <a
            className="mt-8 inline-flex rounded-2xl bg-orange-500 px-6 py-4 font-black text-white transition hover:bg-orange-600 focus:ring-4 focus:ring-orange-200 focus:outline-none"
            href={`${managementPath}?lang=${language}`}
            rel="noreferrer"
          >
            {copy.link}
          </a>
          <div className="mt-8 border-t border-zinc-200 pt-6">
            <p className="whitespace-pre-line text-sm text-zinc-600">{editorial.CONTACT_PROMPT}</p>
            <PublicContactLinks contacts={contacts} language={language} />
          </div>
        </section>
      </main>
    );
  }

  const availableSlots =
    availability.slots?.filter((slot) => slot.available) ?? [];

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-6 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-white shadow-[0_25px_90px_rgba(0,0,0,0.12)]">
        <header className="grid gap-8 bg-zinc-950 px-7 py-10 text-white sm:px-12 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <p className="text-sm font-black tracking-[0.2em] text-orange-400 uppercase">
              {copy.eyebrow}
            </p>
            <h1 className="mt-3 max-w-3xl text-4xl font-black tracking-tight sm:text-5xl">
              {editorial.BOOKING_PAGE_TITLE}
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-zinc-300">
              {editorial.BOOKING_PAGE_INTRO}
            </p>
          </div>
          <div className="flex rounded-2xl border border-zinc-700 p-1" aria-label={copy.language}>
            {(["it", "en"] as const).map((option) => (
              <button
                aria-pressed={language === option}
                className={`rounded-xl px-4 py-2 text-sm font-black ${language === option ? "bg-orange-500 text-white" : "text-zinc-300"}`}
                key={option}
                onClick={() => selectLanguage(option)}
                type="button"
              >
                {option.toUpperCase()}
              </button>
            ))}
          </div>
        </header>

        <form className="p-7 sm:p-12" onSubmit={submit}>
          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm font-bold text-zinc-800">
              {copy.date}
              <input className={inputClass} name="localDate" onChange={(event) => { setAvailabilityPending(Boolean(event.target.value)); setDate(event.target.value); }} required type="date" value={date} />
            </label>
            <label className="text-sm font-bold text-zinc-800">
              {copy.service}
              <select className={inputClass} onChange={(event) => { setAvailabilityPending(Boolean(date)); setService(event.target.value as "LUNCH" | "DINNER"); }} value={service}>
                <option value="LUNCH">{copy.lunch}</option>
                <option value="DINNER">{copy.dinner}</option>
              </select>
            </label>
            <label className="text-sm font-bold text-zinc-800">
              {copy.partySize}
              <input className={inputClass} min="1" onChange={(event) => { setAvailabilityPending(Boolean(date)); setPartySize(Number(event.target.value)); }} required step="1" type="number" value={partySize} />
            </label>
            <label className="text-sm font-bold text-zinc-800">
              {copy.slot}
              <select className={inputClass} disabled={availableSlots.length === 0} name="arrivalTime" required>
                <option value="">—</option>
                {availableSlots.map((slot) => <option key={slot.time} value={slot.time}>{slot.time}</option>)}
              </select>
            </label>
            <label className="text-sm font-bold text-zinc-800 md:col-span-2">
              {copy.room}
              <select className={inputClass} disabled={!availability.rooms?.length} name="roomCode" required>
                <option value="">—</option>
                {availability.rooms?.map((room) => <option key={room.code} value={room.code}>{room.name}</option>)}
              </select>
            </label>
            <label className="text-sm font-bold text-zinc-800">
              {copy.firstName}
              <input className={inputClass} maxLength={80} name="customerFirstName" required />
            </label>
            <label className="text-sm font-bold text-zinc-800">
              {copy.lastName}
              <input className={inputClass} maxLength={80} name="customerLastName" required />
            </label>
            <label className="text-sm font-bold text-zinc-800">
              {copy.phone}
              <input className={inputClass} maxLength={40} name="customerPhone" required type="tel" />
            </label>
            <label className="text-sm font-bold text-zinc-800 md:col-span-2">
              {copy.email}
              <input className={inputClass} maxLength={254} name="customerEmail" type="email" />
            </label>
          </div>

          <section className="mt-8 rounded-3xl bg-zinc-100 p-6 sm:p-8">
            <h2 className="text-xl font-black">{copy.needs}</h2>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {(["highChair", "stroller", "accessibility", "children", "celiac", "animals"] as const).map((name) => (
                <label className="flex items-center gap-3 rounded-2xl bg-white px-4 py-3 text-sm font-bold" key={name}>
                  <input className="size-4 accent-orange-500" name={name} type="checkbox" />
                  {copy[name]}
                </label>
              ))}
            </div>
            <div className="mt-5 grid gap-5 md:grid-cols-2">
              <label className="text-sm font-bold">{copy.allergies}<textarea className={inputClass} maxLength={300} name="allergies" rows={3} /></label>
              <label className="text-sm font-bold">{copy.intolerances}<textarea className={inputClass} maxLength={300} name="intolerances" rows={3} /></label>
              <label className="text-sm font-bold">{copy.celebration}<input className={inputClass} maxLength={200} name="celebration" /></label>
              <label className="text-sm font-bold">{copy.notes}<textarea className={inputClass} maxLength={1000} name="notes" rows={3} /></label>
            </div>
          </section>

          <p className="mt-7 rounded-2xl border border-orange-200 bg-orange-50 p-5 text-sm leading-6 text-orange-950">
            {copy.disclaimer}
          </p>
          <div className="mt-6 space-y-3">
            <label className="flex items-start gap-3 text-sm font-bold"><input className="mt-1 size-4 accent-orange-500" name="privacyAccepted" required type="checkbox" />{copy.privacy}</label>
            <label className="flex items-start gap-3 text-sm font-bold"><input className="mt-1 size-4 accent-orange-500" name="termsAccepted" required type="checkbox" />{copy.terms}</label>
          </div>

          {date && availableSlots.length === 0 ? (
            <div className="mt-5 rounded-2xl bg-orange-50 p-5 text-orange-900" role="status">
              <p className="font-bold whitespace-pre-line">{availabilityPending ? copy.loading : availability.error ?? editorial.UNAVAILABLE_MESSAGE}</p>
              {!availabilityPending ? (
                <>
                  <p className="mt-3 whitespace-pre-line text-sm">{editorial.CONTACT_PROMPT}</p>
                  <PublicContactLinks contacts={contacts} language={language} />
                </>
              ) : null}
            </div>
          ) : null}
          {message ? <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm font-bold text-red-800" role="alert">{message}</p> : null}

          <section className="mt-7 rounded-2xl bg-zinc-100 p-5">
            <p className="whitespace-pre-line text-sm text-zinc-700">{editorial.CONTACT_PROMPT}</p>
            <PublicContactLinks contacts={contacts} language={language} />
          </section>

          <button className="mt-8 rounded-2xl bg-zinc-950 px-7 py-4 font-black text-white transition hover:bg-orange-600 focus:ring-4 focus:ring-orange-200 focus:outline-none disabled:cursor-wait disabled:opacity-60" disabled={submitting || availableSlots.length === 0} type="submit">
            {submitting ? copy.submitting : copy.submit}
          </button>
        </form>
      </div>
    </main>
  );
}
