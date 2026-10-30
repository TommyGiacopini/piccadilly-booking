import { describe, expect, it } from "vitest";
import {
  buildExportPreview, comparePreviewReservations, EXPORT_PREVIEW_ROOMS, ExportPreviewDataError,
  exportPreviewRequestSchema, exportPreviewResponseSchema, previewReservationLimit,
  type ExportPreviewRequest, type ExportPreviewReservation,
} from "@/modules/exports/domain/export-contract";

const request: ExportPreviewRequest = { version: 2, target: "PDF", period: { mode: "DAY", date: "2026-10-29" }, service: "DINNER", room: "ALL", order: "CREATED_ASC" };
const at = new Date("2026-10-29T12:00:00Z");
function row(overrides: Partial<ExportPreviewReservation> = {}): ExportPreviewReservation {
  return {
    id: "00000000-0000-4000-8000-000000000001", localDate: request.period.date, serviceType: "DINNER", arrivalTime: "19:00",
    customerFirstName: "Cliente", customerLastName: "Fittizio", partySize: 4, childrenCount: 1, gameRoomPreference: false,
    legacyChildren: false, preferredRoom: "Sala 3", highChair: false, stroller: false, accessibility: false, celiac: false,
    allergies: null, intolerances: null, celebration: null, animals: false, notes: "NC_T09", createdAt: at, assignment: null, ...overrides,
  };
}
function build(rows: ExportPreviewReservation[] = [], selection: ExportPreviewRequest = request, legacy: Array<"GALLERIA" | "TERRAZZO"> = []) {
  return buildExportPreview({ selection, snapshot: { restaurantName: "Artificiale", timezone: "Europe/Rome", reservations: rows, availableLegacyRooms: legacy }, readAt: at });
}
function assigned(code: string, overrides: Partial<ExportPreviewReservation> = {}) {
  return row({ assignment: { roomCode: code, roomName: "Legacy raw label", tables: [] }, ...overrides });
}

describe("T09 V2 request boundary", () => {
  it.each(["LUNCH", "DINNER"] as const)("accepts explicit service %s and preserves the selection", service => {
    expect(exportPreviewRequestSchema.parse({ ...request, service })).toEqual({ ...request, service });
  });
  it.each(EXPORT_PREVIEW_ROOMS.map(room => room.key))("accepts canonical room %s", room => {
    expect(exportPreviewRequestSchema.safeParse({ ...request, room }).success).toBe(true);
  });
  it.each(["CREATED_ASC", "NAME_ASC", "ARRIVAL_ASC"] as const)("accepts within-group ordering %s", order => {
    expect(exportPreviewRequestSchema.safeParse({ ...request, order }).success).toBe(true);
  });
  it.each([
    { ...request, version: 1 }, { ...request, service: "ALL" }, { ...request, service: "" },
    { ...request, service: undefined }, { ...request, period: { mode: "MONTH", month: "2026-10" } },
    { ...request, period: { mode: "RANGE", from: "2026-10-01", to: "2026-10-02" } },
    { ...request, period: { mode: "DAY", date: "2026-02-29" } },
    { ...request, period: { mode: "DAY", date: "2026-10-29", tenantId: "never" } },
    { ...request, tenantId: "never" }, { ...request, actorId: "never" },
    { ...request, sessionBinding: "never" }, { ...request, room: "OTHER" },
    { ...request, order: "RANDOM" }, { ...request, target: "HTML" },
  ])("rejects missing, non-operational or extra fields %#", value => {
    expect(exportPreviewRequestSchema.safeParse(value).success).toBe(false);
  });
  it("preserves the canonical PDF and Excel thresholds", () => {
    expect(previewReservationLimit("PDF")).toBe(2000); expect(previewReservationLimit("EXCEL")).toBe(20000);
  });
});

describe("T09 grouping, composition and positive projection", () => {
  it("retains the four primary groups for an empty ALL selection", () => {
    const dto = build();
    expect(dto.groups.map(group => group.key)).toEqual(["UNASSIGNED", "SALA_1", "SALA_2", "SALA_3"]);
    expect(dto.summary).toEqual({ reservationCount: 0, partySizeTotal: 0, knownCompositionCount: 0, unknownCompositionCount: 0, knownAdultsTotal: 0, knownChildrenTotal: 0 });
    expect(exportPreviewResponseSchema.safeParse(dto).success).toBe(true);
  });
  it("orders rooms canonically and sorts only within each room", () => {
    const early = row({ id: "first", customerLastName: "Zulu", createdAt: new Date("2026-10-01Z") });
    const late = assigned("sala-1", { id: "late", customerLastName: "Alpha", createdAt: new Date("2026-10-10Z") });
    const older = assigned("sala-1", { id: "older", customerLastName: "Beta", createdAt: new Date("2026-10-02Z") });
    const dto = build([late, early, older, assigned("terrazzo"), assigned("galleria")], request, ["TERRAZZO", "GALLERIA"]);
    expect(dto.groups.map(group => group.key)).toEqual(EXPORT_PREVIEW_ROOMS.map(room => room.key));
    expect(dto.groups[1].rows.map(item => item.customerLastName)).toEqual(["Beta", "Alpha"]);
    expect(dto.groups[0].rows[0].customerLastName).toBe("Zulu");
    const names = build([late, early, older], { ...request, order: "NAME_ASC" });
    expect(names.groups[1].rows.map(item => item.customerLastName)).toEqual(["Alpha", "Beta"]);
    expect(names.groups[0].rows[0].customerLastName).toBe("Zulu");
  });
  it("uses UUID and creation tie-breakers independent of input order", () => {
    const a = row({ id: "a", arrivalTime: "19:30" }), b = row({ id: "b", arrivalTime: "19:00" });
    expect(build([b, a]).groups[0].rows.map(item => item.ordinal)).toEqual([1, 2]);
    expect(comparePreviewReservations(a, b, "CREATED_ASC")).toBeLessThan(0);
    expect(comparePreviewReservations(a, b, "ARRIVAL_ASC")).toBeGreaterThan(0);
    expect(comparePreviewReservations(a, b, "NAME_ASC")).toBeLessThan(0);
    const accented = row({ id: "c", customerLastName: "Élite" }), plain = row({ id: "d", customerLastName: "Elite" });
    expect(Math.sign(comparePreviewReservations(accented, plain, "NAME_ASC"))).toBe(-Math.sign(comparePreviewReservations(plain, accented, "NAME_ASC")));
  });
  it.each(EXPORT_PREVIEW_ROOMS)("returns only a selected room, including empty legacy rooms: $key", room => {
    const dto = build([], { ...request, room: room.key });
    expect(dto.groups).toHaveLength(1); expect(dto.groups[0].key).toBe(room.key);
  });
  it("keeps unknown separate from zero, preserves legacy flags and derives adults only when known", () => {
    const dto = build([
      row({ childrenCount: 0, gameRoomPreference: null }),
      row({ childrenCount: null, gameRoomPreference: null, legacyChildren: true, id: "unknown" }),
      row({ childrenCount: 2, gameRoomPreference: true, id: "children" }),
    ]);
    expect(dto.summary).toEqual({ reservationCount: 3, partySizeTotal: 12, knownCompositionCount: 2, unknownCompositionCount: 1, knownAdultsTotal: 6, knownChildrenTotal: 2 });
    expect(dto.groups[0].rows.find(item => item.childrenCount === null)).toMatchObject({ adultsCount: null, legacyChildren: true, gameRoomPreference: null });
    expect(dto.groups[0].rows.find(item => item.childrenCount === 0)).toMatchObject({ adultsCount: 4 });
  });
  it("never treats games or a room preference as an assignment", () => {
    const projected = build([row({ gameRoomPreference: true })]).groups[0].rows[0];
    expect(projected.assignmentState).toBe("UNASSIGNED"); expect(projected.actualRoom).toBeNull();
    expect(projected.preferredRoom).toBe("Sala 3"); expect(projected.gameRoomPreference).toBe(true);
    expect(build([assigned("sala-2")]).groups[2].rows[0].assignmentState).toBe("ROOM_ONLY");
  });
  it("reprojects every row and assignment positively and omits all runtime NI, phone and IDs", () => {
    const input = assigned("sala-1", { notes: "NC_T09_ALLOWED" });
    Object.assign(input, { privateNotes: "NI_AUTONOMOUS", customerPhone: "PHONE_FORBIDDEN", customerEmail: "EMAIL_FORBIDDEN", legacyAssignment: { internalNotes: "NI_CLEARED" } });
    Object.assign(input.assignment!, { internalNotes: "NI_ACTIVE" });
    input.assignment!.tables.push(Object.assign({ id: "TABLE_ID_FORBIDDEN", name: "Tavolo 1", displayOrder: 1 }, { privateNotes: "NI_TABLE" }));
    const dto = build([input]), json = JSON.stringify(dto);
    for (const marker of ["NI_AUTONOMOUS", "NI_CLEARED", "NI_ACTIVE", "NI_TABLE", "PHONE_FORBIDDEN", "EMAIL_FORBIDDEN", "TABLE_ID_FORBIDDEN", input.id]) expect(json).not.toContain(marker);
    expect(json).toContain("NC_T09_ALLOWED"); expect(json).toContain("Tavolo 1");
    expect(exportPreviewResponseSchema.safeParse({ ...dto, privateNotes: "extra" }).success).toBe(false);
  });
  it.each([
    row({ childrenCount: -1 }), row({ childrenCount: 5 }), row({ childrenCount: 0, gameRoomPreference: true }),
    row({ childrenCount: null }), assigned("unknown-room"), row({ localDate: "2026-10-30" }),
    row({ serviceType: "LUNCH" }), row({ createdAt: new Date("invalid") }),
  ])("fails closed instead of silently repairing inconsistent input %#", invalid => {
    expect(() => build([invalid])).toThrow(ExportPreviewDataError);
  });
  it("fails instead of silently losing a legacy row when its presence context is inconsistent", () => {
    expect(() => build([assigned("galleria")])).toThrow(ExportPreviewDataError);
  });
});

