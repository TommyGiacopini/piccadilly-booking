import { describe, expect, it } from "vitest";
import type { PdfV2Row } from "@/modules/exports/domain/pdf-v2-domain";
import { PDF_V2_COLUMNS, PDF_V2_LAYOUT as L, PDF_V2_MM, measurePdfV2Row, pdfV2RowHeight, takePdfV2Segment, wrapPdfV2Text, type PdfV2Metrics } from "@/modules/exports/infrastructure/pdf-v2-layout";

const metrics: PdfV2Metrics = { width: (text, size) => [...text].length * size / 2, lineHeight: size => size * 1.4 };
const row: PdfV2Row = { ordinal: 1, name: "Èlia Rossi", partySize: 8, composition: ["6 A", "2 B"], room: "Sala 3 — Giochi", arrival: "19:15", requests: [], notes: null, createdDate: "20/11/2090", createdTime: "10:15" };
describe("T10 measured layout invariants", () => {
  it("fits exactly seven columns inside A4 portrait with 12 mm margins", () => {
    expect(L.width / PDF_V2_MM).toBeCloseTo(210); expect(L.height / PDF_V2_MM).toBeCloseTo(297);
    expect(PDF_V2_COLUMNS).toHaveLength(7);
    expect(PDF_V2_COLUMNS.reduce((sum, column) => sum + column.width, 0)).toBeCloseTo(L.width - 2 * L.margin);
  });
  it("always reserves an empty table cell wider than 18 mm and taller than 12 mm", () => {
    const cells = measurePdfV2Row(row, metrics), height = pdfV2RowHeight(cells);
    expect(cells[3]).toEqual([]); expect(PDF_V2_COLUMNS[3].width - 2 * L.padding).toBeGreaterThanOrEqual(18 * PDF_V2_MM);
    expect(height).toBeGreaterThanOrEqual(20 * PDF_V2_MM);
    expect(height - 2 * L.padding).toBeGreaterThanOrEqual(12 * PDF_V2_MM);
    expect(cells[1][0].size).toBe(14);
  });
  it.each(["N".repeat(1000), "Èlia e l’ospitalità à è é ì ò ù\nseconda riga\n\nfine", "e\u0301".repeat(180)])("wraps without losing long tokens or graphemes %#", text => {
    const lines = wrapPdfV2Text(text, 70, 10.5, metrics);
    expect(lines.map(line => line.text).join("").replace(/\s/gu, "")).toBe(text.replace(/\s/gu, ""));
    expect(lines.every(line => metrics.width(line.text, line.size) <= 70)).toBe(true);
    expect(lines.every(line => line.size === 10.5)).toBe(true);
  });
  it("splits all oversized cells with monotonic progress and exact reassembly", () => {
    const cells = measurePdfV2Row({ ...row, name: "Nome".repeat(300), notes: "N".repeat(1000), requests: ["Allergie: " + "A".repeat(300)] }, metrics);
    let rest = cells;
    const reconstructed = cells.map(() => [] as string[]);
    let count = 0;
    while (rest.some(lines => lines.length)) {
      const segment = takePdfV2Segment(rest, 160);
      expect(segment.height).toBeLessThanOrEqual(160); expect(segment.height).toBeGreaterThanOrEqual(L.minimumRow);
      segment.cells.forEach((lines, index) => reconstructed[index].push(...lines.map(line => line.text)));
      expect(segment.cells[3]).toEqual([]); rest = segment.rest;
      expect(++count).toBeLessThan(100);
    }
    expect(count).toBeGreaterThan(2);
    expect(reconstructed).toEqual(cells.map(lines => lines.map(line => line.text)));
  });
  it("rejects insufficient capacity and invalid Unicode instead of clipping or looping", () => {
    expect(() => takePdfV2Segment(measurePdfV2Row(row, metrics), 10)).toThrow();
    for (const text of ["bad\u0000", "\ud800"]) expect(() => wrapPdfV2Text(text, 100, 10.5, metrics)).toThrow();
  });
});
