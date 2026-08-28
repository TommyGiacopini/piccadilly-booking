import { z } from "zod";

import { isLocalDate } from "@/modules/configuration/domain/operational-time";

export const EXPORT_MAX_RANGE_DAYS = 31;
export const PDF_MAX_RESERVATIONS = 2_000;
export const EXCEL_MAX_RESERVATIONS = 20_000;
export const EXPORT_MAX_BUFFER_BYTES = 25 * 1024 * 1024;

export const EXPORT_SECTION_DEFINITIONS = [
  { key: "UNASSIGNED", roomCode: null, label: "DA ASSEGNARE", rank: 0 },
  { key: "SALA_1", roomCode: "sala-1", label: "Sala 1", rank: 1 },
  { key: "SALA_2", roomCode: "sala-2", label: "Sala 2", rank: 2 },
  { key: "SALA_3", roomCode: "sala-3", label: "Sala 3", rank: 3 },
  { key: "GALLERIA", roomCode: "galleria", label: "Galleria", rank: 4 },
  { key: "TERRAZZO", roomCode: "terrazzo", label: "Terrazzo", rank: 5 },
] as const;

export type ExportSectionKey =
  (typeof EXPORT_SECTION_DEFINITIONS)[number]["key"];
export type ExportMode = "DAY" | "MONTH" | "RANGE";
export type ExportFormat = "PDF" | "EXCEL";

export interface ExportTableDto {
  id: string;
  name: string;
  displayOrder: number;
}

export interface ExportAssignmentDto {
  roomCode: string;
  roomName: string;
  tables: ExportTableDto[];
  internalNotes: string | null;
}

export interface ExportReservationDto {
  id: string;
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  customerFirstName: string;
  customerLastName: string;
  partySize: number;
  customerPhone: string;
  origin: "PUBLIC" | "PHONE" | "STAFF";
  preferredRoom: string;
  highChair: boolean;
  stroller: boolean;
  accessibility: boolean;
  children: boolean;
  celiac: boolean;
  allergies: string | null;
  intolerances: string | null;
  celebration: string | null;
  animals: boolean;
  notes: string | null;
  createdAt: Date;
  assignment: ExportAssignmentDto | null;
}

export interface ExportSectionDto {
  key: ExportSectionKey;
  label: string;
  rank: number;
  reservations: ExportReservationDto[];
}

export interface ExportDayDto {
  localDate: string;
  sections: ExportSectionDto[];
}

export interface ExportSnapshotDto {
  restaurantName: string;
  timezone: string;
  fromDate: string;
  toDate: string;
  reservationCount: number;
  days: ExportDayDto[];
}

export interface ExportPeriod {
  mode: ExportMode;
  fromDate: string;
  toDate: string;
  dayCount: number;
  dates: string[];
}

export const pdfExportRequestSchema = z
  .object({ date: z.string().refine(isLocalDate) })
  .strict();

const dayExportRequestSchema = z
  .object({ mode: z.literal("DAY"), date: z.string().refine(isLocalDate) })
  .strict();

const monthValueSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}$/u.test(value)) return false;
  return isLocalDate(`${value}-01`);
});

const monthExportRequestSchema = z
  .object({ mode: z.literal("MONTH"), month: monthValueSchema })
  .strict();

const rangeExportRequestSchema = z
  .object({
    mode: z.literal("RANGE"),
    from: z.string().refine(isLocalDate),
    to: z.string().refine(isLocalDate),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from > value.to) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "La data finale deve essere uguale o successiva a quella iniziale.",
      });
    }
  });

export const excelExportRequestSchema = z.discriminatedUnion("mode", [
  dayExportRequestSchema,
  monthExportRequestSchema,
  rangeExportRequestSchema,
]);

export type PdfExportRequest = z.infer<typeof pdfExportRequestSchema>;
export type ExcelExportRequest = z.infer<typeof excelExportRequestSchema>;

export function shiftCalendarDate(localDate: string, days: number): string {
  if (!isLocalDate(localDate) || !Number.isInteger(days)) {
    throw new Error("Invalid export calendar shift.");
  }
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function enumerateCalendarDates(fromDate: string, toDate: string): string[] {
  if (!isLocalDate(fromDate) || !isLocalDate(toDate) || fromDate > toDate) {
    throw new Error("Invalid export calendar range.");
  }
  const dates: string[] = [];
  for (let current = fromDate; current <= toDate; current = shiftCalendarDate(current, 1)) {
    dates.push(current);
  }
  return dates;
}

export function resolvePdfExportPeriod(request: PdfExportRequest): ExportPeriod {
  return {
    mode: "DAY",
    fromDate: request.date,
    toDate: request.date,
    dayCount: 1,
    dates: [request.date],
  };
}

export function resolveExcelExportPeriod(request: ExcelExportRequest): ExportPeriod {
  if (request.mode === "DAY") {
    return {
      mode: request.mode,
      fromDate: request.date,
      toDate: request.date,
      dayCount: 1,
      dates: [request.date],
    };
  }
  if (request.mode === "MONTH") {
    const fromDate = `${request.month}-01`;
    const nextMonth = new Date(`${fromDate}T00:00:00.000Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const toDate = shiftCalendarDate(nextMonth.toISOString().slice(0, 10), -1);
    const dates = enumerateCalendarDates(fromDate, toDate);
    return { mode: request.mode, fromDate, toDate, dayCount: dates.length, dates };
  }
  const dates = enumerateCalendarDates(request.from, request.to);
  return {
    mode: request.mode,
    fromDate: request.from,
    toDate: request.to,
    dayCount: dates.length,
    dates,
  };
}

export function exportSectionFor(
  reservation: Pick<ExportReservationDto, "assignment">,
): (typeof EXPORT_SECTION_DEFINITIONS)[number] {
  if (!reservation.assignment) return EXPORT_SECTION_DEFINITIONS[0];
  const section = EXPORT_SECTION_DEFINITIONS.find(
    (candidate) => candidate.roomCode === reservation.assignment?.roomCode,
  );
  if (!section) throw new Error("Reservation assignment uses a non-canonical room.");
  return section;
}

export function compareExportReservations(
  left: ExportReservationDto,
  right: ExportReservationDto,
): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
}

export function compareExportTables(left: ExportTableDto, right: ExportTableDto): number {
  return (
    left.displayOrder - right.displayOrder ||
    left.name.localeCompare(right.name, "it") ||
    left.id.localeCompare(right.id)
  );
}

export function buildExportDays(
  dates: readonly string[],
  reservations: readonly ExportReservationDto[],
): ExportDayDto[] {
  const byDate = new Map<string, ExportReservationDto[]>();
  for (const date of dates) byDate.set(date, []);
  for (const reservation of reservations) {
    const bucket = byDate.get(reservation.localDate);
    if (!bucket) throw new Error("Export reservation is outside the requested period.");
    bucket.push({
      ...reservation,
      assignment: reservation.assignment
        ? {
            ...reservation.assignment,
            tables: [...reservation.assignment.tables].sort(compareExportTables),
          }
        : null,
    });
  }

  return dates.map((localDate) => ({
    localDate,
    sections: EXPORT_SECTION_DEFINITIONS.map((definition) => ({
      key: definition.key,
      label: definition.label,
      rank: definition.rank,
      reservations: (byDate.get(localDate) ?? [])
        .filter((reservation) => exportSectionFor(reservation).key === definition.key)
        .sort(compareExportReservations),
    })),
  }));
}

export function sanitizeSpreadsheetString(value: string): string {
  if (/^[\t\r\n]/u.test(value) || /^\s*[=+\-@]/u.test(value)) {
    return `'${value}`;
  }
  return value;
}

export function pdfExportFilename(date: string): string {
  if (!isLocalDate(date)) throw new Error("Invalid PDF filename date.");
  return `piccadilly-prenotazioni-${date}.pdf`;
}

export function excelExportFilename(request: ExcelExportRequest): string {
  if (request.mode === "DAY") {
    return `piccadilly-prenotazioni-${request.date}.xlsx`;
  }
  if (request.mode === "MONTH") {
    return `piccadilly-prenotazioni-${request.month}.xlsx`;
  }
  return `piccadilly-prenotazioni-${request.from}_${request.to}.xlsx`;
}

export function exportWorksheetName(localDate: string): string {
  if (!isLocalDate(localDate)) throw new Error("Invalid export worksheet date.");
  return localDate;
}

export type ExportFailureCode =
  | "GENERATION_FAILED"
  | "EXPORT_TOO_LARGE"
  | "EXPORT_RANGE_TOO_LARGE";

export function exportSuccessAuditMetadata(input: {
  format: ExportFormat;
  period: ExportPeriod;
  reservationCount: number;
}) {
  return {
    format: input.format,
    mode: input.period.mode,
    fromDate: input.period.fromDate,
    toDate: input.period.toDate,
    dayCount: input.period.dayCount,
    reservationCount: input.reservationCount,
  };
}

export function exportFailureAuditMetadata(input: {
  format: ExportFormat;
  period: ExportPeriod;
  failureCode: ExportFailureCode;
}) {
  return {
    format: input.format,
    mode: input.period.mode,
    fromDate: input.period.fromDate,
    toDate: input.period.toDate,
    dayCount: input.period.dayCount,
    failureCode: input.failureCode,
  };
}
