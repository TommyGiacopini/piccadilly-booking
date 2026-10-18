import { isLocalDate } from "@/modules/configuration/domain/operational-time";
import { dashboardFiltersSchema, type DashboardFilters } from "./dashboard-domain";

export const AGENDA_CONTEXT_KEYS = ["date", "service", "status", "origin", "assignment", "finalRoom"] as const;
export interface AgendaLocation { date: string; filters: DashboardFilters }
export function parseAgendaLocation(params: URLSearchParams, fallbackDate: string): AgendaLocation {
  const values: Record<string, string> = {};
  for (const key of AGENDA_CONTEXT_KEYS) if (key !== "date" && params.getAll(key).length === 1) values[key] = params.get(key)!;
  const filters: DashboardFilters = dashboardFiltersSchema.parse({});
  for (const key of ["service", "status", "origin", "assignment", "finalRoom"] as const) {
    const parsed = dashboardFiltersSchema.shape[key].safeParse(values[key]);
    if (parsed.success) Object.assign(filters, { [key]: parsed.data });
  }
  const date = params.getAll("date").length === 1 ? params.get("date") : null;
  return { date: date && isLocalDate(date) ? date : fallbackDate, filters };
}
export function agendaHref(location: AgendaLocation): string {
  const params = new URLSearchParams({ date: location.date, ...location.filters });
  return `/dashboard?${params.toString()}`;
}
export function safeAgendaOrigin(value: string | null | undefined, fallbackDate: string): string {
  if (!value || !value.startsWith("/dashboard?") || value.includes("\\") || value.includes("#")) return agendaHref({ date: fallbackDate, filters: dashboardFiltersSchema.parse({}) });
  try { return agendaHref(parseAgendaLocation(new URL(value, "https://agenda.invalid").searchParams, fallbackDate)); }
  catch { return agendaHref({ date: fallbackDate, filters: dashboardFiltersSchema.parse({}) }); }
}
export function rescheduledAgendaHref(localDate: string, service: "LUNCH" | "DINNER"): string {
  return agendaHref({ date: localDate, filters: { ...dashboardFiltersSchema.parse({}), service } });
}
