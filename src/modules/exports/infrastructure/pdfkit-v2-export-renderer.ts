import "server-only";
import { setImmediate } from "node:timers/promises";
import PDFDocument from "pdfkit";
import { ExportSnapshotTooLargeError } from "@/modules/exports/application/export-errors";
import { ExportPreviewDataError } from "@/modules/exports/domain/export-contract";
import { EXPORT_MAX_BUFFER_BYTES } from "@/modules/exports/domain/export-domain";
import { pdfV2LocalInstant, pdfV2OrderLabel, type PdfV2Document } from "@/modules/exports/domain/pdf-v2-domain";
import { loadNotoSansFont } from "@/modules/exports/infrastructure/font-loader";
import { PDF_V2_COLUMNS, PDF_V2_LAYOUT as L, PDF_V2_MM, measurePdfV2Row, pdfV2RowHeight, takePdfV2Segment, wrapPdfV2Text, type PdfV2Cells, type PdfV2Metrics } from "@/modules/exports/infrastructure/pdf-v2-layout";

export interface PdfV2CellTrace { page: number; ordinal: number; continued: boolean; column: number; x: number; y: number; width: number; height: number }
export interface PdfV2RenderOptions {
  maximumBufferBytes?: number;
  onCell?: (cell: PdfV2CellTrace) => void;
}

export async function renderPdfV2(document: PdfV2Document, options: PdfV2RenderOptions = {}): Promise<Buffer> {
  const font = await loadNotoSansFont();
  const maximumBytes = Math.min(EXPORT_MAX_BUFFER_BYTES, options.maximumBufferBytes ?? EXPORT_MAX_BUFFER_BYTES);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new ExportSnapshotTooLargeError();
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "portrait", margin: L.margin, bufferPages: false,
      info: { Title: "Prenotazioni operative V2", Author: "Piccadilly Booking", Creator: "Piccadilly Booking", Subject: "Documento operativo" } });
    const chunks: Buffer[] = [];
    let bytes = 0, failed = false;
    const fail = (error: unknown) => { if (failed) return; failed = true; chunks.length = 0; doc.destroy(); reject(error); };
    doc.on("error", fail);
    doc.on("data", (chunk: Buffer) => {
      if (failed) return;
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) { fail(new ExportSnapshotTooLargeError()); return; }
      chunks.push(chunk);
    });
    doc.on("end", () => { if (!failed) { const buffer = Buffer.concat(chunks, bytes); chunks.length = 0; resolve(buffer); } });

    void (async () => {
      doc.registerFont("NotoSans", font).font("NotoSans").fillColor("black").strokeColor("black");
      // PDFKit 0.19.1 owns the loaded fontkit face. Keep this pinned adapter local,
      // fail closed if it changes, and never silently substitute a missing glyph.
      const face = (doc as unknown as { _font?: { font?: { hasGlyphForCodePoint?: (code: number) => boolean } } })._font?.font;
      if (!face?.hasGlyphForCodePoint) throw new Error("PDF font metrics unavailable.");
      const hasGlyph = face.hasGlyphForCodePoint.bind(face), checkedGlyphs = new Set<number>();
      const metrics: PdfV2Metrics = {
        width(text, size) {
          for (const character of text) {
            const code = character.codePointAt(0)!;
            if (checkedGlyphs.has(code) || character === "\t") continue;
            if (!hasGlyph(code)) throw new ExportPreviewDataError();
            checkedGlyphs.add(code);
          }
          return doc.fontSize(size).widthOfString(text);
        },
        lineHeight(size) { return doc.fontSize(size).currentLineHeight(true); },
      };
      const width = L.width - 2 * L.margin;
      let page = 1, y = L.margin, headerBottom = y;
      const drawLines = (text: string, x: number, top: number, available: number, size: number) => {
        const lines = wrapPdfV2Text(text, available, size, metrics);
        let position = top;
        for (const line of lines) {
          doc.fontSize(line.size).text(line.text, x, position, { lineBreak: false });
          position += line.height;
        }
        return position;
      };
      const pageHeader = () => {
        y = drawLines(document.restaurantName, L.margin, L.margin, width, 13) + 3;
        y = drawLines(`${document.selection.period.date} - ${document.selection.service === "LUNCH" ? "Pranzo" : "Cena"}`, L.margin, y, width, 11);
        const selected = document.selection.room === "ALL" ? "TUTTO" : document.groups[0]?.label ?? document.selection.room;
        y = drawLines(`Sala: ${selected} | Ordine: ${pdfV2OrderLabel(document.selection.order)}`, L.margin, y, width, 9);
        const read = pdfV2LocalInstant(document.readAt, document.timezone);
        y = drawLines(`Fonte: PostgreSQL | Lettura: ${read.date} ${read.time} (${document.timezone})`, L.margin, y, width, 9);
        y = drawLines(`${document.summary.reservationCount} prenotazioni | ${document.summary.partySizeTotal} coperti totali`, L.margin, y, width, 10.5);
        y = drawLines(`Adulti ${document.summary.knownAdultsTotal} | Bambini ${document.summary.knownChildrenTotal}${document.summary.unknownCompositionCount ? ` - totali parziali; ${document.summary.unknownCompositionCount} composizioni sconosciute` : " - composizione dichiarata"}`, L.margin, y, width, 9);
        y = drawLines("TA = tutti adulti | A = adulti | B = bambini | ? = non dichiarato", L.margin, y, width, 9) + 6;
        headerBottom = y;
        if (y + L.sectionHeight + L.tableHeaderHeight + L.minimumRow > L.bottom) throw new ExportPreviewDataError();
      };
      const footer = () => {
        doc.fontSize(9).text(`Pagina ${page}`, L.margin, L.height - L.margin - 14, { width, align: "right", lineBreak: false });
      };
      const nextPage = () => { footer(); doc.addPage(); page++; pageHeader(); };
      const sectionHeader = (group: PdfV2Document["groups"][number], continued: boolean) => {
        const sectionTop = y;
        y = drawLines(`${group.label}${continued ? " (continua)" : ""}`, L.margin + 4, y + 2, width - 8, 11);
        y = drawLines(`${group.summary.reservationCount} prenotazioni | ${group.summary.partySizeTotal} coperti - totale sezione`, L.margin + 4, y, width - 8, 9) + 3;
        if (y > sectionTop + L.sectionHeight) throw new ExportPreviewDataError();
        const top = sectionTop + L.sectionHeight;
        let x = L.margin;
        for (const column of PDF_V2_COLUMNS) {
          doc.rect(x, top, column.width, L.tableHeaderHeight).lineWidth(0.6).stroke();
          const bottom = drawLines(column.label, x + L.padding, top + L.padding, column.width - 2 * L.padding, 9.5);
          if (bottom > top + L.tableHeaderHeight) throw new ExportPreviewDataError();
          x += column.width;
        }
        y = top + L.tableHeaderHeight;
      };
      const drawSegment = (cells: PdfV2Cells, height: number, ordinal: number, continued: boolean) => {
        let x = L.margin;
        for (let column = 0; column < PDF_V2_COLUMNS.length; column++) {
          const cellWidth = PDF_V2_COLUMNS[column].width;
          doc.rect(x, y, cellWidth, height).lineWidth(0.4).stroke();
          let lineY = y + L.padding;
          // C03 is enforced here as well as in the positive document projection.
          if (column !== 3) for (const line of cells[column]) {
            doc.fontSize(line.size).text(line.text, x + L.padding, lineY, { lineBreak: false });
            lineY += line.height;
          }
          options.onCell?.({ page, ordinal, continued, column, x, y, width: cellWidth, height });
          x += cellWidth;
        }
        y += height;
      };
      pageHeader();
      for (const group of document.groups) {
        if (y + L.sectionHeight + L.tableHeaderHeight + L.minimumRow > L.bottom) nextPage();
        sectionHeader(group, false);
        if (!group.rows.length) {
          y = drawLines("Nessuna prenotazione confermata", L.margin + L.padding, y + 5, 76 * PDF_V2_MM, 10.5) + 8;
        }
        for (const row of group.rows) {
          if (failed) return;
          let cells = measurePdfV2Row(row, metrics), continued = false;
          const freshCapacity = L.bottom - headerBottom - L.sectionHeight - L.tableHeaderHeight;
          if (pdfV2RowHeight(cells) <= freshCapacity && pdfV2RowHeight(cells) > L.bottom - y) {
            nextPage(); sectionHeader(group, true);
          }
          while (cells.some(lines => lines.length)) {
            if (y + L.minimumRow > L.bottom) { nextPage(); sectionHeader(group, true); }
            const segment = takePdfV2Segment(cells, L.bottom - y);
            drawSegment(segment.cells, segment.height, row.ordinal, continued);
            cells = segment.rest;
            if (cells.some(lines => lines.length)) {
              nextPage(); sectionHeader(group, true); continued = true;
              cells[0] = [...wrapPdfV2Text(`Riga ${row.ordinal} (continua)`, PDF_V2_COLUMNS[0].width - 2 * L.padding, 10.5, metrics), ...cells[0]];
            }
          }
          await setImmediate();
        }
        y += 8;
      }
      if (!failed) { footer(); doc.end(); }
    })().catch(fail);
  });
}
