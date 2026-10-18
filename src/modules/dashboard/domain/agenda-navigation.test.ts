import { describe, expect, it } from "vitest";
import { AGENDA_CONTEXT_KEYS, agendaHref, parseAgendaLocation, rescheduledAgendaHref, safeAgendaOrigin } from "./agenda-navigation";
describe("T06-B safe Agenda origin separated from private volatile UI context", () => {
  it("round-trips date plus five filters, without free search or PII", () => {
    const params = new URLSearchParams({ date: "2099-12-10", service: "LUNCH", status: "CANCELLED", origin: "PHONE", assignment: "ASSIGNED", finalRoom: "sala-3", q: "PRIVATE_SEARCH_MARKER", notes: "PRIVATE_NOTE_MARKER" });
    const path = agendaHref(parseAgendaLocation(params, "2099-12-11"));
    expect([...new URL(path, "https://local.invalid").searchParams.keys()]).toEqual([...AGENDA_CONTEXT_KEYS]);
    expect(path).not.toContain("PRIVATE");
    expect(path).toContain("date=2099-12-10&service=LUNCH");
  });
  it("falls back on duplicated date/filter and invalid enum", () => {
    const parsed = parseAgendaLocation(new URLSearchParams("date=2099-12-10&date=2099-12-11&service=LUNCH&service=DINNER&status=invalid"), "2099-12-12");
    expect(parsed.date).toBe("2099-12-12"); expect(parsed.filters.service).toBe("ALL"); expect(parsed.filters.status).toBe("ALL");
  });
  it.each(["https://attacker.example", "//attacker.example", "javascript:alert(1)", "/dashboard/other?date=2099-12-10", "/dashboard?date=2099-12-10#x", "/dashboard?x=\\attacker", null])("does not accept an arbitrary return URL", value => {
    expect(safeAgendaOrigin(value, "2099-12-12")).toMatch(/^\/dashboard\?date=2099-12-12&service=ALL/u);
  });
  it("neutralizes secondary filters for the explicit reschedule destination", () => {
    expect(rescheduledAgendaHref("2099-12-15", "LUNCH")).toBe("/dashboard?date=2099-12-15&service=LUNCH&status=ALL&origin=ALL&assignment=ALL&finalRoom=ALL");
  });
});
