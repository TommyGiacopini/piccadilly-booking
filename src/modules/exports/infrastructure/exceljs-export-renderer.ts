import "server-only";

import ExcelJS from "exceljs";

import {
  exportWorksheetName,
  sanitizeSpreadsheetString,
  type ExportReservationDto,
  type ExportSnapshotDto,
} from "@/modules/exports/domain/export-domain";

export const EXCEL_EXPORT_HEADERS = [
  "Data",
  "Servizio",
  "Ora arrivo",
  "Nome",
  "Cognome",
  "Persone",
  "Telefono",
  "Origine",
  "Preferenza sala",
  "Stato assegnazione",
  "Sala definitiva",
  "Tavoli definitivi",
  "Seggiolone",
  "Passeggino",
  "Accessibilità",
  "Bambini",
  "Celiachia",
  "Allergie",
  "Intolleranze",
  "Celebrazione/ricorrenza",
  "Animali",
  "Note prenotazione",
  "Note interne assegnazione",
  "Creata il",
] as const;

const COLUMN_WIDTHS = [
  13, 12, 12, 18, 20, 10, 18, 13, 22, 22, 20, 24,
  13, 13, 15, 12, 12, 28, 28, 30, 12, 36, 36, 20,
] as const;

function text(
  value: string | null | undefined,
  fallback: string | null = null,
): string | null {
  const resolved = value ?? fallback;
  return resolved === null ? null : sanitizeSpreadsheetString(resolved);
}

function yesNo(value: boolean): string {
  return value ? "Sì" : "No";
}

function localDateCell(localDate: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function arrivalTimeCell(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours * 60 + minutes) / (24 * 60);
}

function localWallClockCell(value: Date, timezone: string): Date {
  const parts = new Map(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return new Date(
    Date.UTC(
      Number(parts.get("year")),
      Number(parts.get("month")) - 1,
      Number(parts.get("day")),
      Number(parts.get("hour")),
      Number(parts.get("minute")),
      Number(parts.get("second")),
    ),
  );
}

function flatRows(snapshot: ExportSnapshotDto, dayIndex: number): ExportReservationDto[] {
  return snapshot.days[dayIndex]?.sections.flatMap((section) => section.reservations) ?? [];
}

export async function renderExcelExport(snapshot: ExportSnapshotDto): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Piccadilly Booking";
  workbook.lastModifiedBy = "Piccadilly Booking";
  workbook.company = "Piccadilly";
  workbook.subject = "Prenotazioni operative";
  workbook.title = "Prenotazioni";
  workbook.calcProperties.fullCalcOnLoad = false;

  snapshot.days.forEach((day, dayIndex) => {
    const worksheet = workbook.addWorksheet(exportWorksheetName(day.localDate), {
      views: [{ state: "frozen", ySplit: 1 }],
      properties: { defaultRowHeight: 18 },
    });
    worksheet.columns = EXCEL_EXPORT_HEADERS.map((header, index) => ({
      header,
      key: `column${index + 1}`,
      width: COLUMN_WIDTHS[index],
    }));
    worksheet.autoFilter = { from: "A1", to: "X1" };
    worksheet.getRow(1).height = 28;
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2B2B2B" },
    };
    worksheet.getRow(1).alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };

    for (const reservation of flatRows(snapshot, dayIndex)) {
      const assignment = reservation.assignment;
      const row = worksheet.addRow([
        localDateCell(reservation.localDate),
        text(reservation.serviceType === "LUNCH" ? "Pranzo" : "Cena"),
        arrivalTimeCell(reservation.arrivalTime),
        text(reservation.customerFirstName),
        text(reservation.customerLastName),
        reservation.partySize,
        text(reservation.customerPhone),
        text(
          reservation.origin === "PUBLIC"
            ? "Pubblica"
            : reservation.origin === "PHONE"
              ? "Telefonica"
              : "Staff",
        ),
        text(reservation.preferredRoom),
        text(assignment ? "Assegnata" : "DA ASSEGNARE"),
        text(assignment?.roomName, "—"),
        text(assignment?.tables.map((table) => table.name).join(", "), "—"),
        text(yesNo(reservation.highChair)),
        text(yesNo(reservation.stroller)),
        text(yesNo(reservation.accessibility)),
        text(yesNo(reservation.children)),
        text(yesNo(reservation.celiac)),
        text(reservation.allergies),
        text(reservation.intolerances),
        text(reservation.celebration),
        text(yesNo(reservation.animals)),
        text(reservation.notes),
        text(assignment?.internalNotes),
        localWallClockCell(reservation.createdAt, snapshot.timezone),
      ]);
      row.alignment = { vertical: "top", wrapText: true };
    }

    worksheet.getColumn(1).numFmt = "dd/mm/yyyy";
    worksheet.getColumn(3).numFmt = "hh:mm";
    worksheet.getColumn(6).numFmt = "0";
    worksheet.getColumn(24).numFmt = "dd/mm/yyyy hh:mm";
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      row.eachCell((cell, columnNumber) => {
        cell.alignment = {
          vertical: "top",
          horizontal:
            columnNumber === 1 || columnNumber === 3 || columnNumber === 6
              ? "center"
              : "left",
          wrapText: true,
        };
      });
    });
  });

  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
}
