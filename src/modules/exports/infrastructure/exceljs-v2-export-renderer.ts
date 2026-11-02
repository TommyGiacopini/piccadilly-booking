import "server-only";
import { Writable } from "node:stream";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import ExcelJS from "exceljs";
import { EXPORT_MAX_BUFFER_BYTES } from "@/modules/exports/domain/export-domain";
import { ExportSnapshotTooLargeError } from "@/modules/exports/application/export-errors";
import { EXCEL_V2_HEADERS, type ExcelV2Document } from "@/modules/exports/domain/excel-v2-domain";
import { EXPORT_PREVIEW_ROOMS } from "@/modules/exports/domain/export-contract";
import { excelV2Arrival, excelV2CreatedCell, excelV2LocalDate, excelV2Text } from "@/modules/exports/infrastructure/excel-v2-cell-policy";

export class BoundedExcelV2Sink extends Writable {
  private chunks: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly maximumBytes = EXPORT_MAX_BUFFER_BYTES) {
    super();
    if (maximumBytes < 0 || maximumBytes > EXPORT_MAX_BUFFER_BYTES) throw new RangeError("INVALID_EXCEL_BUFFER_LIMIT");
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (chunk.length > this.maximumBytes - this.bytes) { callback(new ExportSnapshotTooLargeError()); return; }
    this.bytes += chunk.length; this.chunks.push(Buffer.from(chunk)); callback();
  }
  discard() { this.chunks = []; this.bytes = 0; }
  result(): Buffer { return Buffer.concat(this.chunks, this.bytes); }
}
const widths = [9, 27, 12, 23, 21, 11, 11, 11, 32, 30, 28, 48, 58, 24];

export async function renderExcelV2(document: ExcelV2Document, options: { sink?: BoundedExcelV2Sink } = {}): Promise<Buffer> {
  const sink = options.sink ?? new BoundedExcelV2Sink();
  let streamError: Error | undefined;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  // Errors can precede ExcelJS commit's own listeners. Always observe them.
  void failure.catch(() => undefined);
  sink.on("error", error => { streamError = error; rejectFailure(error); });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: true, useSharedStrings: true });
  // ExcelJS 4.4's archiver owns queued ZIP streams; abort it during cleanup.
  const archive = (workbook as typeof workbook & { zip: {
    abort(): void; finalize(): Promise<void>;
    on(event: "error", listener: (error: Error) => void): void;
    emit(event: "error", error: Error): void;
  } }).zip;
  archive.on("error", error => { streamError = error; rejectFailure(error); });
  // ExcelJS 4.4 ignores Archiver.finalize's returned promise. A sink can fail
  // before commit reaches _finalize; abort then makes that late call reject.
  // Observe the promise and relay the error to ExcelJS's event-based listener.
  const finalizeArchive = archive.finalize.bind(archive);
  archive.finalize = () => {
    const completion = finalizeArchive();
    void completion.catch(error => archive.emit("error", error instanceof Error ? error : new Error("EXCEL_ZIP_FAILED")));
    return completion;
  };
  try {
    workbook.creator = "Piccadilly Booking"; workbook.lastModifiedBy = "Piccadilly Booking";
    const sheet = workbook.addWorksheet("Agenda", { views: [{ state: "frozen", xSplit: 2, ySplit: 7, topLeftCell: "C8", activeCell: "C8" }] });
    sheet.columns = widths.map(width => ({ width }));
    const s = document.summary;
    const localRead = excelV2LocalDate(document.readAt, document.timezone);
    const roomLabel = document.selection.room === "ALL" ? "TUTTO" : EXPORT_PREVIEW_ROOMS.find(room => room.key === document.selection.room)!.label;
    const orderLabel = document.selection.order === "CREATED_ASC" ? "Creazione crescente" : document.selection.order === "NAME_ASC" ? "Cognome/nome A–Z" : "Ora di arrivo";
    const context = [
      `Agenda operativa — ${document.restaurantName}`,
      `Giorno: ${document.selection.period.date} — ${document.selection.service === "LUNCH" ? "Pranzo" : "Cena"} — Sala: ${roomLabel} — Ordine: ${orderLabel}`,
      `Fuso orario: ${document.timezone} — Lettura indipendente dalla preview: ${localRead.toISOString().slice(0, 19).replace("T", " ")} (ora locale)`,
      `Prenotazioni: ${s.reservationCount} — Coperti: ${s.partySizeTotal} — Adulti noti: ${s.knownAdultsTotal} — Bambini noti: ${s.knownChildrenTotal} — Composizione sconosciuta: ${s.unknownCompositionCount}${s.unknownCompositionCount ? " (conteggi adulti/bambini parziali)" : ""}`,
      "Totali della selezione esportata; non cambiano applicando i filtri Excel. Ordine ricostruisce la sequenza originale.",
      "TA = tutti adulti; DECLARED = conteggi dichiarati; UNKNOWN = composizione sconosciuta. Giochi richiesti non significa sala assegnata. Testi lunghi: consultare il valore completo nell’editor della cella.",
    ];
    context.forEach((value, index) => {
      const row = sheet.addRow([excelV2Text(value)]); sheet.mergeCells(row.number, 1, row.number, 14);
      row.font = { name: "Calibri", size: index === 0 ? 14 : 11, bold: index === 0 };
      row.alignment = { wrapText: true, vertical: "middle" }; row.height = index === 5 ? 36 : 30; row.commit();
    });
    const header = sheet.addRow(EXCEL_V2_HEADERS.map(excelV2Text)); header.height = 36;
    header.eachCell(cell => { cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FF000000" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E5E5" } };
      cell.alignment = { wrapText: true, vertical: "middle" };
    }); header.commit();
    for (let index = 0; index < document.rows.length; index++) {
      if (streamError) throw streamError;
      const r = document.rows[index];
      const row = sheet.addRow([r.ordinal, excelV2Text(r.room), excelV2Arrival(r.arrival), excelV2Text(r.lastName), excelV2Text(r.firstName),
        r.partySize, r.adultsCount, r.childrenCount, excelV2Text(r.composition), excelV2Text(r.games), excelV2Text(r.preferredRoom),
        excelV2Text(r.requests), r.notes === null ? null : excelV2Text(r.notes), excelV2CreatedCell(r.createdAt, document.timezone)]);
      row.font = { name: "Calibri", size: 11, color: { argb: "FF000000" } };
      row.alignment = { wrapText: true, vertical: "top", shrinkToFit: false };
      row.getCell(3).numFmt = "hh:mm"; row.getCell(14).numFmt = "dd/mm/yyyy hh:mm";
      row.getCell(6).font = { name: "Calibri", size: 13, bold: true };
      let lines = 1;
      [r.room, r.lastName, r.firstName, r.composition, r.games, r.preferredRoom, r.requests, r.notes ?? ""].forEach((value, i) => {
        const width = [27, 23, 21, 32, 30, 28, 48, 58][i];
        lines = Math.max(lines, value.split(/\r\n|[\r\n]/u).reduce((n, line) => n + Math.max(1, Math.ceil(line.length / (width - 2))), 0));
      });
      row.height = Math.min(409, Math.max(30, lines * 15)); row.commit();
      if (index % 64 === 0) await yieldEventLoop();
    }
    if (document.rows.length) sheet.autoFilter = `A7:N${7 + document.rows.length}`;
    sheet.commit();
    await Promise.race([workbook.commit(), failure]);
    if (streamError) throw streamError;
    const result = sink.result(); sink.discard(); return result;
  } catch (error) {
    archive.abort(); sink.discard(); sink.destroy(); throw error;
  }
}
