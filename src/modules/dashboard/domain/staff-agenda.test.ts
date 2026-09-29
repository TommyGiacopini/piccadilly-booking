import { describe, expect, it } from "vitest";

import type { DashboardReservation } from "@/modules/dashboard/domain/dashboard-domain";
import {
  matchesAgendaSearch,
  normalizeAgendaPhone,
  normalizeAgendaText,
  selectStaffAgendaReservations,
} from "@/modules/dashboard/domain/staff-agenda";

function agendaReservation(
  overrides: Partial<DashboardReservation> = {},
): DashboardReservation {
  return {
    id: crypto.randomUUID(),
    version: 1,
    serviceType: "DINNER",
    arrivalTime: "19:00",
    partySize: 2,
    status: "CONFIRMED",
    origin: "PHONE",
    customerFirstName: "Mario",
    customerLastName: "Rossi",
    customerPhone: "+39 000 123 4567",
    customerEmail: null,
    preferredRoom: "Sala 1",
    highChair: false,
    stroller: false,
    accessibility: false,
    children: false,
    celiac: false,
    allergies: null,
    intolerances: null,
    celebration: null,
    animals: false,
    notes: null,
    overrideApplied: false,
    overrideReason: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    assignment: null,
    notificationHealth: null,
    ...overrides,
  };
}

describe("T02 Staff Agenda search and ordering", () => {
  it("normalizes case, surrounding whitespace, repeated whitespace and diacritics", () => {
    expect(normalizeAgendaText("  JOSÉ   De Àngelis ")).toBe("jose de angelis");
    expect(normalizeAgendaPhone("+39 (000) 123-45-67")).toBe("390001234567");
  });

  it("searches first name, surname and combined names without case or diacritics", () => {
    const row = agendaReservation({
      customerFirstName: "José",
      customerLastName: "De Àngelis",
    });

    expect(matchesAgendaSearch(row, "  jose ")).toBe(true);
    expect(matchesAgendaSearch(row, "DE ANGELIS")).toBe(true);
    expect(matchesAgendaSearch(row, "jose   de angelis")).toBe(true);
    expect(matchesAgendaSearch(row, "de angelis jose")).toBe(true);
    expect(matchesAgendaSearch(row, "Bianchi")).toBe(false);
  });

  it("matches formatted phone numbers by equivalent digits only", () => {
    const row = agendaReservation({ customerPhone: "+39 000 123 4567" });

    expect(matchesAgendaSearch(row, "0001234567")).toBe(true);
    expect(matchesAgendaSearch(row, "+39 (000) 123-45-67")).toBe(true);
    expect(matchesAgendaSearch(row, "0009999999")).toBe(false);
  });

  it("orders by oldest booking by default with the id as final tie-breaker", () => {
    const newer = agendaReservation({
      id: "00000000-0000-4000-8000-000000000003",
      createdAt: "2026-09-01T11:00:00.000Z",
    });
    const tiedLaterId = agendaReservation({
      id: "00000000-0000-4000-8000-000000000002",
      createdAt: "2026-09-01T09:00:00.000Z",
    });
    const tiedEarlierId = agendaReservation({
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: "2026-09-01T09:00:00.000Z",
    });

    expect(
      selectStaffAgendaReservations([newer, tiedLaterId, tiedEarlierId]).map(
        (row) => row.id,
      ),
    ).toEqual([tiedEarlierId.id, tiedLaterId.id, newer.id]);
  });

  it("orders deterministically by surname and first name", () => {
    const zeta = agendaReservation({
      id: "00000000-0000-4000-8000-000000000003",
      customerFirstName: "Anna",
      customerLastName: "Zeta",
    });
    const alberto = agendaReservation({
      id: "00000000-0000-4000-8000-000000000002",
      customerFirstName: "Alberto",
      customerLastName: "Àlfa",
    });
    const bianca = agendaReservation({
      id: "00000000-0000-4000-8000-000000000001",
      customerFirstName: "Bianca",
      customerLastName: "Alfa",
    });

    expect(
      selectStaffAgendaReservations([zeta, bianca, alberto], {
        order: "SURNAME",
      }).map((row) => row.customerFirstName),
    ).toEqual(["Alberto", "Bianca", "Anna"]);
    expect(
      selectStaffAgendaReservations([zeta, bianca, alberto], {
        order: "FIRST_NAME",
      }).map((row) => row.customerFirstName),
    ).toEqual(["Alberto", "Anna", "Bianca"]);
  });

  it("orders arrival times ascending and composes search with ordering", () => {
    const laterOld = agendaReservation({
      id: "00000000-0000-4000-8000-000000000001",
      arrivalTime: "20:00",
      customerLastName: "Rossi",
      createdAt: "2026-09-01T08:00:00.000Z",
    });
    const earlierNew = agendaReservation({
      id: "00000000-0000-4000-8000-000000000002",
      arrivalTime: "19:15",
      customerLastName: "Rossi",
      createdAt: "2026-09-01T09:00:00.000Z",
    });
    const excluded = agendaReservation({
      id: "00000000-0000-4000-8000-000000000003",
      arrivalTime: "19:00",
      customerLastName: "Bianchi",
    });

    expect(
      selectStaffAgendaReservations([laterOld, excluded, earlierNew], {
        query: "rossi",
        order: "ARRIVAL",
      }).map((row) => row.id),
    ).toEqual([earlierNew.id, laterOld.id]);
  });
});
