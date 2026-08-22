import { z } from "zod";

export const MAX_RESERVATION_ASSIGNMENT_TABLES = 20;
export const MAX_RESERVATION_ASSIGNMENT_NOTES_CODE_POINTS = 1_000;
export const RESERVATION_SCHEDULE_CHANGED_REASON =
  "RESERVATION_SCHEDULE_CHANGED" as const;

const positiveVersionSchema = z
  .number()
  .int("La versione deve essere un numero intero.")
  .positive("La versione deve essere positiva.");
const uuidSchema = z.uuid("Identificativo non valido.");
const internalNotesSchema = z
  .string()
  .refine(
    (value) =>
      [...value].length <= MAX_RESERVATION_ASSIGNMENT_NOTES_CODE_POINTS,
    `Le note interne non possono superare ${MAX_RESERVATION_ASSIGNMENT_NOTES_CODE_POINTS} caratteri.`,
  )
  .nullable()
  .optional()
  .transform((value) => (value === undefined || value === "" ? null : value));

export function sortAssignmentTableIds(
  tableIds: readonly string[],
): string[] {
  return [...tableIds].sort((left, right) => left.localeCompare(right));
}

export function assignmentTableIdsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = sortAssignmentTableIds(left);
  const normalizedRight = sortAssignmentTableIds(right);

  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

export const putReservationAssignmentSchema = z
  .strictObject({
    version: positiveVersionSchema,
    roomId: uuidSchema,
    tableIds: z
      .array(uuidSchema)
      .min(1, "È richiesto almeno un tavolo.")
      .max(
        MAX_RESERVATION_ASSIGNMENT_TABLES,
        `Non è possibile assegnare più di ${MAX_RESERVATION_ASSIGNMENT_TABLES} tavoli.`,
      ),
    internalNotes: internalNotesSchema,
  })
  .superRefine((value, context) => {
    if (new Set(value.tableIds).size !== value.tableIds.length) {
      context.addIssue({
        code: "custom",
        message: "I tavoli devono essere distinti.",
        path: ["tableIds"],
      });
    }
  })
  .transform((value) => ({
    ...value,
    tableIds: sortAssignmentTableIds(value.tableIds),
  }));

export const deleteReservationAssignmentSchema = z.strictObject({
  version: positiveVersionSchema,
});

export type PutReservationAssignmentInput = z.output<
  typeof putReservationAssignmentSchema
>;
export type DeleteReservationAssignmentInput = z.output<
  typeof deleteReservationAssignmentSchema
>;

export interface AssignmentAuditValue
  extends Record<string, string | string[] | number | boolean> {
  finalRoomCode: string;
  tableIds: string[];
  tableCount: number;
  internalNotesPresent: boolean;
}

export interface AssignmentAuditSnapshot
  extends Record<
    string,
    AssignmentAuditValue | null | typeof RESERVATION_SCHEDULE_CHANGED_REASON
  > {
  assignment: AssignmentAuditValue | null;
}

export interface ScheduleChangedAssignmentAuditSnapshot
  extends AssignmentAuditSnapshot {
  reason: typeof RESERVATION_SCHEDULE_CHANGED_REASON;
}

export function reservationAssignmentAuditSnapshot(
  assignment:
    | {
        finalRoomCode: string;
        tableIds: readonly string[];
        internalNotes: string | null;
      }
    | null,
): AssignmentAuditSnapshot {
  if (!assignment) return { assignment: null };

  const tableIds = sortAssignmentTableIds(assignment.tableIds);
  return {
    assignment: {
      finalRoomCode: assignment.finalRoomCode,
      tableIds,
      tableCount: tableIds.length,
      internalNotesPresent: assignment.internalNotes !== null,
    },
  };
}

export function reservationScheduleChangedAuditSnapshot(
  assignment:
    | {
        finalRoomCode: string;
        tableIds: readonly string[];
        internalNotes: string | null;
      }
    | null,
): ScheduleChangedAssignmentAuditSnapshot {
  return {
    ...reservationAssignmentAuditSnapshot(assignment),
    reason: RESERVATION_SCHEDULE_CHANGED_REASON,
  };
}

export function reservationAssignmentStatesEqual(
  current: {
    roomId: string;
    tableIds: readonly string[];
    internalNotes: string | null;
  },
  requested: Pick<
    PutReservationAssignmentInput,
    "roomId" | "tableIds" | "internalNotes"
  >,
): boolean {
  return (
    current.roomId === requested.roomId &&
    current.internalNotes === requested.internalNotes &&
    assignmentTableIdsEqual(current.tableIds, requested.tableIds)
  );
}

export interface AssignmentTableDto {
  id: string;
  name: string;
  minimumSeats: number;
  maximumSeats: number;
  displayOrder: number;
  isActive: boolean;
}

export interface AssignmentRoomDto {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  isActive: boolean;
  isAvailableForService: boolean | null;
  tables: AssignmentTableDto[];
}

export interface ActiveReservationAssignmentDto {
  id: string;
  room: Omit<AssignmentRoomDto, "tables">;
  tables: AssignmentTableDto[];
  internalNotes: string | null;
  createdAt: string;
  updatedAt: string;
  hasInactiveReferences: boolean;
  hasUnavailableRoomReference: boolean;
}

export interface ReservationAssignmentContextDto {
  reservation: {
    id: string;
    version: number;
    status: "CONFIRMED" | "CANCELLED";
    localDate: string;
    serviceType: "LUNCH" | "DINNER";
    arrivalTime: string;
    isHistorical: boolean;
    originalRoomPreference: {
      roomCode: string | null;
      roomName: string | null;
      isActive: boolean | null;
      legacyPreferencePresent: boolean;
    };
  };
  assignment: ActiveReservationAssignmentDto | null;
  rooms: AssignmentRoomDto[];
}
