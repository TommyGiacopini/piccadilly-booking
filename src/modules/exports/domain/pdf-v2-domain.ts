import { z } from "zod";
import {
  exportPreviewRequestSchema,
  type ExportPreviewDto,
  type ExportPreviewRow,
  type ExportPreviewSummary,
} from "@/modules/exports/domain/export-contract";

export const pdfV2RequestSchema = exportPreviewRequestSchema.extend({ target: z.literal("PDF") }).strict();
export type PdfV2Request = z.infer<typeof pdfV2RequestSchema>;

export interface PdfV2Row {
  ordinal: number;
  name: string;
  partySize: number;
  composition: string[];
  room: string;
  arrival: string;
  requests: string[];
  notes: string | null;
  createdDate: string;
  createdTime: string;
}

export interface PdfV2Document {
  selection: PdfV2Request;
  restaurantName: string;
  timezone: string;
  readAt: string;
  summary: ExportPreviewSummary;
  groups: Array<{
    key: string;
    label: string;
    summary: ExportPreviewSummary;
    rows: PdfV2Row[];
  }>;
}

function summary(value: ExportPreviewSummary): ExportPreviewSummary {
  return {
    reservationCount: value.reservationCount, partySizeTotal: value.partySizeTotal,
    knownCompositionCount: value.knownCompositionCount, unknownCompositionCount: value.unknownCompositionCount,
    knownAdultsTotal: value.knownAdultsTotal, knownChildrenTotal: value.knownChildrenTotal,
  };
}

export function pdfV2LocalInstant(value: string, timezone: string): { date: string; time: string } {
  const parts = new Map(new Intl.DateTimeFormat("it-IT", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return { date: `${parts.get("day")}/${parts.get("month")}/${parts.get("year")}`, time: `${parts.get("hour")}:${parts.get("minute")}` };
}

function projectRow(row: ExportPreviewRow, timezone: string): PdfV2Row {
  const created = pdfV2LocalInstant(row.createdAt, timezone);
  const requests = [
    row.childrenCount === null ? "Composizione non specificata" : null,
    row.childrenCount === null && row.legacyChildren ? "Bambini segnalati senza conteggio" : null,
    row.gameRoomPreference === true ? "Giochi richiesti - non garantiti" : row.gameRoomPreference === false ? "Giochi non richiesti" : null,
    row.preferredRoom !== "Non indicata" ? `Preferenza storica: ${row.preferredRoom}` : null,
    row.highChair ? "Seggiolone" : null, row.stroller ? "Passeggino" : null,
    row.accessibility ? "Accessibilità" : null, row.celiac ? "Celiachia dichiarata" : null,
    row.allergies ? `Allergie: ${row.allergies}` : null,
    row.intolerances ? `Intolleranze: ${row.intolerances}` : null,
    row.celebration ? `Ricorrenza: ${row.celebration}` : null, row.animals ? "Animali" : null,
  ].filter((value): value is string => value !== null);
  // Controller C03: digital tables never enter the PDF document model.
  return {
    ordinal: row.ordinal, name: `${row.customerFirstName} ${row.customerLastName}`,
    partySize: row.partySize,
    composition: row.childrenCount === null ? ["A ?", "B ?"]
      : row.childrenCount === 0 ? ["TA"] : [`${row.adultsCount} A`, `${row.childrenCount} B`],
    room: row.actualRoom?.label ?? "DA ASSEGNARE", arrival: row.arrivalTime,
    requests, notes: row.notes, createdDate: created.date, createdTime: created.time,
  };
}

export function buildPdfV2Document(preview: ExportPreviewDto): PdfV2Document {
  const selection = pdfV2RequestSchema.parse(preview.selection);
  return {
    selection, restaurantName: preview.restaurantName, timezone: preview.timezone, readAt: preview.readAt,
    summary: summary(preview.summary),
    groups: preview.groups.map(group => ({
      key: group.key, label: group.label, summary: summary(group.summary),
      rows: group.rows.map(row => projectRow(row, preview.timezone)),
    })),
  };
}

export function pdfV2Filename(selection: PdfV2Request): string {
  const value = pdfV2RequestSchema.parse(selection);
  return `piccadilly-operativo-v2-${value.period.date}-${value.service.toLowerCase()}-${value.room.toLowerCase().replaceAll("_", "-")}-${value.order.toLowerCase().replaceAll("_", "-")}.pdf`;
}

export function pdfV2OrderLabel(order: PdfV2Request["order"]): string {
  return order === "CREATED_ASC" ? "creazione crescente" : order === "NAME_ASC" ? "cognome/nome A-Z" : "ora di arrivo";
}
