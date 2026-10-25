import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MAX_RESERVATION_ASSIGNMENT_TABLES,
  assignmentTableIdsEqual,
  deleteReservationAssignmentSchema,
  putReservationAssignmentSchema,
  reservationAssignmentAuditSnapshot,
  reservationAssignmentStatesEqual,
} from "@/modules/rooms/domain/reservation-assignment";

function validPut(overrides: Record<string, unknown> = {}) {
  return {
    version: 3,
    roomId: randomUUID(),
    tableIds: [randomUUID()],
    internalNotes: "Nota interna fittizia",
    ...overrides,
  };
}

describe("reservation assignment domain", () => {
  it("counts Unicode code points without splitting emoji", () => {
    const within = "😀".repeat(1_000);
    const outside = `${within}😀`;

    expect(
      putReservationAssignmentSchema.safeParse(
        validPut({ internalNotes: within }),
      ).success,
    ).toBe(true);
    expect(
      putReservationAssignmentSchema.safeParse(
        validPut({ internalNotes: outside }),
      ).success,
    ).toBe(false);
  });

  it("uses strict payloads, positive versions and the documented table limit", () => {
    expect(
      putReservationAssignmentSchema.safeParse(
        validPut({ restaurantId: randomUUID() }),
      ).success,
    ).toBe(false);
    expect(
      putReservationAssignmentSchema.safeParse(validPut({ version: 0 }))
        .success,
    ).toBe(false);
    expect(
      putReservationAssignmentSchema.safeParse(
        validPut({
          tableIds: Array.from(
            { length: MAX_RESERVATION_ASSIGNMENT_TABLES + 1 },
            () => randomUUID(),
          ),
        }),
      ).success,
    ).toBe(false);
    expect(
      deleteReservationAssignmentSchema.safeParse({
        version: 1,
        actorId: randomUUID(),
      }).success,
    ).toBe(false);
  });

  it("allows zero to twenty distinct tables and normalizes order", () => {
    const first = randomUUID();
    const second = randomUUID();

    expect(
      putReservationAssignmentSchema.safeParse(validPut({ tableIds: [] }))
        .success,
    ).toBe(true);
    expect(putReservationAssignmentSchema.safeParse(validPut({ tableIds: Array.from({ length: 20 }, () => randomUUID()) })).success).toBe(true);
    expect(putReservationAssignmentSchema.safeParse(validPut({ roomId: null, tableIds: [] })).success).toBe(false);
    expect(putReservationAssignmentSchema.safeParse(validPut({ tableIds: ["invalid"] })).success).toBe(false);
    expect(
      putReservationAssignmentSchema.safeParse(
        validPut({ tableIds: [first, first] }),
      ).success,
    ).toBe(false);

    const parsed = putReservationAssignmentSchema.parse(
      validPut({ tableIds: [second, first] }),
    );
    expect(parsed.tableIds).toEqual(
      [first, second].sort((left, right) => left.localeCompare(right)),
    );
    expect(assignmentTableIdsEqual([first, second], [second, first])).toBe(
      true,
    );
  });

  describe("T08-SEC01 bounded array validation", () => {
    const base = {
      version: 3,
      roomId: "00000000-0000-4000-8000-0000000000ff",
      internalNotes: null,
    };
    const tableId = (index: number) =>
      `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    const sizeIssue = {
      origin: "array",
      code: "too_big",
      maximum: 20,
      inclusive: true,
      path: ["tableIds"],
      message: "Non è possibile assegnare più di 20 tavoli.",
    };

    it("accepts twenty distinct valid UUIDs without changing the business limit", () => {
      expect(MAX_RESERVATION_ASSIGNMENT_TABLES).toBe(20);
      const tableIds = Array.from({ length: 20 }, (_, index) => tableId(index + 1));
      const result = putReservationAssignmentSchema.safeParse({ ...base, tableIds });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.tableIds).toEqual(tableIds);
    });

    it("rejects twenty-one valid UUIDs with the canonical size error", () => {
      const result = putReservationAssignmentSchema.safeParse({
        ...base,
        tableIds: Array.from({ length: 21 }, (_, index) => tableId(index + 1)),
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toEqual([sizeIssue]);
    });

    it("rejects an oversized malformed array before accumulating element errors", () => {
      const result = putReservationAssignmentSchema.safeParse({
        ...base,
        tableIds: Array.from({ length: 21 }, (_, index) => `invalid-uuid-${index}`),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(1);
        expect(result.error.issues).toEqual([sizeIssue]);
        expect(result.error.issues.some((issue) => issue.code === "invalid_format")).toBe(false);
      }
    });

    it("still validates each UUID when the array is within the limit", () => {
      const result = putReservationAssignmentSchema.safeParse({
        ...base,
        tableIds: Array.from({ length: 20 }, (_, index) => `invalid-uuid-${index}`),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toHaveLength(20);
        result.error.issues.forEach((issue, index) => {
          expect(issue).toMatchObject({
            code: "invalid_format",
            path: ["tableIds", index],
            message: "Identificativo non valido.",
          });
        });
      }
    });
  });

  it("normalizes omitted, null and empty internal notes to the same state", () => {
    const { internalNotes: ignoredNotes, ...withoutNotes } = validPut();
    expect(ignoredNotes).toBe("Nota interna fittizia");

    expect(
      putReservationAssignmentSchema.parse(withoutNotes).internalNotes,
    ).toBeNull();
    expect(
      putReservationAssignmentSchema.parse(
        validPut({ internalNotes: null }),
      ).internalNotes,
    ).toBeNull();
    expect(
      putReservationAssignmentSchema.parse(
        validPut({ internalNotes: "" }),
      ).internalNotes,
    ).toBeNull();
  });

  it("builds a minimized deterministic audit snapshot without note text", () => {
    const first = randomUUID();
    const second = randomUUID();
    const snapshot = reservationAssignmentAuditSnapshot({
      finalRoomCode: "sala-1",
      tableIds: [second, first],
      internalNotes: "Testo segreto fittizio da non copiare",
    });

    expect(snapshot).toEqual({
      assignment: {
        finalRoomCode: "sala-1",
        tableIds: [first, second].sort((left, right) =>
          left.localeCompare(right),
        ),
        tableCount: 2,
        internalNotesPresent: true,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(
      "Testo segreto fittizio da non copiare",
    );
    expect(reservationAssignmentAuditSnapshot(null)).toEqual({
      assignment: null,
    });
  });

  it("preserves room-only audit and equality including notes", () => {
    const roomId = randomUUID();
    const current = { roomId, tableIds: [], internalNotes: null };
    expect(reservationAssignmentAuditSnapshot({ finalRoomCode: "sala-1", tableIds: [], internalNotes: null })).toEqual({ assignment: { finalRoomCode: "sala-1", tableIds: [], tableCount: 0, internalNotesPresent: false } });
    expect(reservationAssignmentStatesEqual(current, current)).toBe(true);
    expect(reservationAssignmentStatesEqual(current, { ...current, internalNotes: "Nota sintetica" })).toBe(false);
    expect(reservationAssignmentStatesEqual(current, { ...current, tableIds: [randomUUID()] })).toBe(false);
  });
});
