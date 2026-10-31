"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExportPreview } from "@/app/dashboard/export-preview";
import { StaffSensitiveRegion, useStaffDraftHost, useStaffHostView } from "@/app/_components/staff/staff-draft-host";
import { sameDraftSession, type StaffDraftIdentity } from "@/modules/dashboard/domain/staff-draft-state";
import { EXPORT_PREVIEW_ROOMS, exportPreviewRequestSchema, exportPreviewResponseSchema, type ExportPreviewRequest, type ExportPreviewDto } from "@/modules/exports/domain/export-contract";
import { pdfV2RequestSchema, pdfV2Filename } from "@/modules/exports/domain/pdf-v2-domain";

type ExportAction = "PDF" | "DAY" | "MONTH" | "RANGE" | "PREVIEW" | "PDF_V2";
interface PreviewStamp { identity: StaffDraftIdentity; epoch: number; lease: number; route: string }
const currentRoute = () => window.location.pathname + window.location.search;

function responseFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("content-disposition");
  const match = disposition?.match(/filename="([\x20-\x7E]+)"/iu);
  return match?.[1] ?? fallback;
}

async function responseError(response: Response): Promise<string> {
  try {
    const value = (await response.json()) as { error?: unknown };
    if (typeof value.error === "string" && value.error.trim()) return value.error;
  } catch {
    // The endpoint intentionally returns a generic fallback for non-JSON failures.
  }
  return "Non è stato possibile scaricare il file.";
}

export function ExportPanel({ dashboardDate }: { dashboardDate: string }) {
  const [month, setMonth] = useState(dashboardDate.slice(0, 7));
  const [fromDate, setFromDate] = useState(dashboardDate);
  const [toDate, setToDate] = useState(dashboardDate);
  const [loading, setLoading] = useState<ExportAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestInFlight = useRef(false);
const controller = useStaffDraftHost(), host = useStaffHostView();
  const [form, setForm] = useState({ date: dashboardDate, service: "", room: "ALL" as ExportPreviewRequest["room"], order: "CREATED_ASC" as ExportPreviewRequest["order"], target: "PDF" as ExportPreviewRequest["target"] });
  const [preview, setPreview] = useState<{ data: ExportPreviewDto; stamp: PreviewStamp; generation: number } | null>(null);
  const [previewStatus, setPreviewStatus] = useState("IDLE");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const errorSummary = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const activePreview = useRef<{ id: number; route: string; abort: AbortController; stamp?: PreviewStamp } | null>(null);
  const activePdf = useRef<{ route: string; abort: AbortController; stamp?: PreviewStamp } | null>(null);
  const cancelPdf = useCallback(() => {
    const active = activePdf.current;
    if (!active) return;
    active.abort.abort(); activePdf.current = null;
    requestInFlight.current = false; setLoading(value => value === "PDF_V2" ? null : value);
  }, []);
  const cancelPreview = useCallback(() => {
    ++generation.current;
    const active = activePreview.current;
    active?.abort.abort(); activePreview.current = null;
    if (active) { requestInFlight.current = false; setLoading(value => value === "PREVIEW" ? null : value); }
    setPreview(null); setPreviewError(null); setPreviewStatus("STALE");
  }, []);
  const stampMatches = useCallback((stamp: PreviewStamp) => {
    const view = controller.getSnapshot().drafts;
    return controller.sessionVisible() && stamp.route === currentRoute()
      && view.authEpoch === stamp.epoch && view.leaseEpoch === stamp.lease
      && view.identity !== null && sameDraftSession(stamp.identity, view.identity);
  }, [controller]);
  useLayoutEffect(() => {
    const active = activePreview.current;
    // The proof's own quarantine is expected before a dataset lease exists.
    if (active?.stamp && !stampMatches(active.stamp) || preview && !stampMatches(preview.stamp)) cancelPreview();
  }, [cancelPreview, stampMatches, preview, host.revision]);
  useLayoutEffect(() => {
    const active = activePdf.current;
    if (active?.stamp && !stampMatches(active.stamp)) cancelPdf();
  }, [cancelPdf, stampMatches, host.revision]);
  useEffect(() => () => {
    ++generation.current; activePreview.current?.abort.abort(); activePreview.current = null;
    activePdf.current?.abort.abort(); activePdf.current = null;
  }, []);
  useEffect(() => {
    const invalidate = () => cancelPdf();
    window.addEventListener("pagehide", invalidate);
    return () => window.removeEventListener("pagehide", invalidate);
  }, [cancelPdf]);
  useLayoutEffect(() => { if (previewError) errorSummary.current?.focus(); }, [previewError]);
  function change<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    cancelPdf();
    cancelPreview(); setInvalidFields([]); setForm(previous => ({ ...previous, [key]: value }));
  }

  async function downloadPdfV2() {
    if (requestInFlight.current) return;
    const parsed = pdfV2RequestSchema.safeParse({
      version: 2, target: form.target, period: { mode: "DAY", date: form.date },
      service: form.service, room: form.room, order: form.order,
    });
    if (!parsed.success) {
      setPreviewError("Verifica la data, scegli Pranzo o Cena e seleziona il profilo PDF.");
      setInvalidFields(parsed.error.issues.map(issue => String(issue.path[0] === "period" ? "date" : issue.path[0])));
      return;
    }
    requestInFlight.current = true; setLoading("PDF_V2"); setPreviewError(null);
    const intent = { route: currentRoute(), abort: new AbortController(), stamp: undefined as PreviewStamp | undefined };
    activePdf.current = intent;
    const ownsIntent = () => activePdf.current === intent && currentRoute() === intent.route;
    try {
      const identity = await controller.verifySession();
      if (!ownsIntent()) return;
      if (!identity || !controller.sessionVisible() || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(identity.sessionBinding)) throw new Error("Verifica della sessione non disponibile. Nessun PDF scaricato; riprova.");
      const state = controller.getSnapshot().drafts;
      intent.stamp = { identity, epoch: state.authEpoch, lease: state.leaseEpoch, route: intent.route };
      if (!stampMatches(intent.stamp)) return;
      const response = await fetch("/api/staff/exports/pdf-v2", {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: intent.abort.signal,
        headers: { "Content-Type": "application/json", "X-Piccadilly-Draft-Session-Binding": identity.sessionBinding },
        body: JSON.stringify(parsed.data),
      });
      if (!ownsIntent() || !stampMatches(intent.stamp)) return;
      if (response.status === 401 || response.status === 403) {
        controller.quarantine(); cancelPdf();
        setPreviewError("Sessione non confermata. Nessun PDF scaricato; verifica l'accesso e riprova."); return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { code?: string } | null;
        if (!ownsIntent() || !stampMatches(intent.stamp)) return;
        throw new Error(body?.code === "EXPORT_TOO_LARGE" ? "La selezione supera i limiti tecnici consentiti."
          : body?.code === "EXPORT_DATA_INCONSISTENT" ? "I dati non sono coerenti. Contatta un amministratore."
          : "Non è stato possibile generare il PDF. Riprova.");
      }
      if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/pdf") throw new Error("Risposta PDF non valida. Riprova.");
      const blob = await response.blob();
      if (!ownsIntent() || !stampMatches(intent.stamp)) return;
      if (blob.size > 26_214_400 || blob.size < 5 || await blob.slice(0, 5).text() !== "%PDF-") throw new Error("Risposta PDF non valida. Riprova.");
      if (!ownsIntent() || !stampMatches(intent.stamp)) return;
      // A cookie can switch without a browser focus event while generation is pending.
      // Suspend our own dataset lease during this proof, retaining the original owner.
      intent.stamp = undefined;
      const confirmed = await controller.verifySession();
      if (!ownsIntent()) return;
      if (!confirmed || !sameDraftSession(identity, confirmed) || !controller.sessionVisible()) {
        controller.quarantine(); throw new Error("Sessione cambiata. Nessun PDF scaricato; verifica l'accesso e riprova.");
      }
      const finalState = controller.getSnapshot().drafts;
      intent.stamp = { identity: confirmed, epoch: finalState.authEpoch, lease: finalState.leaseEpoch, route: intent.route };
      if (!stampMatches(intent.stamp)) return;
      const objectUrl = URL.createObjectURL(blob);
      try {
        if (!ownsIntent() || !stampMatches(intent.stamp)) return;
        const anchor = document.createElement("a"); anchor.href = objectUrl;
        anchor.download = pdfV2Filename(parsed.data); anchor.hidden = true;
        document.body.append(anchor); anchor.click(); anchor.remove();
      } finally { URL.revokeObjectURL(objectUrl); }
    } catch (failure) {
      if (ownsIntent() && (!intent.stamp || stampMatches(intent.stamp))) {
        setPreviewError(failure instanceof Error && failure.name !== "AbortError" ? failure.message : "Download interrotto. Riprova.");
      }
    } finally {
      if (activePdf.current === intent) { activePdf.current = null; requestInFlight.current = false; setLoading(null); }
    }
  }
  async function loadPreview() {
    if (requestInFlight.current) return;
    const parsed = exportPreviewRequestSchema.safeParse({
      version: 2, target: form.target, period: { mode: "DAY", date: form.date },
      service: form.service, room: form.room, order: form.order,
    });
    if (!parsed.success) {
      setInvalidFields(parsed.error.issues.map(issue => String(issue.path[0] === "period" ? "date" : issue.path[0])));
      setPreviewError("Verifica la data e scegli esplicitamente Pranzo o Cena."); return;
    }
    cancelPreview(); setInvalidFields([]);
    requestInFlight.current = true; setLoading("PREVIEW"); setPreviewStatus("CHECKING_SESSION");
    const intent = { id: generation.current, route: currentRoute(), abort: new AbortController(), stamp: undefined as PreviewStamp | undefined };
    activePreview.current = intent;
    const ownsIntent = () => activePreview.current === intent && generation.current === intent.id && currentRoute() === intent.route;
    try {
      const identity = await controller.verifySession();
      if (!ownsIntent()) return;
      if (!identity || !controller.sessionVisible() || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(identity.sessionBinding)) throw new Error("Verifica della sessione non disponibile. Nessuna anteprima caricata; riprova.");
      const state = controller.getSnapshot().drafts;
      intent.stamp = { identity, epoch: state.authEpoch, lease: state.leaseEpoch, route: intent.route };
      if (!stampMatches(intent.stamp)) return;
      setPreviewStatus("LOADING");
      const response = await fetch("/api/staff/exports/preview", {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: intent.abort.signal,
        headers: { "Content-Type": "application/json", "X-Piccadilly-Draft-Session-Binding": identity.sessionBinding },
        body: JSON.stringify(parsed.data),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!ownsIntent() || !stampMatches(intent.stamp)) return;
      if (response.status === 401 || response.status === 403) {
        controller.quarantine(); cancelPreview(); setPreviewError("Sessione non confermata. I dati precedenti sono stati scartati; verifica l'accesso e riprova."); return;
      }
      if (!response.ok) {
        const code = body && typeof body === "object" && "code" in body ? body.code : null;
        throw new Error(code === "EXPORT_TOO_LARGE" ? "La selezione supera i limiti tecnici consentiti."
          : code === "EXPORT_DATA_INCONSISTENT" ? "I dati non sono coerenti. Contatta un amministratore."
          : "Non è stato possibile leggere l'anteprima. Riprova.");
      }
      const result = exportPreviewResponseSchema.safeParse(body);
      if (!result.success || JSON.stringify(result.data.selection) !== JSON.stringify(parsed.data)) throw new Error("Risposta di anteprima non valida. Riprova.");
      setPreview({ data: result.data, stamp: intent.stamp, generation: intent.id });
      setPreviewStatus(result.data.summary.reservationCount ? "READY" : "EMPTY");
    } catch (failure) {
      if (ownsIntent() && (!intent.stamp || stampMatches(intent.stamp))) {
        setPreviewStatus("ERROR");
        setPreviewError(failure instanceof Error && failure.name !== "AbortError" ? failure.message : "Anteprima interrotta. Riprova.");
      }
    } finally {
      if (activePreview.current === intent) { activePreview.current = null; requestInFlight.current = false; setLoading(null); }
    }
  }

  async function download(
    action: ExportAction,
    endpoint: string,
    payload: unknown,
    fallback: string,
  ) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(action);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(await responseError(response));
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = responseFilename(response, fallback);
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Non è stato possibile scaricare il file.",
      );
    } finally {
      requestInFlight.current = false;
      setLoading(null);
    }
  }

  const buttonClass =
    "min-h-11 rounded-xl bg-zinc-950 px-4 py-2.5 font-black text-white hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus:ring-4 focus:ring-orange-200";
  const inputClass =
    "mt-1 block min-h-11 w-full min-w-0 max-w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 focus:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-100";

  return (
    <section
      aria-labelledby="export-panel-title"
      className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
      data-testid="export-panel"
    >
      <p className="text-xs font-black tracking-widest text-orange-600 uppercase">
        Esportazioni operative
      </p>
      <h2 className="mt-1 text-xl font-black text-zinc-950" id="export-panel-title">
        PDF ed Excel
      </h2>
<section aria-labelledby="export-preview-title" className="mt-5 min-w-0 rounded-xl border border-orange-200 p-4" data-testid="export-preview-area" data-preview-state={previewStatus}>
        <h3 className="text-lg font-black" id="export-preview-title">Anteprima operativa</h3>
        <p className="mt-2 text-sm text-zinc-600">Anteprima dei dati operativi, non dell’impaginazione dei file. I download M11 sottostanti usano il contratto storico e non applicano questi filtri o questo ordinamento.</p>
        <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="min-w-0 text-sm font-bold" htmlFor="preview-date">Data anteprima
            <input id="preview-date" type="date" className={inputClass} value={form.date} aria-invalid={invalidFields.includes("date")} onChange={event => change("date", event.target.value)} />
          </label>
          <label className="min-w-0 text-sm font-bold" htmlFor="preview-service">Pranzo o cena per l’anteprima
            <select id="preview-service" className={inputClass} value={form.service} aria-invalid={invalidFields.includes("service")} onChange={event => change("service", event.target.value)}>
              <option value="">Scegli Pranzo o Cena</option><option value="LUNCH">Pranzo</option><option value="DINNER">Cena</option>
            </select>
          </label>
          <label className="min-w-0 text-sm font-bold" htmlFor="preview-room">Sala effettiva
            <select id="preview-room" className={inputClass} value={form.room} onChange={event => change("room", event.target.value as typeof form.room)}>
              <option value="ALL">TUTTO</option>
              {EXPORT_PREVIEW_ROOMS.filter(room => !room.legacy).map(room => <option key={room.key} value={room.key}>{room.label}</option>)}
              {EXPORT_PREVIEW_ROOMS.filter(room => room.legacy && (form.room === room.key || preview?.data.availableLegacyRooms.some(item => item.key === room.key))).map(room => <option key={room.key} value={room.key}>{room.label}</option>)}
            </select>
          </label>
          <label className="min-w-0 text-sm font-bold" htmlFor="preview-order">Ordina dentro ogni sala
            <select id="preview-order" className={inputClass} value={form.order} onChange={event => change("order", event.target.value as typeof form.order)}>
              <option value="CREATED_ASC">Creazione crescente</option><option value="NAME_ASC">Cognome/nome A–Z</option><option value="ARRIVAL_ASC">Ora di arrivo</option>
            </select>
          </label>
          <label className="min-w-0 text-sm font-bold" htmlFor="preview-target">Soglia della selezione
            <select id="preview-target" className={inputClass} value={form.target} onChange={event => change("target", event.target.value as typeof form.target)}>
              <option value="PDF">PDF — massimo 2.000 prenotazioni</option><option value="EXCEL">Excel — massimo 20.000 prenotazioni</option>
            </select>
          </label>
        </div>
        {form.date !== dashboardDate && <p className="mt-3 text-sm">La data Agenda è {dashboardDate}. <button type="button" className="min-h-11 rounded-lg px-3 font-bold underline focus:ring-4 focus:ring-orange-200" onClick={() => change("date", dashboardDate)}>Usa data Agenda</button></p>}
        <p className="mt-3 text-sm">Solo giorno e servizio scelti. Ricerca e altri filtri Agenda non restringono questa selezione. Excel V2 non è ancora disponibile.</p>
        <p className="mt-2 text-sm">Il PDF operativo applica la selezione corrente e rilegge i dati al momento della generazione. Può contenere modifiche successive all’anteprima. La colonna Tavolo resta libera per la scrittura a penna.</p>
        <button type="button" className={buttonClass + " mt-3"} disabled={loading !== null} aria-busy={loading === "PREVIEW"} onClick={() => void loadPreview()}>
          {loading === "PREVIEW" ? "Lettura anteprima…" : "Mostra anteprima"}
        </button>
        <button type="button" className={buttonClass + " mt-3 sm:ml-3"} disabled={loading !== null || form.target !== "PDF"} aria-busy={loading === "PDF_V2"} onClick={() => void downloadPdfV2()}>
          {loading === "PDF_V2" ? "Generazione PDF operativo…" : "Scarica PDF operativo"}
        </button>
        {form.target !== "PDF" && <p className="mt-2 text-sm">Seleziona il profilo PDF per scaricare il PDF operativo.</p>}
        {loading === "PDF_V2" && <p className="mt-2 text-sm" role="status">Verifica della sessione e generazione del PDF in corso…</p>}
        <p className="mt-2 text-sm" role="status">{previewStatus === "CHECKING_SESSION" ? "Verifica della sessione…" : previewStatus === "LOADING" ? "Lettura dei dati in corso…" : previewStatus === "STALE" ? "Selezione o autorizzazione cambiata: aggiorna l'anteprima." : ""}</p>
        {previewError && <div ref={errorSummary} id="preview-error-summary" tabIndex={-1} role="alert" className="mt-3 rounded-xl border border-red-300 bg-red-50 p-3 text-red-900">
          <p className="font-bold">{previewError}</p>
          {invalidFields.includes("date") && <a className="mr-3 underline" href="#preview-date">Verifica data</a>}
          {invalidFields.includes("service") && <a className="underline" href="#preview-service">Scegli servizio</a>}
        </div>}
        <StaffSensitiveRegion allowed={preview !== null && stampMatches(preview.stamp)}>
          {preview && <ExportPreview key={preview.generation} data={preview.data} />}
        </StaffSensitiveRegion>
      </section>
      <section aria-labelledby="legacy-export-title" data-testid="legacy-export-downloads" className="mt-6">
        <h3 id="legacy-export-title" className="text-lg font-black">Download attuali M11 — giornata completa o periodo</h3>
      <p className="mt-1 text-sm text-zinc-600">
        I file includono tutte le prenotazioni confermate, indipendentemente dagli altri filtri dashboard.
      </p>

      <div className="mt-4 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="flex min-w-0 flex-col justify-end rounded-xl bg-zinc-50 p-4">
          <p className="mb-2 text-sm font-bold text-zinc-700">
            Giornata dashboard: {dashboardDate}
          </p>
          <button
            className={buttonClass}
            disabled={loading !== null}
            onClick={() =>
              download(
                "PDF",
                "/api/staff/exports/pdf",
                { date: dashboardDate },
                `piccadilly-prenotazioni-${dashboardDate}.pdf`,
              )
            }
            type="button"
          >
            {loading === "PDF" ? "Generazione PDF…" : "PDF giornata completa"}
          </button>
        </div>

        <div className="flex min-w-0 flex-col justify-end rounded-xl bg-zinc-50 p-4">
          <p className="mb-2 text-sm font-bold text-zinc-700">
            Giornata dashboard: {dashboardDate}
          </p>
          <button
            className={buttonClass}
            disabled={loading !== null}
            onClick={() =>
              download(
                "DAY",
                "/api/staff/exports/excel",
                { mode: "DAY", date: dashboardDate },
                `piccadilly-prenotazioni-${dashboardDate}.xlsx`,
              )
            }
            type="button"
          >
            {loading === "DAY" ? "Generazione Excel…" : "Excel giorno"}
          </button>
        </div>

        <div className="min-w-0 rounded-xl bg-zinc-50 p-4">
          <label className="block min-w-0 text-sm font-bold text-zinc-700">
            Mese
            <input
              className={inputClass}
              disabled={loading !== null}
              onChange={(event) => setMonth(event.target.value)}
              type="month"
              value={month}
            />
          </label>
          <button
            className={`${buttonClass} mt-3 w-full`}
            disabled={loading !== null}
            onClick={() =>
              download(
                "MONTH",
                "/api/staff/exports/excel",
                { mode: "MONTH", month },
                `piccadilly-prenotazioni-${month}.xlsx`,
              )
            }
            type="button"
          >
            {loading === "MONTH" ? "Generazione Excel…" : "Excel mese"}
          </button>
        </div>

        <div className="min-w-0 rounded-xl bg-zinc-50 p-4">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <label className="block min-w-0 text-sm font-bold text-zinc-700">
              Data iniziale
              <input
                className={inputClass}
                disabled={loading !== null}
                onChange={(event) => setFromDate(event.target.value)}
                type="date"
                value={fromDate}
              />
            </label>
            <label className="block min-w-0 text-sm font-bold text-zinc-700">
              Data finale
              <input
                className={inputClass}
                disabled={loading !== null}
                onChange={(event) => setToDate(event.target.value)}
                type="date"
                value={toDate}
              />
            </label>
          </div>
          <button
            className={`${buttonClass} mt-3 w-full`}
            disabled={loading !== null}
            onClick={() =>
              download(
                "RANGE",
                "/api/staff/exports/excel",
                { mode: "RANGE", from: fromDate, to: toDate },
                `piccadilly-prenotazioni-${fromDate}_${toDate}.xlsx`,
              )
            }
            type="button"
          >
            {loading === "RANGE" ? "Generazione Excel…" : "Excel intervallo"}
          </button>
        </div>
      </div>

      {error ? (
        <p
          className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 font-bold text-red-800"
          data-testid="export-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      </section>
    </section>
  );
}
