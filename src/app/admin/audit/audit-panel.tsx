"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { buttonClassName, fieldClassName } from "@/app/admin/_components/configuration-shell";
import type { AuditDetailDto, AuditDetailFieldDto, AuditListItemDto } from "@/modules/audit/domain/audit-projection";

interface AuditPageResponse {
  items: AuditListItemDto[];
  nextCursor: string | null;
  error?: string;
}

const categories = ["RESERVATION", "AUTHENTICATION", "IDENTITY", "CONFIGURATION"] as const;
const outcomes = ["SUCCESS", "FAILURE", "BLOCKED"] as const;
const actions = [
  "CREATED", "UPDATED", "CANCELLED", "LOGIN_SUCCEEDED", "LOGIN_FAILED",
  "LOGIN_RATE_LIMITED", "LOGOUT_SUCCEEDED", "USER_CREATED", "USER_ROLE_CHANGED",
  "USER_ENABLED", "USER_DISABLED", "USER_PASSWORD_RESET", "PASSWORD_CHANGED",
  "BOOKING_SETTINGS_UPDATED", "ROOM_UPDATED", "ROOM_AVAILABILITY_UPDATED",
  "ROOM_DISABLED", "ROOM_ENABLED", "ROOM_ORDER_UPDATED", "DINING_TABLE_CREATED",
  "DINING_TABLE_UPDATED", "DINING_TABLE_DISABLED", "DINING_TABLE_ENABLED",
  "WEEKLY_SCHEDULE_UPDATED", "PUBLIC_BOOKING_CUTOFF_RULE_CREATED",
  "PUBLIC_BOOKING_CUTOFF_RULE_UPDATED", "PUBLIC_BOOKING_CUTOFF_RULE_DISABLED",
  "SPECIAL_DATE_CREATED", "SPECIAL_DATE_UPDATED", "SPECIAL_DATE_ARCHIVED",
  "SPECIAL_DATE_REACTIVATED", "PUBLIC_CONTACTS_UPDATED", "PUBLIC_CONTENT_UPDATED",
  "MANAGEMENT_LINK_DURATION_UPDATED",
] as const;
const entityTypes = [
  "RESERVATION", "USER", "ROOM", "DINING_TABLE", "WEEKLY_SERVICE_SCHEDULE",
  "RESTAURANT_BOOKING_SETTINGS", "SPECIAL_DATE_OVERRIDE", "BOOKING_CUTOFF_RULE",
  "SERVICE_ROOM_AVAILABILITY", "RestaurantPublicSettings",
  "RestaurantBookingSettings", "Restaurant",
] as const;

const actorLabels = {
  USER: "Utente",
  PUBLIC: "Cliente pubblico",
  ANONYMOUS: "Anonimo",
  SYSTEM: "Sistema",
} as const;

function localTimestamp(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("it-IT", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: timezone,
  }).format(new Date(value));
}

function actorLabel(item: AuditListItemDto): string {
  if (item.actorKind === "USER") {
    return `${item.actorDisplayName ?? "Utente non disponibile"}${item.actorRole ? ` · ${item.actorRole}` : ""}`;
  }
  return actorLabels[item.actorKind];
}

function DetailFields({ fields, title }: { fields: AuditDetailFieldDto[]; title: string }) {
  return (
    <section>
      <h3 className="text-sm font-black text-zinc-950">{title}</h3>
      {fields.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">Nessun dato minimizzato disponibile.</p>
      ) : (
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">
          {fields.map((field) => (
            <div className="min-w-0 rounded-xl bg-zinc-50 p-3" key={field.key}>
              <dt className="text-xs font-bold tracking-wide text-zinc-500 uppercase">{field.label}</dt>
              <dd className="mt-1 break-words text-sm font-semibold text-zinc-900">{String(field.value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function AuditPanel({
  initialPage,
  timezone,
}: {
  initialPage: AuditPageResponse;
  timezone: string;
}) {
  const [items, setItems] = useState<AuditListItemDto[]>(initialPage.items);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage.nextCursor);
  const [activeQuery, setActiveQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const returnFocus = useRef<HTMLButtonElement | null>(null);

  const loadPage = useCallback(async (query: string, append: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/audit${query ? `?${query}` : ""}`, { cache: "no-store" });
      const result = (await response.json()) as AuditPageResponse;
      if (!response.ok) throw new Error(result.error ?? "Consultazione non riuscita.");
      setItems((current) => append ? [...current, ...result.items] : result.items);
      setNextCursor(result.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Consultazione non riuscita.");
    } finally {
      setLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setDetail(null);
    window.setTimeout(() => returnFocus.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!detail) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [closeDetail, detail]);

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const [key, value] of form.entries()) {
      const normalized = String(value).trim();
      if (normalized) params.set(key, normalized);
    }
    const query = params.toString();
    setActiveQuery(query);
    void loadPage(query, false);
  }

  function loadMore() {
    if (!nextCursor) return;
    const params = new URLSearchParams(activeQuery);
    params.set("cursor", nextCursor);
    void loadPage(params.toString(), true);
  }

  async function openDetail(item: AuditListItemDto, button: HTMLButtonElement) {
    returnFocus.current = button;
    setDetailLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/audit/${item.source}/${item.eventId}`, { cache: "no-store" });
      const result = (await response.json()) as { event?: AuditDetailDto; error?: string };
      if (!response.ok || !result.event) throw new Error(result.error ?? "Dettaglio non disponibile.");
      setDetail(result.event);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dettaglio non disponibile.");
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <form className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-7" onSubmit={submitFilters}>
        <h2 className="text-xl font-black">Filtri server-side</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-sm font-bold">Dal giorno<input className={fieldClassName} name="from" type="date" /></label>
          <label className="text-sm font-bold">Al giorno<input className={fieldClassName} name="to" type="date" /></label>
          <label className="text-sm font-bold">Sorgente<select aria-label="Sorgente" className={fieldClassName} name="source"><option value="">Tutte</option><option value="RESERVATION">Prenotazioni</option><option value="ADMINISTRATIVE">Amministrativo</option></select></label>
          <label className="text-sm font-bold">Categoria<select aria-label="Categoria" className={fieldClassName} name="category"><option value="">Tutte</option>{categories.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="text-sm font-bold">Azione<select aria-label="Azione" className={fieldClassName} name="action"><option value="">Tutte</option>{actions.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="text-sm font-bold">Esito<select aria-label="Esito" className={fieldClassName} name="outcome"><option value="">Tutti</option>{outcomes.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="text-sm font-bold">Attore<input className={fieldClassName} name="actor" placeholder="UUID, PUBLIC, ANONYMOUS o SYSTEM" /></label>
          <label className="text-sm font-bold">Tipo entità<select aria-label="Tipo entità" className={fieldClassName} name="entityType"><option value="">Tutti</option>{entityTypes.map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="text-sm font-bold">ID entità<input className={fieldClassName} name="entityId" placeholder="UUID esatto" /></label>
          <label className="text-sm font-bold">Correlation ID<input className={fieldClassName} name="correlationId" placeholder="UUID esatto" /></label>
          <label className="text-sm font-bold">Risultati<select aria-label="Risultati" className={fieldClassName} defaultValue="25" name="limit"><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label>
        </div>
        <button className={`${buttonClassName} mt-5`} disabled={loading} type="submit">Applica filtri</button>
      </form>

      {error ? <p className="rounded-2xl bg-red-50 p-4 font-bold text-red-800" role="alert">{error}</p> : null}

      <section aria-busy={loading} aria-live="polite">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-xl font-black">Eventi cronologici</h2>
          {loading ? <span className="text-sm text-zinc-500">Caricamento…</span> : null}
        </div>
        {!loading && items.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-zinc-600">Nessun evento per i filtri selezionati.</p>
        ) : (
          <ol className="mt-4 space-y-3">
            {items.map((item) => (
              <li className="min-w-0 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5" data-event-id={item.eventId} key={`${item.source}-${item.eventId}`}>
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs font-bold tracking-wide text-orange-700 uppercase">{item.source} · {item.category} · {item.outcome}</p>
                    <h3 className="mt-1 break-words font-black text-zinc-950">{item.summary}</h3>
                    <p className="mt-1 text-sm text-zinc-600">{localTimestamp(item.occurredAt, timezone)} · {actorLabel(item)}</p>
                    {item.entityType ? <p className="mt-1 break-all text-xs text-zinc-500">{item.entityType}{item.entityId ? ` · ${item.entityId}` : ""}</p> : null}
                  </div>
                  <button className="shrink-0 rounded-xl border border-zinc-300 px-4 py-2 text-sm font-bold hover:border-orange-500 focus:outline-none focus:ring-4 focus:ring-orange-100" disabled={detailLoading} onClick={(event) => void openDetail(item, event.currentTarget)} type="button">Dettaglio</button>
                </div>
              </li>
            ))}
          </ol>
        )}
        {nextCursor ? <button className={`${buttonClassName} mt-5`} disabled={loading} onClick={loadMore} type="button">Carica altri eventi</button> : null}
      </section>

      {detail ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-zinc-950/60 p-3 sm:items-center sm:p-6" onMouseDown={(event) => { if (event.currentTarget === event.target) closeDetail(); }}>
          <section aria-labelledby="audit-detail-title" aria-modal="true" className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl sm:p-8" role="dialog">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0"><p className="text-xs font-bold text-orange-700 uppercase">{detail.source} · {detail.category}</p><h2 className="mt-1 text-2xl font-black" id="audit-detail-title">{detail.summary}</h2></div>
              <button autoFocus className="rounded-xl border border-zinc-300 px-3 py-2 text-sm font-bold" onClick={closeDetail} type="button">Chiudi</button>
            </div>
            <dl className="mt-5 grid gap-3 rounded-2xl bg-zinc-950 p-4 text-sm text-white sm:grid-cols-2">
              <div><dt className="text-zinc-400">Ora locale</dt><dd className="mt-1 font-bold">{localTimestamp(detail.occurredAt, timezone)}</dd></div>
              <div><dt className="text-zinc-400">UTC</dt><dd className="mt-1 break-all font-bold">{detail.occurredAt}</dd></div>
              <div><dt className="text-zinc-400">Azione / esito</dt><dd className="mt-1 font-bold">{detail.action} · {detail.outcome}</dd></div>
              <div><dt className="text-zinc-400">Attore</dt><dd className="mt-1 font-bold">{actorLabel(detail)}</dd></div>
              <div><dt className="text-zinc-400">Entità</dt><dd className="mt-1 break-all font-bold">{detail.entityType ?? "—"}{detail.entityId ? ` · ${detail.entityId}` : ""}</dd></div>
              <div><dt className="text-zinc-400">Correlation ID</dt><dd className="mt-1 break-all font-bold">{detail.correlationId}</dd></div>
            </dl>
            <div className="mt-6 space-y-6"><DetailFields fields={detail.previousState} title="Stato precedente" /><DetailFields fields={detail.newState} title="Stato nuovo" /><DetailFields fields={detail.metadata} title="Metadata" /></div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
