"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { PublicContactLinks } from "@/app/_components/public-contact-links";
import { PartyCompositionFields, compositionFormState, compositionPayload, restaurantDiscretionCopy } from "@/app/prenota/party-composition-fields";
import { availabilityQuery, bookingIssues, freezeAttempt, hasCurrentSlot, idleAvailability, initialBookingValues, ownsAttempt, reachSection, settleAvailability, type AvailabilityState, type BookingPayload, type BookingValues, type FieldIssue, type Language, type Section, type SubmissionAttempt } from "@/app/prenota/public-booking-flow";
import type { PublicContacts, PublicContentSet } from "@/modules/configuration/domain/public-settings";
import { resolveClientSubmissionIdentity, type ClientSubmissionIdentity } from "@/shared/client/client-idempotency";

const text = {
  it: {
    eyebrow: "Prenotazione online",
    language: "Lingua",
    date: "Data",
    service: "Servizio",
    lunch: "Pranzo",
    dinner: "Cena",
    partySize: "In quanti siete? (coperti totali)",
    slot: "Orario disponibile",
    firstName: "Nome",
    lastName: "Cognome",
    phone: "Telefono",
    email: "Email (facoltativa)",
    needs: "Esigenze e dettagli",
    highChair: "Seggiolone",
    stroller: "Passeggino",
    accessibility: "Accessibilità",
    celiac: "Celiachia",
    animals: "Animali",
    allergies: "Allergie (facoltative)",
    intolerances: "Intolleranze (facoltative)",
    celebration: "Compleanno o ricorrenza (facoltativo)",
    notes: "Note (facoltative)",
    privacy: "Accetto l’informativa privacy tecnica di prova.",
    terms: "Accetto le condizioni di prenotazione tecniche di prova.",
    loading: "Verifica disponibilità…",
    submit: "Conferma prenotazione",
    submitting: "Conferma in corso…",
    link: "Apri il tuo link personale",
    keepLink: "Conserva questo link: serve per consultare, modificare o annullare.",
    genericError: "Non è stato possibile completare la richiesta.",
  },
  en: {
    eyebrow: "Online booking",
    language: "Language",
    date: "Date",
    service: "Service",
    lunch: "Lunch",
    dinner: "Dinner",
    partySize: "How many are you? (total covers)",
    slot: "Available time",
    firstName: "First name",
    lastName: "Last name",
    phone: "Phone",
    email: "Email (optional)",
    needs: "Needs and details",
    highChair: "High chair",
    stroller: "Stroller",
    accessibility: "Accessibility",
    celiac: "Coeliac needs",
    animals: "Animals",
    allergies: "Allergies (optional)",
    intolerances: "Intolerances (optional)",
    celebration: "Birthday or occasion (optional)",
    notes: "Notes (optional)",
    privacy: "I accept the technical demo privacy notice.",
    terms: "I accept the technical demo booking terms.",
    loading: "Checking availability…",
    submit: "Confirm booking",
    submitting: "Confirming…",
    link: "Open your personal link",
    keepLink: "Keep this link to view, change or cancel your booking.",
    genericError: "The request could not be completed.",
  },
} as const;


const progressive = {
  it: {
    sections: ["Quando e in quanti", "Composizione ed esigenze", "Dati e conferma"],
    next: "Continua", back: "Indietro", summary: "Riepilogo della prenotazione",
    check: "Verifica disponibilità", empty: "Nessun orario disponibile", retry: "Riprova",
    earlyNotes: "Scrivi una nota", errors: "Controlla i dati indicati", invalid: "Controlla questo campo.",
    availabilityError: "Non è stato possibile verificare la disponibilità. Riprova.",
    chooseSlot: "Scegli un orario verificato per data, servizio e coperti correnti.",
    uncertain: "Non abbiamo ricevuto una conferma. La prenotazione potrebbe essere stata registrata. Puoi riprovare con gli stessi dati oppure contattare il ristorante.",
    edit: "Modifica i dati", editWarning: "Una richiesta precedente potrebbe essere già stata registrata. Inviare dati modificati può creare un'altra prenotazione.",
    originalRetry: "Riprova con gli stessi dati", pending: "I dati del tentativo sono bloccati durante l'invio.",
  },
  en: {
    sections: ["When and how many", "Party and requests", "Your details and confirmation"],
    next: "Continue", back: "Back", summary: "Booking summary",
    check: "Check availability", empty: "No available times", retry: "Try again",
    earlyNotes: "Write a note", errors: "Check the indicated details", invalid: "Check this field.",
    availabilityError: "We couldn't check availability. Try again.",
    chooseSlot: "Choose a verified time for the current date, service and total covers.",
    uncertain: "We didn't receive confirmation. Your booking may have been recorded. You can retry with the same details or contact the restaurant.",
    edit: "Edit details", editWarning: "A previous request may already have been recorded. Submitting changed details may create another booking.",
    originalRetry: "Retry with the same details", pending: "The attempt details are locked while submitting.",
  },
} as const;
const inputClass = "mt-2 block min-h-11 w-full min-w-0 rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-950 outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-100";
const buttonClass = "inline-flex min-h-11 items-center justify-center rounded-2xl bg-zinc-950 px-5 py-3 font-bold text-white focus:outline-none focus:ring-4 focus:ring-orange-300 disabled:cursor-wait disabled:opacity-60";

export function PublicBookingForm({ contacts, contents, initialLanguage }: {
  contacts: PublicContacts; contents: PublicContentSet; initialLanguage: Language;
}) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const [values, setValues] = useState<BookingValues>({ ...initialBookingValues });
  const [composition, setComposition] = useState(compositionFormState());
  const [reached, setReached] = useState<Section>(1);
  const [availability, setAvailability] = useState<AvailabilityState>(idleAvailability);
  const [retry, setRetry] = useState(0);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [status, setStatus] = useState<"IDLE" | "PENDING" | "UNCERTAIN" | "EDITING" | "REJECTED">("IDLE");
  const [failure, setFailure] = useState<string | null>(null);
  const [managementPath, setManagementPath] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ target: string; id: number } | null>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const identity = useRef<ClientSubmissionIdentity | null>(null);
  const attempt = useRef<SubmissionAttempt | null>(null);
  const sequence = useRef(0);
  const copy = text[language];
  const ui = progressive[language];
  const editorial = contents[language === "it" ? "IT" : "EN"];
  const queryKey = availabilityQuery(values);
  const currentAvailability: AvailabilityState = !queryKey ? idleAvailability
    : availability.key === queryKey ? availability : { status: "LOADING", key: queryKey, generation: 0, slots: [] };
  const locked = status === "PENDING" || status === "UNCERTAIN";

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!focusRequest) return;
    const element = document.getElementById(focusRequest.target);
    const target = focusRequest.target === "booking-composition"
      ? element?.querySelector<HTMLElement>('input[aria-invalid="true"]') ?? element?.querySelector<HTMLElement>('input:invalid') ?? element?.querySelector<HTMLElement>('input') : element;
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }, [focusRequest, reached]);
  useEffect(() => {
    if (!queryKey) return;
    const controller = new AbortController();
    request.current = controller;
    const requestGeneration = ++generation.current;
    const [date, service, partySize] = JSON.parse(queryKey) as [string, string, number];
    const current: AvailabilityState = { status: "LOADING", key: queryKey, generation: requestGeneration, slots: [] };
    void fetch("/api/public/availability?date=" + encodeURIComponent(date) + "&service=" + service + "&partySize=" + partySize,
      { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error();
        const body: unknown = await response.json();
        if (!controller.signal.aborted && generation.current === requestGeneration) {
          setAvailability(settleAvailability(current, queryKey, requestGeneration, body));
        }
      }).catch(() => {
        if (!controller.signal.aborted && generation.current === requestGeneration) setAvailability({ ...current, status: "ERROR" });
      });
    return () => controller.abort();
  }, [queryKey, retry]);

  function focus(target: string) { setFocusRequest({ target, id: ++sequence.current }); }
  function selectLanguage(nextLanguage: Language) {
    setLanguage(nextLanguage);
    const url = new URL(window.location.href);
    url.searchParams.set("lang", nextLanguage);
    window.history.replaceState(null, "", url);
  }
  function update<K extends keyof BookingValues>(field: K, value: BookingValues[K]) {
    if (busy.current || status === "UNCERTAIN") return;
    setValues(previous => {
      const next = { ...previous, [field]: value };
      if (["localDate", "serviceType", "partySize"].includes(field)) next.arrivalTime = "";
      return next;
    });
    if (["localDate", "serviceType", "partySize"].includes(field)) {
      request.current?.abort(); ++generation.current; setAvailability(idleAvailability);
    }
  }
  function payload(): BookingPayload { return { ...values, ...compositionPayload(composition), language }; }
  function targetFor(field: string) { return ["childrenCount", "gameRoomPreference"].includes(field) ? "booking-composition" : "booking-" + field; }
  function labelFor(field: string) {
    if (field === "localDate") return copy.date;
    if (field === "serviceType") return copy.service;
    if (field === "arrivalTime") return copy.slot;
    if (field === "childrenCount" || field === "gameRoomPreference") return ui.sections[1];
    if (field === "privacyAccepted") return copy.privacy;
    if (field === "termsAccepted") return copy.terms;
    const labels: Record<string, string> = { partySize: copy.partySize, customerFirstName: copy.firstName, customerLastName: copy.lastName, customerPhone: copy.phone, customerEmail: copy.email, allergies: copy.allergies, intolerances: copy.intolerances, celebration: copy.celebration, notes: copy.notes };
    return labels[field] ?? ui.invalid;
  }
  function validate(through: Section): boolean {
    const found = bookingIssues(payload(), currentAvailability, through, composition);
    setIssues(found);
    if (!found.length) return true;
    setReached(previous => reachSection(previous, Math.max(...found.map(issue => issue.section)) as Section));
    focus(targetFor(found[0].field));
    return false;
  }
  function advance(from: 1 | 2) {
    if (!validate(from)) return;
    const next = (from + 1) as Section;
    setReached(previous => reachSection(previous, next)); focus("booking-section-" + next);
  }
  function retryAvailability() {
    request.current?.abort(); ++generation.current; setAvailability(idleAvailability);
    setValues(previous => ({ ...previous, arrivalTime: "" })); setRetry(previous => previous + 1);
  }
  async function dispatch(frozen: SubmissionAttempt) {
    let dispatched = false;
    try {
      dispatched = true;
      const response = await fetch("/api/public/reservations", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": frozen.key }, body: frozen.signature,
      });
      const body: unknown = await response.json();
      if (!mounted.current || !ownsAttempt(attempt.current, frozen)) return;
      if (response.ok && body && typeof body === "object" && "managementPath" in body &&
        typeof body.managementPath === "string" && /^\/p\/[A-Za-z0-9_-]+$/u.test(body.managementPath)) {
        setManagementPath(body.managementPath); focus("booking-confirmation"); identity.current = null; attempt.current = null; setStatus("IDLE");
      } else if (!response.ok && response.status < 500 && body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        setFailure(body.error); setStatus("REJECTED");
      } else { setStatus("UNCERTAIN"); }
    } catch {
      if (mounted.current && ownsAttempt(attempt.current, frozen)) setStatus(dispatched ? "UNCERTAIN" : "REJECTED");
    } finally {
      busy.current = false;
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || status === "UNCERTAIN" || !validate(3)) return;
    const captured = payload();
    busy.current = true;
    setStatus("PENDING"); setFailure(null);
    try {
      const signature = JSON.stringify(captured);
      const resolved = resolveClientSubmissionIdentity(identity.current, signature);
      identity.current = resolved;
      const frozen = freezeAttempt(captured, resolved, ++sequence.current);
      attempt.current = frozen;
      await dispatch(frozen);
    } catch {
      busy.current = false; setFailure(null); setStatus("REJECTED");
    }
  }
  function retryOriginal() {
    if (busy.current || !attempt.current) return;
    busy.current = true; setStatus("PENDING"); setFailure(null); void dispatch(attempt.current);
  }
  function fieldError(field: string) {
    return issues.some(issue => issue.field === field)
      ? <p className="mt-2 text-sm font-semibold text-red-800" id={"error-" + field}>{field === "arrivalTime" ? ui.chooseSlot : ui.invalid}</p> : null;
  }
  function attributes(field: string) {
    return { id: "booking-" + field, "aria-invalid": issues.some(issue => issue.field === field) || undefined,
      "aria-describedby": issues.some(issue => issue.field === field) ? "error-" + field : undefined };
  }
  function textField(field: "customerFirstName" | "customerLastName" | "customerPhone" | "customerEmail" | "celebration", label: string, maxLength: number, type = "text", required = false) {
    const autoComplete = { customerFirstName: "given-name", customerLastName: "family-name", customerPhone: "tel", customerEmail: "email", celebration: "off" }[field];
    return <div className="min-w-0"><label className="block text-sm font-bold" htmlFor={"booking-" + field}>{label}</label><input {...attributes(field)} autoComplete={autoComplete} className={inputClass} maxLength={maxLength} name={field} onChange={event => update(field, event.target.value)} required={required} type={type} value={values[field]} />{fieldError(field)}</div>;
  }
  function area(field: "allergies" | "intolerances" | "notes", label: string, maxLength: number) {
    return <div className="min-w-0"><label className="block text-sm font-bold" htmlFor={"booking-" + field}>{label}</label><textarea {...attributes(field)} className={inputClass} maxLength={maxLength} name={field} onChange={event => update(field, event.target.value)} rows={3} value={values[field]} />{fieldError(field)}</div>;
  }
  if (managementPath) return (
    <main className="min-h-screen bg-zinc-950 px-5 py-12" lang={language}><section className="mx-auto max-w-2xl rounded-3xl bg-white p-6 sm:p-12">
      <h1 className="whitespace-pre-line text-3xl font-black" id="booking-confirmation" tabIndex={-1}>{editorial.CONFIRMATION_MESSAGE}</h1><p className="mt-5">{copy.keepLink}</p>
      <a className={buttonClass + " mt-6"} href={managementPath + "?lang=" + language} rel="noreferrer">{copy.link}</a>
      <p className="mt-6 whitespace-pre-line">{editorial.CONTACT_PROMPT}</p><PublicContactLinks contacts={contacts} language={language} />
    </section></main>
  );
  return <main className="min-h-screen bg-zinc-100 px-3 py-6 sm:px-8" lang={language}>
    <div className="mx-auto max-w-4xl overflow-hidden rounded-3xl bg-white shadow-xl">
      <header className="bg-zinc-950 p-6 text-white sm:p-10">
        <p className="text-sm font-black uppercase tracking-widest text-orange-400">{copy.eyebrow}</p>
        <h1 className="mt-3 break-words text-3xl font-black sm:text-4xl">{editorial.BOOKING_PAGE_TITLE}</h1>
        <p className="mt-4 whitespace-pre-line text-zinc-300">{editorial.BOOKING_PAGE_INTRO}</p>
        <div className="mt-5 flex gap-2" role="group" aria-label={copy.language}>{(["it", "en"] as const).map(option =>
          <button aria-pressed={language === option} className="min-h-11 rounded-xl border border-zinc-500 px-4 py-2 font-bold aria-pressed:bg-orange-700" key={option} onClick={() => selectLanguage(option)} type="button">{option.toUpperCase()}</button>)}</div>
      </header>
      <form aria-busy={status === "PENDING"} className="space-y-7 p-4 sm:p-8" noValidate onSubmit={submit}>
        {issues.length > 0 ? <div className="rounded-2xl border-2 border-red-700 p-4" id="booking-errors" role="alert" tabIndex={-1}>
          <h2 className="font-bold">{ui.errors}</h2><ul className="mt-2 list-inside list-disc">{issues.map(issue =>
            <li key={issue.field}><a className="underline" href={"#" + targetFor(issue.field)} onClick={event => { event.preventDefault(); setReached(previous => reachSection(previous, issue.section)); focus(targetFor(issue.field)); }}>{labelFor(issue.field)}</a></li>)}</ul>
        </div> : null}
        <fieldset className="min-w-0 space-y-6" disabled={locked}>
          <section aria-labelledby="booking-section-1" className="space-y-5">
            <h2 className="text-xl font-black outline-none focus:ring-4 focus:ring-orange-200" id="booking-section-1" tabIndex={-1}>1. {ui.sections[0]}</h2>
            <div className="grid min-w-0 gap-5 sm:grid-cols-2">
              <div className="min-w-0"><label className="text-sm font-bold" htmlFor="booking-localDate">{copy.date}</label><input {...attributes("localDate")} className={inputClass} name="localDate" onChange={event => update("localDate", event.target.value)} required type="date" value={values.localDate} />{fieldError("localDate")}</div>
              <div className="min-w-0"><label className="text-sm font-bold" htmlFor="booking-serviceType">{copy.service}</label><select {...attributes("serviceType")} className={inputClass} onChange={event => update("serviceType", event.target.value as "LUNCH" | "DINNER")} value={values.serviceType}><option value="LUNCH">{copy.lunch}</option><option value="DINNER">{copy.dinner}</option></select></div>
              <div className="min-w-0"><label className="text-sm font-bold" htmlFor="booking-partySize">{copy.partySize}</label><input {...attributes("partySize")} className={inputClass} min={1} onChange={event => update("partySize", Number(event.target.value))} required step={1} type="number" value={values.partySize || ""} />{fieldError("partySize")}</div>
              <div className="min-w-0"><label className="text-sm font-bold" htmlFor="booking-arrivalTime">{copy.slot}</label><select {...attributes("arrivalTime")} className={inputClass} disabled={currentAvailability.status !== "READY" || locked} name="arrivalTime" onChange={event => update("arrivalTime", event.target.value)} required value={values.arrivalTime}><option value="">—</option>{currentAvailability.slots.map(time => <option key={time} value={time}>{time}</option>)}</select>{fieldError("arrivalTime")}</div>
            </div>
            <div aria-live="polite" aria-atomic="true" className="rounded-2xl bg-zinc-100 p-4" data-availability-state={currentAvailability.status}>
              {currentAvailability.status === "IDLE" ? ui.check : currentAvailability.status === "LOADING" ? copy.loading
                : currentAvailability.status === "EMPTY" ? <><p className="font-bold">{ui.empty}</p><p className="whitespace-pre-line">{editorial.UNAVAILABLE_MESSAGE}</p></>
                : currentAvailability.status === "ERROR" ? ui.availabilityError : ui.chooseSlot}
            </div>
            {currentAvailability.status === "ERROR" ? <button className={buttonClass} onClick={retryAvailability} type="button">{ui.retry}</button> : null}
            <div className="flex flex-wrap gap-3"><button className={buttonClass} disabled={currentAvailability.status === "LOADING"} onClick={() => advance(1)} type="button">{ui.next}</button>
              {reached === 1 ? <button className="min-h-11 rounded-xl px-3 font-bold underline" onClick={() => { setReached(2); focus("booking-notes"); }} type="button">{ui.earlyNotes}</button> : null}</div>
          </section>
          {reached >= 2 ? <section aria-labelledby="booking-section-2" className="space-y-5 border-t border-zinc-300 pt-6">
            <h2 className="text-xl font-black outline-none focus:ring-4 focus:ring-orange-200" id="booking-section-2" tabIndex={-1}>2. {ui.sections[1]}</h2>
            <div aria-describedby={issues.some(issue => issue.section === 2 && ["childrenCount", "gameRoomPreference"].includes(issue.field)) ? "composition-errors" : undefined} id="booking-composition">
              <PartyCompositionFields language={language} onChange={next => { if (!busy.current && status !== "UNCERTAIN") setComposition(next); }} partySize={values.partySize} state={composition} />
              <div id="composition-errors">{fieldError("childrenCount")}{fieldError("gameRoomPreference")}</div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">{(["highChair", "stroller", "accessibility", "celiac", "animals"] as const).map(field =>
              <label className="flex min-h-11 items-center gap-3 rounded-2xl bg-zinc-100 p-4 font-bold" key={field}><input checked={values[field]} name={field} onChange={event => update(field, event.target.checked)} type="checkbox" />{copy[field]}</label>)}</div>
            <div className="grid min-w-0 gap-5 sm:grid-cols-2">{area("allergies", copy.allergies, 300)}{area("intolerances", copy.intolerances, 300)}{textField("celebration", copy.celebration, 200)}</div>
            {area("notes", copy.notes, 1000)}
            <p className="text-sm text-zinc-700">{restaurantDiscretionCopy[language]}</p>
            <div className="flex flex-wrap gap-3"><button className={buttonClass} onClick={() => focus("booking-section-1")} type="button">{ui.back}</button><button className={buttonClass} disabled={currentAvailability.status === "LOADING"} onClick={() => advance(2)} type="button">{ui.next}</button></div>
          </section> : null}
          {reached >= 3 ? <section aria-labelledby="booking-section-3" className="space-y-5 border-t border-zinc-300 pt-6">
            <h2 className="text-xl font-black outline-none focus:ring-4 focus:ring-orange-200" id="booking-section-3" tabIndex={-1}>3. {ui.sections[2]}</h2>
            <div className="grid min-w-0 gap-5 sm:grid-cols-2">{textField("customerFirstName", copy.firstName, 80, "text", true)}{textField("customerLastName", copy.lastName, 80, "text", true)}{textField("customerPhone", copy.phone, 40, "tel", true)}{textField("customerEmail", copy.email, 254, "email")}</div>
            <section aria-label={ui.summary} className="rounded-2xl bg-zinc-100 p-4"><h3 className="font-black">{ui.summary}</h3><p className="mt-2 break-words">{values.localDate} · {values.serviceType === "LUNCH" ? copy.lunch : copy.dinner} · {values.arrivalTime || "—"}</p><p>{copy.partySize}: {values.partySize}</p><p>{language === "it" ? "Bambini" : "Children"}: {compositionPayload(composition).childrenCount ?? "—"}</p>{composition.mode === "children" ? <p>{language === "it" ? "Richiesta giochi non garantita" : "Games room request is not guaranteed"}: {composition.games === "yes" ? language === "it" ? "Sì" : "Yes" : "No"}</p> : null}</section>
            {(["privacyAccepted", "termsAccepted"] as const).map(field => <div key={field}><label className="block text-sm font-bold"><span className="flex min-h-11 items-start gap-3"><input {...attributes(field)} checked={values[field]} className="mt-1" name={field} onChange={event => update(field, event.target.checked)} required type="checkbox" />{field === "privacyAccepted" ? copy.privacy : copy.terms}</span></label>{fieldError(field)}</div>)}
            <button className={buttonClass} onClick={() => focus("booking-section-2")} type="button">{ui.back}</button>
            <button className={buttonClass + " ml-2"} disabled={!hasCurrentSlot(currentAvailability, values) || locked} type="submit">{status === "PENDING" ? copy.submitting : copy.submit}</button>
          </section> : null}
        </fieldset>
        {status === "PENDING" ? <p role="status">{ui.pending}</p> : null}
        {status === "UNCERTAIN" || status === "EDITING" ? <div className="space-y-4 rounded-2xl border-2 border-orange-600 p-4" role="alert"><p>{ui.uncertain}</p>
          {status === "EDITING" ? <p className="font-bold">{ui.editWarning}</p> : null}
          <div className="flex flex-wrap gap-3"><button className={buttonClass} onClick={retryOriginal} type="button">{ui.originalRetry}</button>
            {status === "UNCERTAIN" ? <button className={buttonClass} onClick={() => { setStatus("EDITING"); focus("booking-section-3"); }} type="button">{ui.edit}</button> : null}</div>
        </div> : null}
        {status === "REJECTED" ? <p className="rounded-2xl bg-red-50 p-4 font-bold text-red-800" role="alert">{language === "it" ? failure ?? copy.genericError : copy.genericError}</p> : null}
        <section className="rounded-2xl bg-zinc-100 p-4"><p className="whitespace-pre-line">{editorial.CONTACT_PROMPT}</p><PublicContactLinks contacts={contacts} language={language} /></section>
      </form>
    </div>
  </main>;
}
