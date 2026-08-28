import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EXCEL_EXPORT_HEADERS,
} from "@/modules/exports/infrastructure/exceljs-export-renderer";
import {
  EXPORT_SECTION_DEFINITIONS,
  buildExportDays,
  compareExportTables,
  excelExportFilename,
  excelExportRequestSchema,
  exportFailureAuditMetadata,
  exportSuccessAuditMetadata,
  exportWorksheetName,
  pdfExportFilename,
  pdfExportRequestSchema,
  resolveExcelExportPeriod,
  sanitizeSpreadsheetString,
  type ExportReservationDto,
} from "@/modules/exports/domain/export-domain";

function reservation(
  input: Partial<ExportReservationDto> = {},
): ExportReservationDto {
  return {
    id: randomUUID(),
    localDate: "2026-08-24",
    serviceType: "DINNER",
    arrivalTime: "19:00",
    customerFirstName: "Mario",
    customerLastName: "Rossi",
    partySize: 2,
    customerPhone: "+39000000000",
    origin: "PHONE",
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
    createdAt: new Date("2026-08-01T10:00:00.000Z"),
    assignment: null,
    ...input,
  };
}

describe("M11 export request validation", () => {
  it("accepts strict PDF, DAY, MONTH and RANGE contracts", () => {
    expect(pdfExportRequestSchema.parse({ date: "2026-08-24" })).toEqual({
      date: "2026-08-24",
    });
    expect(
      excelExportRequestSchema.parse({ mode: "DAY", date: "2026-08-24" }),
    ).toBeTruthy();
    expect(
      excelExportRequestSchema.parse({ mode: "MONTH", month: "2026-08" }),
    ).toBeTruthy();
    expect(
      excelExportRequestSchema.parse({
        mode: "RANGE",
        from: "2026-08-01",
        to: "2026-08-31",
      }),
    ).toBeTruthy();
  });

  it.each([
    { date: "2026-02-30" },
    { date: "2026-08-24", extra: true },
  ])("rejects invalid or extra PDF fields", (payload) => {
    expect(pdfExportRequestSchema.safeParse(payload).success).toBe(false);
  });

  it.each([
    { mode: "DAY", date: "2025-02-29" },
    { mode: "MONTH", month: "2026-13" },
    { mode: "RANGE", from: "2026-08-02", to: "2026-08-01" },
    { mode: "DAY", date: "2026-08-24", restaurantId: randomUUID() },
  ])("rejects malformed Excel requests", (payload) => {
    expect(excelExportRequestSchema.safeParse(payload).success).toBe(false);
  });

  it.each([
    ["2026-02", 28],
    ["2024-02", 29],
    ["2026-04", 30],
    ["2026-08", 31],
  ])("enumerates calendar month %s without DST drift", (month, expected) => {
    const request = excelExportRequestSchema.parse({ mode: "MONTH", month });
    const period = resolveExcelExportPeriod(request);
    expect(period.dayCount).toBe(expected);
    expect(period.dates).toHaveLength(expected);
  });

  it("distinguishes inclusive 1, 31 and 32 day ranges", () => {
    for (const [to, expected] of [
      ["2026-08-01", 1],
      ["2026-08-31", 31],
      ["2026-09-01", 32],
    ] as const) {
      const request = excelExportRequestSchema.parse({
        mode: "RANGE",
        from: "2026-08-01",
        to,
      });
      expect(resolveExcelExportPeriod(request).dayCount).toBe(expected);
    }
  });
});

describe("M11 canonical export projection", () => {
  it("always produces the six canonical sections in order, including empty ones", () => {
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    const sameInstant = new Date("2026-08-01T10:00:00.000Z");
    const days = buildExportDays(
      ["2026-08-24"],
      [
        reservation({ id: secondId, createdAt: sameInstant }),
        reservation({
          id: firstId,
          createdAt: sameInstant,
          assignment: {
            roomCode: "sala-1",
            roomName: "Sala 1",
            tables: [],
            internalNotes: null,
          },
        }),
      ],
    );
    expect(days[0]?.sections.map((section) => section.label)).toEqual(
      EXPORT_SECTION_DEFINITIONS.map((section) => section.label),
    );
    expect(days[0]?.sections).toHaveLength(6);
    expect(days[0]?.sections[0]?.reservations.map((item) => item.id)).toEqual([
      secondId,
    ]);
    expect(days[0]?.sections[1]?.reservations.map((item) => item.id)).toEqual([
      firstId,
    ]);
  });

  it("sorts reservations by createdAt then UUID and tables by order, Italian name, UUID", () => {
    const ids = [
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    ];
    const days = buildExportDays(
      ["2026-08-24"],
      [
        reservation({ id: ids[0], createdAt: new Date("2026-08-01T11:00:00Z") }),
        reservation({ id: ids[1], createdAt: new Date("2026-08-01T10:00:00Z") }),
        reservation({ id: ids[2], createdAt: new Date("2026-08-01T10:00:00Z") }),
      ],
    );
    expect(days[0]?.sections[0]?.reservations.map((item) => item.id)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ]);
    const tables = [
      { id: ids[0], name: "Èlite", displayOrder: 2 },
      { id: ids[1], name: "Zeta", displayOrder: 1 },
      { id: ids[2], name: "Alfa", displayOrder: 1 },
    ].sort(compareExportTables);
    expect(tables.map((table) => table.name)).toEqual(["Alfa", "Zeta", "Èlite"]);
  });

  it("classifies absent/cleared sources as unassigned and keeps active grandfathered assignments", () => {
    const unassigned = reservation();
    const grandfathered = reservation({
      assignment: {
        roomCode: "terrazzo",
        roomName: "Terrazzo",
        tables: [{ id: randomUUID(), name: "T 1", displayOrder: 1 }],
        internalNotes: "Riferimento storico attivo",
      },
    });
    const day = buildExportDays(["2026-08-24"], [unassigned, grandfathered])[0]!;
    expect(day.sections[0]?.reservations.map((item) => item.id)).toContain(
      unassigned.id,
    );
    expect(day.sections[5]?.reservations.map((item) => item.id)).toContain(
      grandfathered.id,
    );
  });
});

describe("M11 spreadsheet safety and deterministic names", () => {
  it.each([
    ["=HYPERLINK(\"x\")", "'=HYPERLINK(\"x\")"],
    [" +SUM(A1:A2)", "' +SUM(A1:A2)"],
    ["@IMPORTDATA(x)", "'@IMPORTDATA(x)"],
    ["-1+2", "'-1+2"],
    ["\tvalue", "'\tvalue"],
    ["\rvalue", "'\rvalue"],
    ["\nvalue", "'\nvalue"],
    ["Mario Rossi", "Mario Rossi"],
  ])("neutralizes formula-capable value %j", (value, expected) => {
    expect(sanitizeSpreadsheetString(value)).toBe(expected);
  });

  it("uses deterministic ASCII filenames and safe worksheet names", () => {
    expect(pdfExportFilename("2026-08-24")).toBe(
      "piccadilly-prenotazioni-2026-08-24.pdf",
    );
    expect(
      excelExportFilename({ mode: "MONTH", month: "2026-08" }),
    ).toBe("piccadilly-prenotazioni-2026-08.xlsx");
    expect(
      excelExportFilename({
        mode: "RANGE",
        from: "2026-08-01",
        to: "2026-08-31",
      }),
    ).toBe("piccadilly-prenotazioni-2026-08-01_2026-08-31.xlsx");
    expect(exportWorksheetName("2026-08-24")).toBe("2026-08-24");
    expect(EXCEL_EXPORT_HEADERS).toHaveLength(24);
  });

  it("builds positive audit metadata with exact allow-lists", () => {
    const period = resolveExcelExportPeriod({ mode: "DAY", date: "2026-08-24" });
    expect(
      Object.keys(
        exportSuccessAuditMetadata({ format: "EXCEL", period, reservationCount: 4 }),
      ),
    ).toEqual([
      "format",
      "mode",
      "fromDate",
      "toDate",
      "dayCount",
      "reservationCount",
    ]);
    expect(
      Object.keys(
        exportFailureAuditMetadata({
          format: "EXCEL",
          period,
          failureCode: "GENERATION_FAILED",
        }),
      ),
    ).toEqual([
      "format",
      "mode",
      "fromDate",
      "toDate",
      "dayCount",
      "failureCode",
    ]);
  });
});
