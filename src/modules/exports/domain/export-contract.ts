import { z } from "zod";
import { isLocalDate } from "@/modules/configuration/domain/operational-time";
import { EXCEL_MAX_RESERVATIONS, PDF_MAX_RESERVATIONS, compareExportTables, type ExportAssignmentDto } from "@/modules/exports/domain/export-domain";

export const EXPORT_PREVIEW_ROOMS = [
  { key: "UNASSIGNED", code: null, label: "DA ASSEGNARE", legacy: false },
  { key: "SALA_1", code: "sala-1", label: "Sala 1", legacy: false },
  { key: "SALA_2", code: "sala-2", label: "Sala 2", legacy: false },
  { key: "SALA_3", code: "sala-3", label: "Sala 3 — Giochi", legacy: false },
  { key: "GALLERIA", code: "galleria", label: "Galleria — Area legacy", legacy: true },
  { key: "TERRAZZO", code: "terrazzo", label: "Terrazzo — Area legacy", legacy: true },
] as const;
export type ExportPreviewRoom = (typeof EXPORT_PREVIEW_ROOMS)[number]["key"];
const roomKeys = ["UNASSIGNED", "SALA_1", "SALA_2", "SALA_3", "GALLERIA", "TERRAZZO"] as const;
export const exportPreviewRequestSchema = z.object({
  version: z.literal(2), target: z.enum(["PDF", "EXCEL"]),
  period: z.object({ mode: z.literal("DAY"), date: z.string().refine(isLocalDate) }).strict(),
  service: z.enum(["LUNCH", "DINNER"]), room: z.enum(["ALL", ...roomKeys]),
  order: z.enum(["CREATED_ASC", "NAME_ASC", "ARRIVAL_ASC"]),
}).strict();
export type ExportPreviewRequest = z.infer<typeof exportPreviewRequestSchema>;
const summarySchema = z.object({
  reservationCount: z.number().int().nonnegative(), partySizeTotal: z.number().int().nonnegative(),
  knownCompositionCount: z.number().int().nonnegative(), unknownCompositionCount: z.number().int().nonnegative(),
  knownAdultsTotal: z.number().int().nonnegative(), knownChildrenTotal: z.number().int().nonnegative(),
}).strict();
const actualRoomSchema = z.object({ key: z.enum(roomKeys), label: z.string(), legacy: z.boolean() }).strict();
const rowSchema = z.object({
  ordinal: z.number().int().positive(), localDate: z.string().refine(isLocalDate),
  serviceType: z.enum(["LUNCH", "DINNER"]), arrivalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  customerFirstName: z.string(), customerLastName: z.string(), partySize: z.number().int().positive(),
  childrenCount: z.number().int().nonnegative().nullable(), adultsCount: z.number().int().nonnegative().nullable(),
  legacyChildren: z.boolean(), gameRoomPreference: z.boolean().nullable(), preferredRoom: z.string(),
  assignmentState: z.enum(["UNASSIGNED", "ROOM_ONLY", "ROOM_AND_TABLES"]),
  actualRoom: actualRoomSchema.nullable(), tableNames: z.array(z.string()).max(20),
  highChair: z.boolean(), stroller: z.boolean(), accessibility: z.boolean(), celiac: z.boolean(),
  allergies: z.string().nullable(), intolerances: z.string().nullable(), celebration: z.string().nullable(),
  animals: z.boolean(), notes: z.string().nullable(), createdAt: z.string().datetime(),
}).strict();
export const exportPreviewResponseSchema = z.object({
  contractVersion: z.literal(2), selection: exportPreviewRequestSchema, source: z.literal("POSTGRESQL"),
  readAt: z.string().datetime(), timezone: z.string(), restaurantName: z.string(),
  availableLegacyRooms: z.array(z.object({
    key: z.enum(["GALLERIA", "TERRAZZO"]), label: z.string(), legacy: z.literal(true),
  }).strict()).max(2),
  summary: summarySchema,
  groups: z.array(z.object({
    key: z.enum(roomKeys), label: z.string(), legacy: z.boolean(), summary: summarySchema,
    rows: z.array(rowSchema).max(EXCEL_MAX_RESERVATIONS),
  }).strict()).max(6),
}).strict();
export type ExportPreviewDto = z.infer<typeof exportPreviewResponseSchema>;
export type ExportPreviewRow = z.infer<typeof rowSchema>;
export type ExportPreviewSummary = z.infer<typeof summarySchema>;
export class ExportPreviewDataError extends Error {
  constructor() { super("Export data is inconsistent."); this.name = "ExportPreviewDataError"; }
}
export interface ExportPreviewReservation {
  id: string; localDate: string; serviceType: "LUNCH" | "DINNER"; arrivalTime: string;
  customerFirstName: string; customerLastName: string; partySize: number;
  childrenCount: number | null; gameRoomPreference: boolean | null; legacyChildren: boolean;
  preferredRoom: string; highChair: boolean; stroller: boolean; accessibility: boolean; celiac: boolean;
  allergies: string | null; intolerances: string | null; celebration: string | null; animals: boolean;
  notes: string | null; createdAt: Date; assignment: ExportAssignmentDto | null;
}
export interface ExportPreviewSnapshot {
  restaurantName: string; timezone: string; reservations: ExportPreviewReservation[];
  availableLegacyRooms: Array<"GALLERIA" | "TERRAZZO">;
}
export const previewReservationLimit = (target: ExportPreviewRequest["target"]) =>
  target === "PDF" ? PDF_MAX_RESERVATIONS : EXCEL_MAX_RESERVATIONS;
export function previewRoomForCode(code: string | null) {
  const room = EXPORT_PREVIEW_ROOMS.find(item => item.code === code);
  if (!room) throw new ExportPreviewDataError();
  return room;
}
const collator = new Intl.Collator("it", { usage: "sort", sensitivity: "base", numeric: false });
function exactCompare(a: string, b: string): number {
  const left = a.normalize("NFC"), right = b.normalize("NFC");
  return left < right ? -1 : left > right ? 1 : 0;
}
export function comparePreviewReservations(left: ExportPreviewReservation, right: ExportPreviewReservation, order: ExportPreviewRequest["order"]): number {
  let primary = 0;
  if (order === "NAME_ASC") primary = collator.compare(left.customerLastName, right.customerLastName)
    || collator.compare(left.customerFirstName, right.customerFirstName)
    || exactCompare(left.customerLastName, right.customerLastName) || exactCompare(left.customerFirstName, right.customerFirstName);
  else if (order === "ARRIVAL_ASC") primary = exactCompare(left.arrivalTime, right.arrivalTime);
  return primary || left.createdAt.getTime() - right.createdAt.getTime() || exactCompare(left.id, right.id);
}
function summarize(rows: readonly ExportPreviewRow[]): ExportPreviewSummary {
  return {
    reservationCount: rows.length, partySizeTotal: rows.reduce((sum, row) => sum + row.partySize, 0),
    knownCompositionCount: rows.filter(row => row.childrenCount !== null).length,
    unknownCompositionCount: rows.filter(row => row.childrenCount === null).length,
    knownAdultsTotal: rows.reduce((sum, row) => sum + (row.adultsCount ?? 0), 0),
    knownChildrenTotal: rows.reduce((sum, row) => sum + (row.childrenCount ?? 0), 0),
  };
}
function projectRow(row: ExportPreviewReservation, ordinal: number): ExportPreviewRow {
  if (!Number.isInteger(row.partySize) || row.partySize < 1
    || row.childrenCount !== null && (!Number.isInteger(row.childrenCount) || row.childrenCount < 0 || row.childrenCount > row.partySize)
    || row.childrenCount === null && row.gameRoomPreference !== null
    || row.childrenCount === 0 && row.gameRoomPreference !== null
    || row.childrenCount !== null && row.childrenCount > 0 && typeof row.gameRoomPreference !== "boolean"
    || !Number.isFinite(row.createdAt.getTime())) throw new ExportPreviewDataError();
  const room = previewRoomForCode(row.assignment?.roomCode ?? null);
  if (row.assignment && row.assignment.tables.length > 20) throw new ExportPreviewDataError();
  // Positive projection: extra runtime properties, NI and identifiers cannot enter the wire DTO.
  return {
    ordinal, localDate: row.localDate, serviceType: row.serviceType, arrivalTime: row.arrivalTime,
    customerFirstName: row.customerFirstName, customerLastName: row.customerLastName,
    partySize: row.partySize, childrenCount: row.childrenCount,
    adultsCount: row.childrenCount === null ? null : row.partySize - row.childrenCount,
    legacyChildren: row.legacyChildren, gameRoomPreference: row.gameRoomPreference, preferredRoom: row.preferredRoom,
    assignmentState: !row.assignment ? "UNASSIGNED" : row.assignment.tables.length ? "ROOM_AND_TABLES" : "ROOM_ONLY",
    actualRoom: row.assignment ? { key: room.key, label: room.label, legacy: room.legacy } : null,
    tableNames: row.assignment ? [...row.assignment.tables].sort(compareExportTables).map(table => table.name) : [],
    highChair: row.highChair, stroller: row.stroller, accessibility: row.accessibility, celiac: row.celiac,
    allergies: row.allergies, intolerances: row.intolerances, celebration: row.celebration,
    animals: row.animals, notes: row.notes, createdAt: row.createdAt.toISOString(),
  };
}
export function buildExportPreview(input: { selection: ExportPreviewRequest; snapshot: ExportPreviewSnapshot; readAt: Date }): ExportPreviewDto {
  const { selection, snapshot } = input;
  const buckets = new Map<ExportPreviewRoom, ExportPreviewReservation[]>();
  for (const row of snapshot.reservations) {
    const key = previewRoomForCode(row.assignment?.roomCode ?? null).key;
    if (row.localDate !== selection.period.date || row.serviceType !== selection.service
      || selection.room !== "ALL" && key !== selection.room) throw new ExportPreviewDataError();
    const bucket = buckets.get(key) ?? []; bucket.push(row); buckets.set(key, bucket);
  }
  const legacy = EXPORT_PREVIEW_ROOMS.filter(room => room.legacy && snapshot.availableLegacyRooms.some(key => key === room.key));
  let ordinal = 0;
  const groups = EXPORT_PREVIEW_ROOMS
    .filter(room => selection.room === "ALL" ? !room.legacy || legacy.some(item => item.key === room.key) : room.key === selection.room)
    .map(room => {
      const rows = [...(buckets.get(room.key) ?? [])].sort((a, b) => comparePreviewReservations(a, b, selection.order)).map(row => projectRow(row, ++ordinal));
      return { key: room.key, label: room.label, legacy: room.legacy, summary: summarize(rows), rows };
    });
  if (groups.reduce((sum, group) => sum + group.rows.length, 0) !== snapshot.reservations.length) throw new ExportPreviewDataError();
  return {
    contractVersion: 2,
    selection: { version: 2, target: selection.target, period: { mode: "DAY", date: selection.period.date }, service: selection.service, room: selection.room, order: selection.order },
    source: "POSTGRESQL", readAt: input.readAt.toISOString(), timezone: snapshot.timezone, restaurantName: snapshot.restaurantName,
    availableLegacyRooms: legacy.map(room => ({ key: room.key as "GALLERIA" | "TERRAZZO", label: room.label, legacy: true as const })),
    summary: summarize(groups.flatMap(group => group.rows)), groups,
  };
}
