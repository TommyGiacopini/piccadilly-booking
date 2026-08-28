"use client";

import { useRef, useState } from "react";

type ExportAction = "PDF" | "DAY" | "MONTH" | "RANGE";

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
  );
}
