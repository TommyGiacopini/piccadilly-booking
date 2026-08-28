import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";

import ExcelJS from "exceljs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";

import {
  buildExportDays,
  type ExportReservationDto,
  type ExportSnapshotDto,
} from "@/modules/exports/domain/export-domain";
import {
  EXCEL_EXPORT_HEADERS,
  renderExcelExport,
} from "@/modules/exports/infrastructure/exceljs-export-renderer";
import { renderPdfExport } from "@/modules/exports/infrastructure/pdfkit-export-renderer";

function reservation(
  input: Partial<ExportReservationDto> = {},
): ExportReservationDto {
  return {
    id: randomUUID(),
    localDate: "2026-08-24",
    serviceType: "DINNER",
    arrivalTime: "19:15",
    customerFirstName: "Èlia",
    customerLastName: "Rossi",
    partySize: 3,
    customerPhone: "+39000000000",
    origin: "PHONE",
    preferredRoom: "Sala 3",
    highChair: true,
    stroller: true,
    accessibility: true,
    children: true,
    celiac: true,
    allergies: "arachidi",
    intolerances: "lattosio",
    celebration: "compleanno",
    animals: true,
    notes: "Perché l’ospitalità è così: à è é ì ò ù È.",
    createdAt: new Date("2026-08-24T16:05:00.000Z"),
    assignment: null,
    ...input,
  };
}

function snapshot(
  reservations: ExportReservationDto[],
  dates = ["2026-08-24"],
): ExportSnapshotDto {
  return {
    restaurantName: "Risto Pizza Piccadilly",
    timezone: "Europe/Rome",
    fromDate: dates[0]!,
    toDate: dates.at(-1)!,
    reservationCount: reservations.length,
    days: buildExportDays(dates, reservations),
  };
}

async function pdfPages(buffer: Buffer): Promise<{ pages: string[]; metadata: unknown }> {
  const loading = getDocument({ data: new Uint8Array(buffer) });
  const document = await loading.promise;
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" "),
    );
  }
  const metadata = await document.getMetadata();
  await document.destroy();
  return { pages, metadata };
}

function zipEntries(buffer: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory not found.");
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory.");
    }
    const compression = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + fileNameLength)
      .toString("utf8");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("Invalid ZIP local header.");
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(
      name,
      compression === 0
        ? Buffer.from(compressed)
        : compression === 8
          ? inflateRawSync(compressed)
          : (() => {
              throw new Error(`Unsupported ZIP compression ${compression}.`);
            })(),
    );
    cursor += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function excelJsInput(buffer: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy.buffer;
}

describe("M11 PDFKit renderer", () => {
  it("opens a real Unicode PDF with all sections, both services, details and tables", async () => {
    const assigned = reservation({
      id: "00000000-0000-4000-8000-000000000001",
      serviceType: "LUNCH",
      arrivalTime: "12:30",
      customerFirstName: "Giulia",
      customerLastName: "Bianché",
      createdAt: new Date("2026-08-24T08:00:00Z"),
      assignment: {
        roomCode: "sala-1",
        roomName: "Sala 1",
        tables: [
          { id: randomUUID(), name: "Tavolo 2", displayOrder: 2 },
          { id: randomUUID(), name: "Tavolo 1", displayOrder: 1 },
        ],
        internalNotes: "Vicino all’ingresso",
      },
    });
    const unassigned = reservation({
      id: "00000000-0000-4000-8000-000000000002",
      createdAt: new Date("2026-08-24T09:00:00Z"),
    });
    const buffer = await renderPdfExport(snapshot([unassigned, assigned]));
    expect(buffer.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const parsed = await pdfPages(buffer);
    const text = parsed.pages.join(" ");
    const sectionPositions = [
      "DA ASSEGNARE",
      "Sala 1",
      "Sala 2",
      "Sala 3",
      "Galleria",
      "Terrazzo",
    ].map((label) => text.indexOf(`SEZIONE · ${label}`));
    expect(sectionPositions.every((position) => position >= 0)).toBe(true);
    expect(sectionPositions).toEqual([...sectionPositions].sort((a, b) => a - b));
    expect(text).toContain("Pranzo");
    expect(text).toContain("Cena");
    expect(text).toContain("Tavolo 1, Tavolo 2");
    expect(text).toContain("Preferenza sala cliente");
    expect(text).toContain("Vicino all’ingresso");
    expect(text).toContain("à è é ì ò ù È");
    const info = (parsed.metadata as { info: Record<string, unknown> }).info;
    expect(info.Title).toBe("Prenotazioni operative");
    expect(Object.values(info).join(" ")).not.toContain("+39000000000");
    expect(Object.values(info).join(" ")).not.toContain("Bianché");
  });

  it("paginates maximum-length details with repeated headers and no missing/duplicate rows", async () => {
    const reservations = Array.from({ length: 54 }, (_, index) =>
      reservation({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        customerFirstName: "Cliente",
        customerLastName: `Export${String(index + 1).padStart(3, "0")}`,
        notes: index === 0 ? "N".repeat(1_000) : `Nota ${index + 1}`,
        createdAt: new Date(Date.UTC(2026, 7, 1, 10, index)),
      }),
    );
    const parsed = await pdfPages(await renderPdfExport(snapshot(reservations)));
    expect(parsed.pages.length).toBeGreaterThan(1);
    for (const page of parsed.pages) {
      expect(page).toContain("Servizio");
      expect(page).toContain("Pagina");
    }
    const allText = parsed.pages.join(" ");
    for (let index = 1; index <= reservations.length; index += 1) {
      const marker = `Export${String(index).padStart(3, "0")}`;
      expect(allText.split(marker)).toHaveLength(2);
    }
  });

  it("returns a valid 200-style document for an empty day", async () => {
    const parsed = await pdfPages(await renderPdfExport(snapshot([])));
    const text = parsed.pages.join(" ");
    expect(text.match(/Nessuna prenotazione confermata/gu)).toHaveLength(6);
  });
});

describe("M11 ExcelJS renderer", () => {
  it("round-trips DAY rows with exact columns, typed cells and neutralized formulas", async () => {
    const dangerous = reservation({
      customerFirstName: '=HYPERLINK("https://invalid.test")',
      customerLastName: "Mario Rossi",
      customerPhone: " +SUM(A1:A2)",
      allergies: "@IMPORTDATA(x)",
      notes: "\tformula-like",
      assignment: {
        roomCode: "sala-1",
        roomName: "-Sala",
        tables: [{ id: randomUUID(), name: "=TAVOLO", displayOrder: 1 }],
        internalNotes: "+CMD",
      },
    });
    const buffer = await renderExcelExport(snapshot([dangerous]));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excelJsInput(buffer));
    const sheet = workbook.getWorksheet("2026-08-24")!;
    expect(workbook.worksheets).toHaveLength(1);
    expect(sheet.getRow(1).values).toEqual([undefined, ...EXCEL_EXPORT_HEADERS]);
    expect(sheet.rowCount).toBe(2);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.autoFilter).toBe("A1:X1");
    expect(sheet.columns.every((column) => (column.width ?? 0) > 0)).toBe(true);
    expect(sheet.getCell("A2").type).toBe(ExcelJS.ValueType.Date);
    expect(sheet.getCell("C2").type).toBe(ExcelJS.ValueType.Date);
    expect(sheet.getCell("C2").value).toBeInstanceOf(Date);
    expect(sheet.getCell("F2").type).toBe(ExcelJS.ValueType.Number);
    expect(sheet.getCell("X2").type).toBe(ExcelJS.ValueType.Date);
    expect(sheet.getCell("A2").numFmt).toBe("dd/mm/yyyy");
    expect(sheet.getCell("C2").numFmt).toBe("hh:mm");
    expect(sheet.getCell("X2").numFmt).toBe("dd/mm/yyyy hh:mm");
    expect(sheet.getCell("D2").value).toBe(`'${dangerous.customerFirstName}`);
    expect(sheet.getCell("E2").value).toBe("Mario Rossi");
    expect(sheet.getCell("G2").value).toBe(`'${dangerous.customerPhone}`);
    expect(sheet.getCell("R2").value).toBe(`'${dangerous.allergies}`);
    expect(sheet.getCell("V2").value).toBe(`'${dangerous.notes}`);
    expect(sheet.getCell("W2").value).toBe(`'${dangerous.assignment?.internalNotes}`);
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
        expect(cell.hyperlink).toBeUndefined();
      }),
    );

    const entries = zipEntries(buffer);
    expect([...entries.keys()].some((name) => name.startsWith("xl/externalLinks/"))).toBe(false);
    const xml = [...entries.entries()]
      .filter(([name]) => name.endsWith(".xml") || name.endsWith(".rels"))
      .map(([, value]) => value.toString("utf8"))
      .join("\n");
    expect(xml).not.toMatch(/<f(?:\s|>)/u);
    expect(xml).not.toMatch(/<hyperlink(?:\s|>)/u);
  });

  it("creates chronological empty sheets for full MONTH/RANGE periods", async () => {
    const dates = Array.from({ length: 31 }, (_, index) =>
      `2026-08-${String(index + 1).padStart(2, "0")}`,
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      excelJsInput(await renderExcelExport(snapshot([], dates))),
    );
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(dates);
    for (const sheet of workbook.worksheets) {
      expect(sheet.rowCount).toBe(1);
      expect(sheet.getRow(1).values).toEqual([undefined, ...EXCEL_EXPORT_HEADERS]);
    }
  });

  it("serializes absent optional text as truly empty cells", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      excelJsInput(
        await renderExcelExport(
          snapshot([
            reservation({
              allergies: null,
              intolerances: null,
              celebration: null,
              notes: null,
              assignment: null,
            }),
          ]),
        ),
      ),
    );
    const sheet = workbook.getWorksheet("2026-08-24")!;
    for (const address of ["R2", "S2", "T2", "V2", "W2"]) {
      expect(sheet.getCell(address).value).toBeNull();
    }
  });
});
