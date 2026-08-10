"use client";

import { useEffect, useState, type FormEvent } from "react";

interface ReservationView {
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  partySize: number;
  status: "CONFIRMED" | "CANCELLED";
  customer: { firstName: string; lastName: string; phone: string; email: string | null };
  roomCode: string;
  highChair: boolean;
  stroller: boolean;
  accessibility: boolean;
  children: boolean;
  celiac: boolean;
  allergies: string | null;
  intolerances: string | null;
  celebration: string | null;
  animals: boolean;
  notes: string | null;
  canModify: boolean;
  canCancel: boolean;
  viewExpiresAt: string;
}

type EditableReservation = Omit<ReservationView, "status" | "customer" | "canModify" | "canCancel" | "viewExpiresAt">;

interface AvailabilityView {
  slots?: Array<{ time: string; available: boolean }>;
  rooms?: Array<{ code: string; name: string }>;
}

const inputClass = "mt-2 block w-full rounded-2xl border border-zinc-300 bg-white px-4 py-3 text-base outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-100";

const copy = {
  it: { eyebrow: "Link personale", title: "La tua prenotazione", loading: "Caricamento…", invalid: "Il link non è valido o non è più disponibile.", genericError: "Non è stato possibile completare la richiesta.", readOnly: "Il cutoff è trascorso: puoi consultare la prenotazione, ma non modificarla online.", cancelled: "Questa prenotazione è stata annullata.", save: "Salva modifiche", saving: "Salvataggio…", cancel: "Annulla prenotazione", cancelling: "Annullamento…", confirmCancel: "Vuoi davvero annullare la prenotazione?", updated: "Prenotazione aggiornata.", cancelledDone: "Prenotazione annullata.", date: "Data", service: "Servizio", guests: "Persone", time: "Orario", room: "Sala preferita", name: "Cliente", phone: "Telefono", notes: "Note", lunch: "Pranzo", dinner: "Cena", highChair: "Seggiolone", stroller: "Passeggino", accessibility: "Accessibilità", children: "Bambini", celiac: "Celiachia", animals: "Animali", allergies: "Allergie", intolerances: "Intolleranze", celebration: "Compleanno o ricorrenza" },
  en: { eyebrow: "Personal link", title: "Your booking", loading: "Loading…", invalid: "The link is invalid or no longer available.", genericError: "The request could not be completed.", readOnly: "The cutoff has passed: you can view the booking but cannot change it online.", cancelled: "This booking has been cancelled.", save: "Save changes", saving: "Saving…", cancel: "Cancel booking", cancelling: "Cancelling…", confirmCancel: "Do you really want to cancel the booking?", updated: "Booking updated.", cancelledDone: "Booking cancelled.", date: "Date", service: "Service", guests: "Guests", time: "Time", room: "Preferred room", name: "Guest", phone: "Phone", notes: "Notes", lunch: "Lunch", dinner: "Dinner", highChair: "High chair", stroller: "Stroller", accessibility: "Accessibility", children: "Children", celiac: "Coeliac needs", animals: "Animals", allergies: "Allergies", intolerances: "Intolerances", celebration: "Birthday or occasion" },
} as const;

function editableFromReservation(reservation: ReservationView): EditableReservation {
  return {
    localDate: reservation.localDate,
    serviceType: reservation.serviceType,
    arrivalTime: reservation.arrivalTime,
    partySize: reservation.partySize,
    roomCode: reservation.roomCode,
    highChair: reservation.highChair,
    stroller: reservation.stroller,
    accessibility: reservation.accessibility,
    children: reservation.children,
    celiac: reservation.celiac,
    allergies: reservation.allergies,
    intolerances: reservation.intolerances,
    celebration: reservation.celebration,
    animals: reservation.animals,
    notes: reservation.notes,
  };
}

export function PersonalReservation({ token }: { token: string }) {
  const [language, setLanguage] = useState<"it" | "en">("it");
  const [reservation, setReservation] = useState<ReservationView | null>(null);
  const [draft, setDraft] = useState<EditableReservation | null>(null);
  const [availability, setAvailability] = useState<AvailabilityView>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const t = copy[language];
  const endpoint = `/api/public/reservations/${encodeURIComponent(token)}`;
  const draftDate = draft?.localDate;
  const draftService = draft?.serviceType;
  const draftPartySize = draft?.partySize;

  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json()) as { reservation?: ReservationView; error?: string };
        if (!response.ok || !body.reservation) throw new Error();
        setReservation(body.reservation);
        setDraft(editableFromReservation(body.reservation));
      })
      .catch(() => { if (!controller.signal.aborted) setError(t.invalid); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, t.invalid]);

  useEffect(() => {
    if (!draftDate || !draftService || !draftPartySize || !reservation) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void fetch(`/api/public/availability?date=${encodeURIComponent(draftDate)}&service=${draftService}&partySize=${draftPartySize}`, { cache: "no-store", signal: controller.signal })
        .then((response) => response.json())
        .then((body: AvailabilityView) => setAvailability(body))
        .catch(() => undefined);
    }, 250);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [draftDate, draftPartySize, draftService, reservation]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setBusy("save"); setError(null); setNotice(null);
    try {
      const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
      const body = (await response.json()) as { reservation?: ReservationView; error?: string };
      if (!response.ok || !body.reservation) { setError(language === "it" ? body.error ?? t.genericError : t.genericError); return; }
      setReservation(body.reservation); setDraft(editableFromReservation(body.reservation)); setNotice(t.updated);
    } catch { setError(t.genericError); } finally { setBusy(null); }
  }

  async function cancel() {
    if (!window.confirm(t.confirmCancel)) return;
    setBusy("cancel"); setError(null); setNotice(null);
    try {
      const response = await fetch(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = (await response.json()) as { reservation?: ReservationView; error?: string };
      if (!response.ok || !body.reservation) { setError(language === "it" ? body.error ?? t.genericError : t.genericError); return; }
      setReservation(body.reservation); setDraft(editableFromReservation(body.reservation)); setNotice(t.cancelledDone);
    } catch { setError(t.genericError); } finally { setBusy(null); }
  }

  if (loading) return <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-white">{t.loading}</main>;
  if (!reservation || !draft) return <main className="flex min-h-screen items-center justify-center bg-zinc-950 p-6"><section className="max-w-xl rounded-3xl bg-white p-8 text-center text-zinc-950"><h1 className="text-3xl font-black">Piccadilly</h1><p className="mt-4 text-zinc-600">{error ?? t.invalid}</p></section></main>;

  const canEdit = reservation.canModify && reservation.status === "CONFIRMED";
  const availableTimes = Array.from(new Set([...(draft.arrivalTime ? [draft.arrivalTime] : []), ...(availability.slots?.filter((slot) => slot.available).map((slot) => slot.time) ?? [])])).sort();

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl overflow-hidden rounded-[2rem] bg-white shadow-xl">
        <header className="flex flex-col gap-6 bg-zinc-950 px-7 py-9 text-white sm:flex-row sm:items-end sm:justify-between sm:px-10">
          <div><p className="text-sm font-black tracking-[0.2em] text-orange-400 uppercase">{t.eyebrow}</p><h1 className="mt-2 text-4xl font-black">{t.title}</h1></div>
          <div className="flex gap-2">{(["it", "en"] as const).map((item) => <button aria-pressed={language === item} className={`rounded-xl px-4 py-2 text-sm font-black ${language === item ? "bg-orange-500" : "bg-zinc-800"}`} key={item} onClick={() => setLanguage(item)} type="button">{item.toUpperCase()}</button>)}</div>
        </header>
        <section className="grid gap-4 border-b border-zinc-200 p-7 sm:grid-cols-2 sm:p-10">
          <div><span className="text-xs font-black tracking-wide text-zinc-500 uppercase">{t.name}</span><p className="mt-1 font-bold">{reservation.customer.firstName} {reservation.customer.lastName}</p></div>
          <div><span className="text-xs font-black tracking-wide text-zinc-500 uppercase">{t.phone}</span><p className="mt-1 font-bold">{reservation.customer.phone}</p></div>
        </section>
        {reservation.status === "CANCELLED" ? <p className="mx-7 mt-7 rounded-2xl bg-zinc-200 p-5 font-bold sm:mx-10">{t.cancelled}</p> : !canEdit ? <p className="mx-7 mt-7 rounded-2xl bg-orange-50 p-5 font-bold text-orange-950 sm:mx-10">{t.readOnly}</p> : null}
        <form className="p-7 sm:p-10" onSubmit={save}>
          <fieldset className="grid gap-5 sm:grid-cols-2" disabled={!canEdit || busy !== null}>
            <label className="text-sm font-bold">{t.date}<input className={inputClass} onChange={(event) => setDraft({ ...draft, localDate: event.target.value, arrivalTime: "" })} required type="date" value={draft.localDate} /></label>
            <label className="text-sm font-bold">{t.service}<select className={inputClass} onChange={(event) => setDraft({ ...draft, serviceType: event.target.value as "LUNCH" | "DINNER", arrivalTime: "" })} value={draft.serviceType}><option value="LUNCH">{t.lunch}</option><option value="DINNER">{t.dinner}</option></select></label>
            <label className="text-sm font-bold">{t.guests}<input className={inputClass} min="1" onChange={(event) => setDraft({ ...draft, partySize: Number(event.target.value) })} required step="1" type="number" value={draft.partySize} /></label>
            <label className="text-sm font-bold">{t.time}<select className={inputClass} onChange={(event) => setDraft({ ...draft, arrivalTime: event.target.value })} required value={draft.arrivalTime}><option value="">—</option>{availableTimes.map((time) => <option key={time}>{time}</option>)}</select></label>
            <label className="text-sm font-bold sm:col-span-2">{t.room}<select className={inputClass} onChange={(event) => setDraft({ ...draft, roomCode: event.target.value })} value={draft.roomCode}>{!availability.rooms?.some((room) => room.code === draft.roomCode) ? <option value={draft.roomCode}>{draft.roomCode}</option> : null}{availability.rooms?.map((room) => <option key={room.code} value={room.code}>{room.name}</option>)}</select></label>
            <div className="grid gap-3 sm:col-span-2 sm:grid-cols-3">{(["highChair", "stroller", "accessibility", "children", "celiac", "animals"] as const).map((field) => <label className="flex items-center gap-3 rounded-2xl bg-zinc-100 p-4 text-sm font-bold" key={field}><input checked={draft[field]} className="size-4 accent-orange-500" onChange={(event) => setDraft({ ...draft, [field]: event.target.checked })} type="checkbox" />{t[field]}</label>)}</div>
            <label className="text-sm font-bold">{t.allergies}<textarea className={inputClass} maxLength={300} onChange={(event) => setDraft({ ...draft, allergies: event.target.value || null })} rows={3} value={draft.allergies ?? ""} /></label>
            <label className="text-sm font-bold">{t.intolerances}<textarea className={inputClass} maxLength={300} onChange={(event) => setDraft({ ...draft, intolerances: event.target.value || null })} rows={3} value={draft.intolerances ?? ""} /></label>
            <label className="text-sm font-bold">{t.celebration}<input className={inputClass} maxLength={200} onChange={(event) => setDraft({ ...draft, celebration: event.target.value || null })} value={draft.celebration ?? ""} /></label>
            <label className="text-sm font-bold">{t.notes}<textarea className={inputClass} maxLength={1000} onChange={(event) => setDraft({ ...draft, notes: event.target.value || null })} rows={3} value={draft.notes ?? ""} /></label>
          </fieldset>
          {error ? <p className="mt-6 rounded-2xl bg-red-50 p-4 font-bold text-red-800" role="alert">{error}</p> : null}
          {notice ? <p className="mt-6 rounded-2xl bg-emerald-50 p-4 font-bold text-emerald-800" role="status">{notice}</p> : null}
          {canEdit ? <div className="mt-7 flex flex-col gap-3 sm:flex-row"><button className="rounded-2xl bg-zinc-950 px-6 py-4 font-black text-white hover:bg-orange-600 disabled:opacity-60" disabled={busy !== null} type="submit">{busy === "save" ? t.saving : t.save}</button><button className="rounded-2xl border border-red-300 px-6 py-4 font-black text-red-700 hover:bg-red-50 disabled:opacity-60" disabled={busy !== null} onClick={cancel} type="button">{busy === "cancel" ? t.cancelling : t.cancel}</button></div> : null}
        </form>
      </div>
    </main>
  );
}
