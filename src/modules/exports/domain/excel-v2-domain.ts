import { z } from "zod";
import { exportPreviewRequestSchema, type ExportPreviewDto, type ExportPreviewSummary } from "@/modules/exports/domain/export-contract";

export const excelV2RequestSchema = exportPreviewRequestSchema.extend({ target: z.literal("EXCEL") }).strict();
export type ExcelV2Request = z.infer<typeof excelV2RequestSchema>;
export const EXCEL_V2_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const EXCEL_V2_HEADERS = ["Ordine", "Sala effettiva", "Arrivo", "Cognome", "Nome", "Coperti", "Adulti", "Bambini", "Composizione", "Giochi", "Preferenza sala (storica)", "Esigenze/richieste", "Note cliente NC", "Prenotata il"] as const;
export class ExcelV2DataError extends Error {
  constructor() { super("EXCEL_V2_DATA_NOT_REPRESENTABLE"); }
}
export interface ExcelV2Row {
  ordinal: number; room: string; arrival: string; lastName: string; firstName: string;
  partySize: number; adultsCount: number | null; childrenCount: number | null;
  composition: string; games: string; preferredRoom: string; requests: string;
  notes: string | null; createdAt: string;
}
export interface ExcelV2Document {
  selection: ExcelV2Request; restaurantName: string; timezone: string; readAt: string;
  summary: ExportPreviewSummary; rows: ExcelV2Row[];
}
export function buildExcelV2Document(preview: ExportPreviewDto): ExcelV2Document {
  const s = preview.summary;
  return {
    selection: excelV2RequestSchema.parse(preview.selection), restaurantName: preview.restaurantName,
    timezone: preview.timezone, readAt: preview.readAt,
    summary: { reservationCount: s.reservationCount, partySizeTotal: s.partySizeTotal,
      knownCompositionCount: s.knownCompositionCount, unknownCompositionCount: s.unknownCompositionCount,
      knownAdultsTotal: s.knownAdultsTotal, knownChildrenTotal: s.knownChildrenTotal },
    // T09 owns grouping, ordinals and all comparators. No renderer sorting.
    rows: preview.groups.flatMap(group => group.rows.map(row => ({
      ordinal: row.ordinal, room: row.actualRoom?.label ?? "DA ASSEGNARE", arrival: row.arrivalTime,
      lastName: row.customerLastName, firstName: row.customerFirstName, partySize: row.partySize,
      adultsCount: row.adultsCount, childrenCount: row.childrenCount,
      composition: row.childrenCount === null ? row.legacyChildren ? "UNKNOWN — bambini segnalati senza conteggio" : "UNKNOWN — composizione non dichiarata"
        : row.childrenCount === 0 ? "TA" : "DECLARED",
      games: row.gameRoomPreference === true ? "Richiesti — non garantiti" : row.gameRoomPreference === false ? "Non richiesti" : "Non dichiarati",
      preferredRoom: row.preferredRoom,
      requests: [row.highChair ? "Seggiolone" : null, row.stroller ? "Passeggino" : null,
        row.accessibility ? "Accessibilità" : null, row.celiac ? "Celiachia dichiarata" : null,
        row.allergies ? `Allergie: ${row.allergies}` : null, row.intolerances ? `Intolleranze: ${row.intolerances}` : null,
        row.celebration ? `Ricorrenza: ${row.celebration}` : null, row.animals ? "Animali" : null,
      ].filter((v): v is string => v !== null).join("\n"),
      notes: row.notes, createdAt: row.createdAt,
    }))),
  };
}
export function excelV2Filename(selection: ExcelV2Request): string {
  const v = excelV2RequestSchema.parse(selection);
  return `piccadilly-operativo-v2-${v.period.date}-${v.service.toLowerCase()}-${v.room.toLowerCase().replaceAll("_", "-")}-${v.order.toLowerCase().replaceAll("_", "-")}.xlsx`;
}
