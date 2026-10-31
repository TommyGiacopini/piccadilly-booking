import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";
import { ExportSnapshotTooLargeError } from "@/modules/exports/application/export-errors";
import { ExportPreviewDataError } from "@/modules/exports/domain/export-contract";
import type { PdfV2Document, PdfV2Row } from "@/modules/exports/domain/pdf-v2-domain";
import { PDF_V2_LAYOUT as L, PDF_V2_MM } from "@/modules/exports/infrastructure/pdf-v2-layout";
import { renderPdfV2, type PdfV2CellTrace } from "@/modules/exports/infrastructure/pdfkit-v2-export-renderer";

function input(count: number): PdfV2Document {
  const rows: PdfV2Row[] = Array.from({ length: count }, (_, index) => ({
    ordinal: index + 1, name: `Cliente Sintetico${String(index + 1).padStart(4, "0")}`, partySize: 4, composition: ["3 A", "1 B"],
    room: "DA ASSEGNARE", arrival: "19:15", requests: [], notes: null, createdDate: "20/11/2090", createdTime: "10:15",
  }));
  const summary = { reservationCount: count, partySizeTotal: count * 4, knownCompositionCount: count, unknownCompositionCount: 0, knownAdultsTotal: count * 3, knownChildrenTotal: count };
  return { selection: { version: 2, target: "PDF", period: { mode: "DAY", date: "2090-11-20" }, service: "DINNER", room: "ALL", order: "CREATED_ASC" },
    restaurantName: "Risto Pizza Piccadilly - DATI SINTETICI", timezone: "Europe/Rome", readAt: "2090-11-20T12:00:00Z", summary,
    groups: [{ key: "UNASSIGNED", label: "DA ASSEGNARE", summary, rows }] };
}
function save(name: string, buffer: Buffer, details: unknown) {
  const folder = process.env.T10_EVIDENCE_DIR;
  if (!folder) return;
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name + ".pdf"), buffer);
  writeFileSync(join(folder, name + ".json"), JSON.stringify(details, null, 2));
}
async function inspect(buffer: Buffer, cells: PdfV2CellTrace[]) {
  const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const texts: string[] = [], geometry: unknown[] = [];
  let checkedBodyItems = 0, blankTableCells = 0;
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
      expect(viewport.width).toBeCloseTo(L.width, 1); expect(viewport.height).toBeCloseTo(L.height, 1);
      const content = await page.getTextContent(), pageCells = cells.filter(cell => cell.page === number);
      const bodyBoxes: Array<{ x: number; right: number; top: number; bottom: number }> = [];
      const items = content.items.filter(item => "str" in item);
      const text = items.map(item => item.str).join(" "); texts.push(text);
      expect(text).toContain(`Pagina ${number}`);
      if (pageCells.length) for (const label of ["Nome e cognome", "Coperti", "Sala", "Tavolo", "Arrivo", "Note/richieste"]) expect(text).toContain(label);
      for (const item of items) {
        if (!item.str.trim()) continue;
        const style = content.styles[item.fontName], fontSize = Math.hypot(item.transform[2], item.transform[3]);
        const x = item.transform[4], baseline = viewport.height - item.transform[5];
        const top = baseline - (style.ascent ?? 0.8) * fontSize, bottom = baseline - (style.descent ?? -0.2) * fontSize;
        expect(x).toBeGreaterThanOrEqual(L.margin - 0.5); expect(x + item.width).toBeLessThanOrEqual(L.width - L.margin + 0.5);
        expect(top).toBeGreaterThanOrEqual(L.margin - 0.5); expect(bottom).toBeLessThanOrEqual(L.height - L.margin + 0.5);
        const rowCells = pageCells.filter(cell => baseline >= cell.y && baseline <= cell.y + cell.height);
        if (rowCells.length) {
          const cell = rowCells.find(candidate => x >= candidate.x - 0.5 && x + item.width <= candidate.x + candidate.width + 0.5);
          expect(cell, `text outside cell on page ${number}: ${item.str}`).toBeDefined();
          expect(cell!.column).not.toBe(3);
          expect(top).toBeGreaterThanOrEqual(cell!.y - 0.5); expect(bottom).toBeLessThanOrEqual(cell!.y + cell!.height + 0.5);
          expect(fontSize).toBeGreaterThanOrEqual(10.5 - 0.01); checkedBodyItems++;
          const box = { x, right: x + item.width, top, bottom };
          expect(bodyBoxes.some(other => Math.min(other.right, box.right) - Math.max(other.x, box.x) > 0.5
            && Math.min(other.bottom, box.bottom) - Math.max(other.top, box.top) > 0.5), "overlapping text in actual PDF").toBe(false);
          bodyBoxes.push(box);
        }
        geometry.push({ page: number, text: item.str, x, top, bottom, width: item.width, fontSize });
      }
      for (const cell of pageCells.filter(value => value.column === 3)) {
        expect(cell.width - 2 * L.padding).toBeGreaterThanOrEqual(18 * PDF_V2_MM);
        expect(cell.height - 2 * L.padding).toBeGreaterThanOrEqual(12 * PDF_V2_MM);
        expect(cell.y + cell.height).toBeLessThanOrEqual(L.bottom + 0.5); blankTableCells++;
      }
      const operators = await page.getOperatorList();
      for (let index = 0; index < operators.fnArray.length; index++) {
        const op = operators.fnArray[index], args = operators.argsArray[index];
        if ([OPS.setFillRGBColor, OPS.setStrokeRGBColor].includes(op)) {
          const color = Array.from(args as number[]);
          expect(color[0]).toBe(color[1]); expect(color[1]).toBe(color[2]);
        }
      }
      expect(await page.getAnnotations()).toEqual([]);
    }
    const metadata = await pdf.getMetadata();
    return { pages: pdf.numPages, texts, geometry, checkedBodyItems, blankTableCells, metadata };
  } finally { await pdf.destroy(); }
}

describe("T10 real PDF, independent PDF.js geometry and handwriting", () => {
  it.each([0, 1, 101, 2000])("renders and inspects %i complete reservations without a page limit", async count => {
    const cells: PdfV2CellTrace[] = [], start = performance.now(), before = process.memoryUsage();
    const peak = { ...before };
    const buffer = await renderPdfV2(input(count), { onCell: cell => {
      cells.push(cell);
      if (cell.column === 0) { const memory = process.memoryUsage(); for (const key of ["rss", "heapUsed", "external", "arrayBuffers"] as const) peak[key] = Math.max(peak[key], memory[key]); }
    } });
    const durationMs = performance.now() - start, after = process.memoryUsage();
    expect(buffer.byteLength).toBeLessThanOrEqual(26_214_400);
    const result = await inspect(buffer, cells);
    const text = result.texts.join(" ");
    for (let index = 1; index <= count; index++) expect(text.split(`Sintetico${String(index).padStart(4, "0")}`)).toHaveLength(2);
    expect(cells.filter(cell => cell.column === 3)).toHaveLength(count);
    expect(result.blankTableCells).toBe(count);
    if (count > 100) expect(result.pages).toBeGreaterThan(2);
    if (!count) expect(text).toContain("Nessuna prenotazione confermata");
    save(`count-${count}`, buffer, { ...result, cells, metrics: { before, after, sampledPeak: peak, durationMs, bytes: buffer.byteLength, processMaxRssKiB: process.resourceUsage().maxRSS, scope: "same-process sample, not production capacity certification" } });
  }, 120_000);
  it("preserves long names, unbroken NC, accents, section continuations and excludes runtime private/digital fields", async () => {
    const document = input(2), first = document.groups[0].rows[0];
    first.name = "Èlia Alessàndra " + "Cognomelunghissimo".repeat(8);
    first.requests = ["Allergie: " + "A".repeat(300), "Intolleranze: " + "I".repeat(300), "Ricorrenza: " + "R".repeat(200), "Giochi richiesti - non garantiti"];
    first.notes = "NC_INIZIO à è é ì ò ù È l’ospitalità\n" + "N".repeat(900) + " NC_FINE +39000123";
    Object.assign(first, { tableNames: ["DIGITAL_FORBIDDEN"], privateNotes: "PRIVATE_FORBIDDEN", internalNotes: "LEGACY_FORBIDDEN", customerPhone: "STRUCTURED_PHONE_FORBIDDEN", customerEmail: "EMAIL_FORBIDDEN", token: "TOKEN_FORBIDDEN" });
    const cells: PdfV2CellTrace[] = [], buffer = await renderPdfV2(document, { onCell: cell => cells.push(cell) });
    const result = await inspect(buffer, cells), text = result.texts.join(" ");
    expect(result.pages).toBeGreaterThan(1); expect(text).toContain("Riga 1 (continua)"); expect(text).toContain("(continua)");
    const compact = text.replace(/\s/gu, "");
    expect(compact).toContain(first.name.replace(/\s/gu, ""));
    const extractedNotes = (result.geometry as Array<{ page: number; text: string; x: number; top: number; bottom: number; width: number }>).filter(glyph =>
      cells.some(cell => cell.ordinal === 1 && cell.column === 5 && cell.page === glyph.page
        && glyph.x >= cell.x - 0.5 && glyph.x + glyph.width <= cell.x + cell.width + 0.5
        && glyph.top >= cell.y - 0.5 && glyph.bottom <= cell.y + cell.height + 0.5))
      .map(glyph => glyph.text).join("").replace(/\s/gu, "");
    expect(extractedNotes).toBe([...first.requests, `NC: ${first.notes}`].join("\n").replace(/\s/gu, ""));
    expect(extractedNotes).toContain("àèéìòùÈ");
    for (const forbidden of ["DIGITAL_FORBIDDEN", "PRIVATE_FORBIDDEN", "LEGACY_FORBIDDEN", "STRUCTURED_PHONE_FORBIDDEN", "EMAIL_FORBIDDEN", "TOKEN_FORBIDDEN"]) {
      expect(text).not.toContain(forbidden); expect(JSON.stringify(result.metadata)).not.toContain(forbidden);
    }
    for (const cell of cells.filter(value => value.column === 3)) {
      const glyphs = result.geometry as Array<{ page: number; x: number; top: number; bottom: number; width: number }>;
      expect(glyphs.some(glyph => glyph.page === cell.page && glyph.x < cell.x + cell.width && glyph.x + glyph.width > cell.x && glyph.top < cell.y + cell.height && glyph.bottom > cell.y)).toBe(false);
    }
    save("critical-long-content", buffer, { ...result, cells });
  }, 60_000);
  it("aborts collection on byte overflow without returning a partial document", async () => {
    await expect(renderPdfV2(input(1), { maximumBufferBytes: 1024 })).rejects.toBeInstanceOf(ExportSnapshotTooLargeError);
    expect((await renderPdfV2(input(1))).subarray(0, 5).toString()).toBe("%PDF-");
  });
  it("rejects unsupported glyphs instead of silently replacing authorized NC", async () => {
    const document = input(1); document.groups[0].rows[0].notes = "NC non rappresentabile: \u{10ffff}";
    await expect(renderPdfV2(document)).rejects.toBeInstanceOf(ExportPreviewDataError);
  });
});
