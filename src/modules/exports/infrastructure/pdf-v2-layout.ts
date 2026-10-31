import { ExportPreviewDataError } from "@/modules/exports/domain/export-contract";
import type { PdfV2Row } from "@/modules/exports/domain/pdf-v2-domain";

export const PDF_V2_MM = 72 / 25.4;
export const PDF_V2_LAYOUT = {
  width: 210 * PDF_V2_MM, height: 297 * PDF_V2_MM, margin: 12 * PDF_V2_MM,
  bottom: 275 * PDF_V2_MM, bodyFont: 10.5, partyFont: 14, smallFont: 9,
  minimumRow: 20 * PDF_V2_MM, padding: 1.5 * PDF_V2_MM,
  sectionHeight: 36, tableHeaderHeight: 32,
} as const;
export const PDF_V2_COLUMNS = [
  { label: "Nome e cognome", width: 40 * PDF_V2_MM },
  { label: "Coperti", width: 18 * PDF_V2_MM },
  { label: "Sala", width: 24 * PDF_V2_MM },
  { label: "Tavolo", width: 22 * PDF_V2_MM },
  { label: "Arrivo", width: 14 * PDF_V2_MM },
  { label: "Note/richieste", width: 44 * PDF_V2_MM },
  { label: "Prenotata il", width: 24 * PDF_V2_MM },
] as const;

export interface PdfV2Metrics {
  width(text: string, fontSize: number): number;
  lineHeight(fontSize: number): number;
}
export interface PdfV2Line { text: string; size: number; height: number }
export type PdfV2Cells = PdfV2Line[][];

const segmenter = new Intl.Segmenter("it", { granularity: "grapheme" });
export function wrapPdfV2Text(text: string, width: number, size: number, metrics: PdfV2Metrics): PdfV2Line[] {
  if (width <= 0 || /\p{Surrogate}|\u0000/u.test(text)) throw new ExportPreviewDataError();
  const lines: PdfV2Line[] = [];
  const push = (value: string) => lines.push({ text: value, size, height: Math.max(13.5, metrics.lineHeight(size)) });
  for (const paragraph of text.replace(/\r\n?/gu, "\n").split("\n")) {
    let line = "";
    for (const token of paragraph.match(/\S+|[^\S\n]+/gu) ?? []) {
      if (metrics.width(line + token, size) <= width) { line += token; continue; }
      if (line) { push(line.trimEnd()); line = ""; }
      const word = token.trimStart();
      for (const { segment } of segmenter.segment(word)) {
        if (metrics.width(segment, size) > width) throw new ExportPreviewDataError();
        if (line && metrics.width(line + segment, size) > width) { push(line); line = ""; }
        line += segment;
      }
    }
    push(line.trimEnd());
  }
  return lines;
}

export function measurePdfV2Row(row: PdfV2Row, metrics: PdfV2Metrics): PdfV2Cells {
  const values = [
    `${row.ordinal}. ${row.name}`, [String(row.partySize), ...row.composition].join("\n"), row.room,
    "", row.arrival, [...row.requests, row.notes !== null && row.notes !== "" ? `NC: ${row.notes}` : null].filter(value => value !== null).join("\n"),
    `${row.createdDate}\n${row.createdTime}`,
  ];
  return values.map((text, column) => {
    if (column === 3 || text === "") return [];
    const width = PDF_V2_COLUMNS[column].width - 2 * PDF_V2_LAYOUT.padding;
    if (column === 1) return [
      ...wrapPdfV2Text(String(row.partySize), width, PDF_V2_LAYOUT.partyFont, metrics),
      ...wrapPdfV2Text(row.composition.join("\n"), width, PDF_V2_LAYOUT.bodyFont, metrics),
    ];
    return wrapPdfV2Text(text, width, PDF_V2_LAYOUT.bodyFont, metrics);
  });
}

export function pdfV2RowHeight(cells: PdfV2Cells): number {
  return Math.max(PDF_V2_LAYOUT.minimumRow, ...cells.map(lines => lines.reduce((sum, line) => sum + line.height, 0) + 2 * PDF_V2_LAYOUT.padding));
}

export function takePdfV2Segment(cells: PdfV2Cells, capacity: number): { cells: PdfV2Cells; rest: PdfV2Cells; height: number } {
  if (capacity + 0.001 < PDF_V2_LAYOUT.minimumRow) throw new ExportPreviewDataError();
  const available = capacity - 2 * PDF_V2_LAYOUT.padding;
  const selected = cells.map(lines => {
    let used = 0, count = 0;
    for (const line of lines) { if (used + line.height > available + 0.001) break; used += line.height; count++; }
    if (lines.length && count === 0) throw new ExportPreviewDataError();
    return lines.slice(0, count);
  });
  const rest = cells.map((lines, index) => lines.slice(selected[index].length));
  if (!selected.some(lines => lines.length)) throw new ExportPreviewDataError();
  return { cells: selected, rest, height: pdfV2RowHeight(selected) };
}
