"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, type FormEvent } from "react";
import { usePathname } from "next/navigation";
import { PartyCompositionFields, compositionPayload, restaurantDiscretionCopy, type CompositionFormState } from "@/app/prenota/party-composition-fields";
import { StaffSensitiveRegion, useStaffDraftBinding, useStaffDraftHost, useStaffHostView } from "@/app/_components/staff/staff-draft-host";
import { useAgendaContext } from "@/app/dashboard/agenda-context";
import { resolveClientSubmissionIdentity } from "@/shared/client/client-idempotency";
import type { StaffDraftValues } from "@/modules/dashboard/domain/staff-draft-state";
import type { StaffReservationDto } from "@/modules/reservations/domain/staff-dto";
import { useState } from "react";

export const reservationFieldClassName = "mt-2 block min-h-11 w-full min-w-0 rounded-control border border-border-strong bg-surface px-3 py-2 text-base text-text-primary focus:outline-2 focus:outline-brand-primary";
export function formString(values: StaffDraftValues, name: string): string { const value = values[name]; return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value); }
export function formComposition(values: StaffDraftValues): CompositionFormState {
  const mode = values.compositionMode, games = values.compositionGames;
  return { mode: mode === "adults" || mode === "children" || mode === "unknown" ? mode : "", count: formString(values, "compositionCount"), games: games === "yes" || games === "no" ? games : "" };
}
export function reservationFormValues(date: string, service: "LUNCH" | "DINNER", reservation?: StaffReservationDto): StaffDraftValues {
  return {
    localDate: reservation?.localDate ?? date, serviceType: reservation?.serviceType ?? service, arrivalTime: reservation?.arrivalTime ?? "", partySize: String(reservation?.partySize ?? 2),
    compositionMode: reservation ? reservation.childrenCount === null ? "unknown" : reservation.childrenCount === 0 ? "adults" : "children" : "unknown",
    compositionCount: reservation?.childrenCount ? String(reservation.childrenCount) : "", compositionGames: reservation?.gameRoomPreference === null || reservation?.gameRoomPreference === undefined ? "" : reservation.gameRoomPreference ? "yes" : "no",
    customerFirstName: reservation?.customer.firstName ?? "", customerLastName: reservation?.customer.lastName ?? "", customerPhone: reservation?.customer.phone ?? "", customerEmail: reservation?.customer.email ?? "",
    highChair: reservation?.highChair ?? false, stroller: reservation?.stroller ?? false, accessibility: reservation?.accessibility ?? false, celiac: reservation?.celiac ?? false, animals: reservation?.animals ?? false,
    allergies: reservation?.allergies ?? "", intolerances: reservation?.intolerances ?? "", celebration: reservation?.celebration ?? "", notes: reservation?.notes ?? "",
    capacityOverride: false, capacityOverrideReason: "", verbalConsentConfirmed: false, sendWhatsAppConfirmation: true,
  };
}
export function reservationFormPayload(values: StaffDraftValues) {
  const capacityOverride = values.capacityOverride === true;
  return { localDate: formString(values, "localDate"), serviceType: formString(values, "serviceType"), arrivalTime: formString(values, "arrivalTime"), partySize: Number(values.partySize),
    ...compositionPayload(formComposition(values)), customerFirstName: formString(values, "customerFirstName"), customerLastName: formString(values, "customerLastName"),
    customerPhone: formString(values, "customerPhone"), customerEmail: formString(values, "customerEmail"), highChair: values.highChair === true, stroller: values.stroller === true,
    accessibility: values.accessibility === true, celiac: values.celiac === true, allergies: formString(values, "allergies"), intolerances: formString(values, "intolerances"),
    celebration: formString(values, "celebration"), animals: values.animals === true, notes: formString(values, "notes"), capacityOverride,
    capacityOverrideReason: capacityOverride ? formString(values, "capacityOverrideReason") : null };
}

export function StaffReservationFields({ values, patch, pending, original, baseline, phone, privacyPolicyVersion }: {
  values: StaffDraftValues; patch: (values: StaffDraftValues) => void; pending: boolean; original?: StaffReservationDto; baseline?: StaffDraftValues; phone: boolean; privacyPolicyVersion?: string;
}) {
  const [slots, setSlots] = useState<{ time: string; remainingCapacity: number; reason?: string }[]>([]), [availabilityMessage, setAvailabilityMessage] = useState("Caricamento degli slot configurati…");
  const date = formString(values, "localDate"), service = formString(values, "serviceType"), partySize = Number(values.partySize), arrival = formString(values, "arrivalTime");
  const validParty = Number.isInteger(partySize) && partySize > 0;
  useEffect(() => {
    if (!validParty) return;
    const abort = new AbortController(), query = new URLSearchParams({ date, service, partySize: String(partySize) });
    void fetch(`/api/staff/availability?${query.toString()}`, { cache: "no-store", signal: abort.signal }).then(async response => {
      const body = await response.json() as { isOpen?: boolean; slots?: { time: string; remainingCapacity: number; reason?: string }[] };
      if (!response.ok) throw new Error("Availability unavailable");
      const next = (body.slots ?? []).filter(slot => slot.reason !== "SLOT_IN_PAST");
      const currentDate = baseline ? formString(baseline, "localDate") : original?.localDate;
      const currentService = baseline ? formString(baseline, "serviceType") : original?.serviceType;
      const currentArrival = baseline ? formString(baseline, "arrivalTime") : original?.arrivalTime;
      if (currentArrival && date === currentDate && service === currentService && !next.some(slot => slot.time === currentArrival)) next.unshift({ time: currentArrival, remainingCapacity: 0, reason: "CURRENT" });
      setSlots(next); setAvailabilityMessage(original ? "L’anteprima è indicativa; il server esclude questa prenotazione nel controllo definitivo." : body.isOpen ? "Gli slot pieni richiedono override esplicito." : "Il servizio selezionato è chiuso.");
    }).catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setAvailabilityMessage("Disponibilità non consultabile. Riprova."); });
    return () => abort.abort();
  }, [baseline, date, original, partySize, service, validParty]);
  const input = (name: string, label: string, type = "text", maxLength = 80, required = false) => <label className="min-w-0 text-sm font-semibold">{label}<input className={reservationFieldClassName} name={name} type={type} maxLength={maxLength} required={required} value={formString(values, name)} onChange={event => patch({ [name]: event.target.value })} /></label>;
  return <fieldset disabled={pending} className="min-w-0 space-y-5">
    <legend className="sr-only">Dati della prenotazione</legend>
    <div className="grid min-w-0 gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {input("localDate", "Data", "date", 10, true)}
      <label className="min-w-0 text-sm font-semibold">Servizio<select aria-label="Servizio" className={reservationFieldClassName} name="serviceType" value={service} onChange={event => patch({ serviceType: event.target.value })}><option value="LUNCH">Pranzo</option><option value="DINNER">Cena</option></select></label>
      <label className="min-w-0 text-sm font-semibold">In quanti siete? (coperti totali)<input className={reservationFieldClassName} name="partySize" min={1} type="number" step={1} required value={formString(values, "partySize")} onChange={event => patch({ partySize: event.target.value })} /></label>
      <div className="min-w-0 sm:col-span-2 lg:col-span-4"><PartyCompositionFields allowUnknown={phone || (baseline ? baseline.compositionMode === "unknown" && partySize === Number(baseline.partySize) : original?.childrenCount === null && partySize === original.partySize)} partySize={partySize} state={formComposition(values)} onChange={composition => patch({ compositionMode: composition.mode, compositionCount: composition.count, compositionGames: composition.games })} /></div>
      <label className="min-w-0 text-sm font-semibold">{phone ? "Slot configurato" : "Slot"}<select className={reservationFieldClassName} name="arrivalTime" required value={arrival} onChange={event => patch({ arrivalTime: event.target.value })}>
        <option value="">Seleziona…</option>
        {arrival && !slots.some(slot => slot.time === arrival) ? <option value={arrival}>{arrival} · da rivalutare</option> : null}
        {(validParty ? slots : []).map(slot => <option key={slot.time} value={slot.time}>{slot.time}{slot.reason === "CURRENT" ? " · attuale" : ` · ${slot.remainingCapacity} posti residui`}{slot.reason === "CAPACITY_EXCEEDED" ? " · pieno" : ""}</option>)}
      </select><span className="mt-2 block text-xs font-normal text-text-muted">{validParty ? availabilityMessage : "Inserisci un numero di persone valido."}</span></label>
      {input("customerFirstName", "Nome", "text", 80, true)}{input("customerLastName", "Cognome", "text", 80, true)}{input("customerPhone", "Telefono", "tel", 40, true)}{input("customerEmail", phone ? "Email (facoltativa)" : "Email", "email", 254)}
    </div>
    {original?.legacyPreference || original?.roomCode ? <p className="text-sm [overflow-wrap:anywhere]">Preferenza storica: {original.legacyPreference ?? original.roomCode}. Non è un’assegnazione definitiva.</p> : null}
    <fieldset className="min-w-0 rounded-surface bg-surface-muted p-4"><legend className="px-1 font-semibold">Esigenze e indicatori</legend>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["highChair", "Seggiolone"], ["stroller", "Passeggino"], ["accessibility", "Accessibilità"], ["celiac", "Celiachia"], ["animals", "Animali"]].map(([name, label]) => <label className="flex min-h-11 items-center gap-3 text-sm" key={name}><input type="checkbox" name={name} checked={values[name] === true} onChange={event => patch({ [name]: event.target.checked })} />{label}</label>)}</div>
      {original?.legacyAllergy ? <section aria-label="Allergia storica" className="mt-3 text-sm [overflow-wrap:anywhere]"><h2 className="font-semibold">Allergia storica</h2><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{original.legacyAllergy}</p><p>Sola lettura</p></section> : null}
      <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">{[["allergies", "Allergie dichiarate", 300], ["intolerances", "Intolleranze", 300], ["celebration", "Compleanno o ricorrenza", 200], ["notes", "Note", 1000]].map(([name, label, max]) => <label className="min-w-0 text-sm font-semibold" key={String(name)}>{label}<textarea aria-label={String(label)} className={reservationFieldClassName} name={String(name)} rows={2} maxLength={Number(max)} value={formString(values, String(name))} onChange={event => patch({ [String(name)]: event.target.value })} /></label>)}</div>
    </fieldset>
    <p className="text-sm text-text-secondary">{restaurantDiscretionCopy.it}</p>
    {phone ? <>
      <label className="flex min-h-11 items-start gap-3 rounded-control border border-info/30 p-4 text-sm"><input className="mt-1" type="checkbox" name="sendWhatsAppConfirmation" checked={values.sendWhatsAppConfirmation === true} onChange={event => patch({ sendWhatsAppConfirmation: event.target.checked })} /><span>Invia conferma WhatsApp<span className="mt-1 block">Riguarda solo la conferma WhatsApp iniziale. I promemoria futuri restano previsti e, con invio parallelo, l’email può partire in modo indipendente.</span></span></label>
      <label className="flex min-h-11 items-start gap-3 rounded-control border border-success/30 p-4 text-sm"><input className="mt-1" type="checkbox" required name="verbalConsentConfirmed" checked={values.verbalConsentConfirmed === true} onChange={event => patch({ verbalConsentConfirmed: event.target.checked })} /><span>Confermo di avere acquisito verbalmente il consenso privacy. Il server registrerà metodo, versione {privacyPolicyVersion}, orario e utente della sessione.</span></label>
    </> : null}
    <section className="rounded-control border border-warning/30 p-4"><label className="flex min-h-11 items-center gap-3 text-sm font-semibold"><input name="capacityOverride" type="checkbox" checked={values.capacityOverride === true} onChange={event => patch({ capacityOverride: event.target.checked })} />Override esplicito della sola capacità (Staff/Admin)</label><p className="mt-2 text-xs">È valido soltanto per un superamento reale della capacità. Non modifica i guard di data, servizio o slot.</p><label className="mt-3 block text-sm font-semibold">Motivo dell&apos;override<textarea aria-label="Motivo dell'override" className={reservationFieldClassName} name="capacityOverrideReason" maxLength={500} rows={2} value={formString(values, "capacityOverrideReason")} onChange={event => patch({ capacityOverrideReason: event.target.value })} /></label></section>
  </fieldset>;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isValidReservationResponse(value: unknown): value is { replayed?: unknown; reservation: { id: string } } {
  if (!isRecord(value) || !isRecord(value.reservation)) return false;
  const reservationId = value.reservation.id;
  return typeof reservationId === "string" && reservationId.trim().length > 0;
}
export function ReservationCreateForm({ defaultDate, defaultService = "DINNER", privacyPolicyVersion }: { defaultDate: string; defaultService?: "LUNCH" | "DINNER"; privacyPolicyVersion: string }) {
  const controller = useStaffDraftHost(), view = useStaffHostView(), agenda = useAgendaContext(), pathname = usePathname();
  const initial = useMemo(() => reservationFormValues(defaultDate, defaultService), [defaultDate, defaultService]);
  useEffect(() => { void controller.verifySession(); }, [controller]);
  const resourceId = useMemo(() => view.drafts.identity && view.drafts.auth === "AUTHORIZED" ? controller.phoneId() : "", [controller, view.drafts.identity, view.drafts.auth]);
  const binding = useStaffDraftBinding({ kind: "PHONE", resourceId, values: initial, version: null, route: pathname, originPath: agenda.origin(defaultDate), allowed: !!resourceId && controller.sessionVisible() });
  const error = useRef<HTMLDivElement>(null);
  useEffect(() => { if (binding.record?.error) error.current?.focus(); }, [binding.record?.error]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const record = binding.key ? controller.getSnapshot().drafts.records[binding.key] : null;
    if (!record || record.phase === "PENDING") return;
    // Snapshot all host-owned fields before mutate synchronously locks them.
    const values = record.values, base = reservationFormPayload(values);
    const payload = { localDate: base.localDate, serviceType: base.serviceType, arrivalTime: base.arrivalTime, partySize: base.partySize,
      childrenCount: base.childrenCount, gameRoomPreference: base.gameRoomPreference, customerFirstName: base.customerFirstName, customerLastName: base.customerLastName,
      customerPhone: base.customerPhone, customerEmail: base.customerEmail, highChair: base.highChair, stroller: base.stroller, accessibility: base.accessibility,
      celiac: base.celiac, allergies: base.allergies, intolerances: base.intolerances, celebration: base.celebration, animals: base.animals, notes: base.notes,
      verbalConsentConfirmed: values.verbalConsentConfirmed === true, sendWhatsAppConfirmation: values.sendWhatsAppConfirmation === true,
      capacityOverride: base.capacityOverride, capacityOverrideReason: base.capacityOverrideReason };
    const signature = JSON.stringify(payload);
    let identity;
    try { identity = resolveClientSubmissionIdentity(record.retryIdentity, signature); }
    catch { controller.failBeforeAttempt(record.key, "Non è stato possibile creare la prenotazione. Generazione sicura dell’identità della richiesta non disponibile."); return; }
    await controller.mutate({ key: record.key, url: "/api/staff/reservations", method: "POST", payload: signature, idempotencyKey: identity.key, failureMessage: "Non è stato possibile creare la prenotazione.", validate: body => {
      if (!isValidReservationResponse(body)) return null;
      return { resourceId: body.reservation.id, version: null, text: body.replayed === true ? "Questa richiesta era già stata registrata: nessun duplicato creato." : "Prenotazione telefonica salvata e capacità aggiornata." };
    } });
  }
  const record = binding.record;
  return <>
    {binding.resumeRequired ? <div className="mt-5 rounded-control border border-warning p-4"><p>È disponibile una bozza PHONE temporanea.</p><button type="button" className="mt-2 min-h-11 underline" onClick={() => void binding.resume()}>Continua modifica</button></div> : null}
    {!record && !binding.resumeRequired ? <p role="status" className="mt-5">Verifica della sessione prima di aprire il modulo…</p> : null}
    <StaffSensitiveRegion allowed={record !== null}>{record ? <form className="mt-6 min-w-0 rounded-surface border border-border bg-surface p-4 sm:p-7" onSubmit={submit}>
      <StaffReservationFields values={record.values} patch={binding.patch} pending={binding.pending} phone privacyPolicyVersion={privacyPolicyVersion} />
      {record.error ? <div className="mt-4 rounded-control border border-danger p-3 text-danger" ref={error} tabIndex={-1} role="alert">{record.error}</div> : null}
      {record.receipt ? <div role="status" className="mt-4 rounded-control border border-success p-3"><p>{record.receipt.text}</p><p>ID: {record.receipt.resourceId}</p><Link className="inline-flex min-h-11 items-center underline" href={`/dashboard/reservations/${record.receipt.resourceId}`} onNavigate={event => { event.preventDefault(); agenda.navigate(`/dashboard/reservations/${record.receipt!.resourceId}`); }}>Apri dettaglio</Link></div> : null}
      <div className="mt-5 flex flex-wrap gap-3"><button className="min-h-11 rounded-control bg-brand-primary px-5 py-2 text-brand-on-primary disabled:opacity-50" disabled={binding.pending} type="submit">{binding.pending ? "Salvataggio…" : "Salva prenotazione telefonica"}</button><Link className="inline-flex min-h-11 items-center rounded-control border border-border px-4" href={record.originPath} onNavigate={event => { event.preventDefault(); agenda.navigate(record.originPath, [record.key]); }}>Torna Agenda</Link></div>
    </form> : null}</StaffSensitiveRegion>
  </>;
}
