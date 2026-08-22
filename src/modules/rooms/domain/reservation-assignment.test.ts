import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MAX_RESERVATION_ASSIGNMENT_TABLES,
  assignmentTableIdsEqual,
  deleteReservationAssignmentSchema,
  putReservationAssignmentSchema,
  reservationAssignmentAuditSnapshot,
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

  it("requires at least one distinct table and normalizes order", () => {
    const first = randomUUID();
    const second = randomUUID();

    expect(
      putReservationAssignmentSchema.safeParse(validPut({ tableIds: [] }))
        .success,
    ).toBe(false);
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
});
