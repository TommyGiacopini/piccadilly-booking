export type ReservationAssignmentErrorCode =
  | "VALIDATION"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "RESERVATION_CANCELLED"
  | "ROOM_UNAVAILABLE"
  | "INVARIANT";

export class ReservationAssignmentError extends Error {
  constructor(
    readonly code: ReservationAssignmentErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ReservationAssignmentError";
  }
}

export function reservationAssignmentErrorStatus(
  code: ReservationAssignmentErrorCode,
): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "VERSION_CONFLICT":
    case "RESERVATION_CANCELLED":
    case "ROOM_UNAVAILABLE":
      return 409;
    case "INVARIANT":
      return 500;
  }
}
