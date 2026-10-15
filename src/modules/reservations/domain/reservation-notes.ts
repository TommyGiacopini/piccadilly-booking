import { z } from "zod";

export const MAX_PRIVATE_NOTES_CODE_POINTS = 1_000;

export function normalizePrivateNotes(value: string | null): string | null {
  return value === "" ? null : value;
}

export function privateNotesCodePointLength(value: string): number {
  return [...value].length;
}

export const reservationPrivateNotesInputSchema = z.strictObject({
  version: z.number().int().positive(),
  privateNotes: z.string().refine(
    (value) => value.isWellFormed() && !value.includes("\u0000") &&
      privateNotesCodePointLength(value) <= MAX_PRIVATE_NOTES_CODE_POINTS,
    "La nota interna deve contenere al massimo 1000 caratteri Unicode validi.",
  ).nullable().transform(normalizePrivateNotes),
});

export function privateNotesAuditSnapshot(notes: string | null, version: number) {
  return { privateNotes: { present: normalizePrivateNotes(notes) !== null }, version };
}

export interface ReservationPrivateNotesContext {
  reservation: {
    id: string;
    version: number;
    status: "CONFIRMED" | "CANCELLED";
    notes: string | null;
  };
  privateNotes: string | null;
  privateNotesPresent: boolean;
  legacyAssignment: {
    internalNotes: string | null;
    internalNotesPresent: boolean;
    state: "ACTIVE" | "CLEARED";
  } | null;
}
