import { describe, expect, it } from "vitest";
import { buildExportPreview, type ExportPreviewReservation, type ExportPreviewSnapshot } from "@/modules/exports/domain/export-contract";
import { buildPdfV2Document, pdfV2Filename, pdfV2LocalInstant, pdfV2RequestSchema, type PdfV2Request } from "@/modules/exports/domain/pdf-v2-domain";

const selection: PdfV2Request = { version: 2, target: "PDF", period: { mode: "DAY", date: "2090-11-20" }, service: "DINNER", room: "ALL", order: "CREATED_ASC" };
function row(input: Partial<ExportPreviewReservation> = {}): ExportPreviewReservation {
  return { id: "a", localDate: selection.period.date, serviceType: "DINNER", arrivalTime: "19:15", customerFirstName: "Èlia", customerLastName: "Rossi",
    partySize: 4, childrenCount: 1, gameRoomPreference: true, legacyChildren: true, preferredRoom: "Non indicata",
    highChair: false, stroller: false, accessibility: false, celiac: false, allergies: null, intolerances: null,
    celebration: null, animals: false, notes: "NC integra +39000123", createdAt: new Date("2090-11-01T09:00:00Z"), assignment: null, ...input };
}
function document(rows: ExportPreviewReservation[], request = selection) {
  const snapshot: ExportPreviewSnapshot = { restaurantName: "Artificial Piccadilly", timezone: "Europe/Rome", reservations: rows,
    availableLegacyRooms: rows.some(item => item.assignment?.roomCode === "galleria") ? ["GALLERIA"] : [] };
  return buildPdfV2Document(buildExportPreview({ selection: request, snapshot, readAt: new Date("2090-11-20T12:30:00Z") }));
}

describe("T10 PDF V2 domain and positive document", () => {
  it.each(["LUNCH", "DINNER"])("accepts explicit service %s", service => {
    expect(pdfV2RequestSchema.safeParse({ ...selection, service }).success).toBe(true);
  });
  it.each([
    { ...selection, version: 1 }, { ...selection, target: "EXCEL" }, { ...selection, service: "ALL" },
    { ...selection, period: { mode: "MONTH", month: "2090-11" } }, { ...selection, period: { mode: "DAY", date: "2090-02-30" } },
    { ...selection, room: "sala-1" }, { ...selection, order: "RANDOM" }, { ...selection, rows: [] },
    { ...selection, period: { ...selection.period, extra: true } }, { ...selection, restaurantId: "forged" },
  ])("rejects invalid, legacy or client data %#", payload => expect(pdfV2RequestSchema.safeParse(payload).success).toBe(false));
  it("keeps the canonical four empty primary groups and selected empty legacy group", () => {
    expect(document([]).groups.map(group => group.key)).toEqual(["UNASSIGNED", "SALA_1", "SALA_2", "SALA_3"]);
    expect(document([], { ...selection, room: "TERRAZZO" }).groups.map(group => group.key)).toEqual(["TERRAZZO"]);
  });
  it.each(["CREATED_ASC", "NAME_ASC", "ARRIVAL_ASC"] as const)("uses the T09 order %s inside groups, with deterministic ties", order => {
    const rows = [row({ id: "b", customerLastName: "Zeta", arrivalTime: "19:00" }), row({ id: "a", customerLastName: "Alfa", arrivalTime: "20:00" }),
      row({ id: "c", customerLastName: "Gamma", assignment: { roomCode: "sala-1", roomName: "Sala 1", tables: [] } })];
    const result = document(rows, { ...selection, order });
    expect(result.groups[0].rows.map(item => item.name)).toEqual(order === "ARRIVAL_ASC" ? ["Èlia Zeta", "Èlia Alfa"] : ["Èlia Alfa", "Èlia Zeta"]);
    expect(result.groups[1].rows[0].name).toBe("Èlia Gamma");
    expect(document([...rows].reverse(), { ...selection, order })).toEqual(result);
  });
  it.each([
    { childrenCount: 0, gameRoomPreference: null, legacyChildren: true, expected: ["TA"], request: null },
    { childrenCount: 1, gameRoomPreference: true, legacyChildren: false, expected: ["3 A", "1 B"], request: "Giochi richiesti - non garantiti" },
    { childrenCount: 4, gameRoomPreference: false, legacyChildren: false, expected: ["0 A", "4 B"], request: "Giochi non richiesti" },
    { childrenCount: null, gameRoomPreference: null, legacyChildren: false, expected: ["A ?", "B ?"], request: "Composizione non specificata" },
    { childrenCount: null, gameRoomPreference: null, legacyChildren: true, expected: ["A ?", "B ?"], request: "Bambini segnalati senza conteggio" },
  ])("preserves composition state %#", ({ expected, request, ...input }) => {
    const item = document([row(input)]).groups[0].rows[0];
    expect(item.partySize).toBe(4); expect(item.composition).toEqual(expected);
    if (request) expect(item.requests).toContain(request);
    if (input.childrenCount === 0) expect(item.requests.join()).not.toContain("Bambini segnalati");
    expect(item.room).toBe("DA ASSEGNARE");
  });
  it("keeps totals partial and never promotes games or historical preference to assignment", () => {
    const result = document([row(), row({ id: "b", childrenCount: null, gameRoomPreference: null, preferredRoom: "Sala 3" })]);
    expect(result.summary).toMatchObject({ partySizeTotal: 8, knownAdultsTotal: 3, knownChildrenTotal: 1, unknownCompositionCount: 1 });
    expect(result.groups[0].rows[1].room).toBe("DA ASSEGNARE");
    expect(result.groups[0].rows[1].requests).toContain("Preferenza storica: Sala 3");
  });
  it("preserves actual room and NC while dropping digital tables and every extra runtime private property", () => {
    const source = row({ assignment: { roomCode: "galleria", roomName: "Galleria", tables: [{ id: "technical-table", name: "DIGITAL_TABLE_FORBIDDEN", displayOrder: 1 }] } });
    Object.assign(source, { privateNotes: "PRIVATE_FORBIDDEN", customerPhone: "PHONE_FORBIDDEN", customerEmail: "EMAIL_FORBIDDEN", sessionBinding: "BINDING_FORBIDDEN" });
    Object.assign(source.assignment!, { internalNotes: "LEGACY_FORBIDDEN" });
    const json = JSON.stringify(document([source]));
    for (const value of ["DIGITAL_TABLE_FORBIDDEN", "technical-table", "PRIVATE_FORBIDDEN", "PHONE_FORBIDDEN", "EMAIL_FORBIDDEN", "BINDING_FORBIDDEN", "LEGACY_FORBIDDEN"]) expect(json).not.toContain(value);
    expect(json).toContain("NC integra +39000123"); expect(json).toContain("Galleria — Area legacy");
    expect(document([source]).groups.at(-1)!.rows[0]).not.toHaveProperty("tableNames");
  });
  it("produces a deterministic ASCII selection filename without PII", () => {
    expect(pdfV2Filename(selection)).toBe("piccadilly-operativo-v2-2090-11-20-dinner-all-created-asc.pdf");
    expect(pdfV2Filename({ ...selection, room: "SALA_3", order: "NAME_ASC" })).toContain("sala-3-name-asc.pdf");
  });
  it("formats the reservation creation instant in the restaurant timezone including DST", () => {
    expect(pdfV2LocalInstant("2026-03-29T01:15:00Z", "Europe/Rome")).toEqual({ date: "29/03/2026", time: "03:15" });
    expect(pdfV2LocalInstant("2026-10-25T01:15:00Z", "Europe/Rome")).toEqual({ date: "25/10/2026", time: "02:15" });
  });
});
