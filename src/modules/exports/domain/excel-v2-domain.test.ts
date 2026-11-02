import { describe, expect, it } from "vitest";
import { buildExportPreview, type ExportPreviewReservation } from "@/modules/exports/domain/export-contract";
import { buildExcelV2Document, excelV2Filename, excelV2RequestSchema, EXCEL_V2_HEADERS, type ExcelV2Request } from "@/modules/exports/domain/excel-v2-domain";

const selection: ExcelV2Request = { version: 2, target: "EXCEL", period: { mode: "DAY", date: "2026-10-31" }, service: "DINNER", room: "ALL", order: "CREATED_ASC" };
function row(overrides: Partial<ExportPreviewReservation> = {}): ExportPreviewReservation {
  return { id: "1", localDate: selection.period.date, serviceType: "DINNER", arrivalTime: "19:00", customerFirstName: "Anna", customerLastName: "Rossi", partySize: 4,
    childrenCount: null, gameRoomPreference: null, legacyChildren: false, preferredRoom: "Storica libera", highChair: true, stroller: false,
    accessibility: false, celiac: false, allergies: "NC allergie", intolerances: null, celebration: null, animals: false, notes: "NC telefono libero 000 tavolo 1", createdAt: new Date("2026-10-01T10:00:00Z"), assignment: null, ...overrides };
}
function document(rows: ExportPreviewReservation[], order: ExcelV2Request["order"] = "CREATED_ASC") {
  return buildExcelV2Document(buildExportPreview({ selection: { ...selection, order }, snapshot: { restaurantName: "Synthetic", timezone: "Europe/Rome", availableLegacyRooms: [], reservations: rows }, readAt: new Date("2026-10-31T10:00:00Z") }));
}
describe("T11 positive Excel domain", () => {
  it("has exactly fourteen ratified columns and a deterministic ASCII filename", () => {
    expect(EXCEL_V2_HEADERS).toHaveLength(14); expect(EXCEL_V2_HEADERS[10]).toBe("Preferenza sala (storica)");
    expect(excelV2Filename(selection)).toBe("piccadilly-operativo-v2-2026-10-31-dinner-all-created-asc.xlsx");
  });
  it.each([{ ...selection, target: "PDF" }, { ...selection, tenant: "x" }, { ...selection, rows: [] }, { ...selection, period: { mode: "MONTH", month: "2026-10" } }, { ...selection, period: { mode: "DAY", date: "2026-02-30" } }, { ...selection, service: "ALL" }, { ...selection, filename: "x" }])("rejects noncanonical request %#", value => expect(excelV2RequestSchema.safeParse(value).success).toBe(false));
  it.each([[0, null, 4, "TA"], [1, true, 3, "DECLARED"], [null, null, null, "UNKNOWN — composizione non dichiarata"]] as const)("preserves composition %s", (childrenCount, gameRoomPreference, adultsCount, composition) => {
    const r = document([row({ childrenCount, gameRoomPreference })]).rows[0]; expect(r).toMatchObject({ childrenCount, adultsCount, composition });
  });
  it("preserves legacy unknown and distinguishes requested games from actual room", () => {
    expect(document([row({ legacyChildren: true })]).rows[0]).toMatchObject({ adultsCount: null, childrenCount: null, composition: "UNKNOWN — bambini segnalati senza conteggio", room: "DA ASSEGNARE" });
    expect(document([row({ childrenCount: 1, gameRoomPreference: true })]).rows[0]).toMatchObject({ room: "DA ASSEGNARE", games: "Richiesti — non garantiti" });
  });
  it("copies only positive fields, excluding tables and runtime extras while preserving NC and K", () => {
    const input = { ...row(), customerPhone: "PHONE_FORBIDDEN", privateNotes: "NI_FORBIDDEN", email: "EMAIL_FORBIDDEN", assignment: { roomCode: "sala-1", roomName: "Sala 1", tables: [{ id: "TABLE_ID_FORBIDDEN", name: "TABLE_FORBIDDEN", displayOrder: 1 }] } };
    const d = document([input]); const json = JSON.stringify(d);
    for (const marker of ["PHONE_FORBIDDEN", "NI_FORBIDDEN", "EMAIL_FORBIDDEN", "TABLE_FORBIDDEN", "tableNames", "assignmentState"]) expect(json).not.toContain(marker);
    expect(d.rows[0].preferredRoom).toBe("Storica libera"); expect(d.rows[0].requests).not.toContain("Storica libera"); expect(d.rows[0].notes).toBe(input.notes);
  });
  it.each(["CREATED_ASC", "NAME_ASC", "ARRIVAL_ASC"] as const)("keeps T09 groups and ordinal sequence for %s", order => {
    const rows = [row({ id: "a", customerLastName: "Z", assignment: { roomCode: "sala-2", roomName: "Sala 2", tables: [] } }), row({ id: "b", customerLastName: "A" }), row({ id: "c", customerLastName: "C", assignment: { roomCode: "sala-1", roomName: "Sala 1", tables: [] } })];
    const d = document(rows, order); expect(d.rows.map(r => r.ordinal)).toEqual([1, 2, 3]); expect(d.rows.map(r => r.lastName)).toEqual(["A", "C", "Z"]);
  });
});
