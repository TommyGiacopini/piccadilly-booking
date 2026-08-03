export type ReservationErrorCode =
  | "VALIDATION"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "CAPACITY_EXCEEDED"
  | "SERVICE_CLOSED"
  | "SLOT_NOT_AVAILABLE"
  | "SLOT_IN_PAST"
  | "CONFIGURATION_INVALID";

export class ReservationApplicationError extends Error {
  constructor(
    readonly code: ReservationErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ReservationApplicationError";
  }
}

export function reservationErrorStatus(code: ReservationErrorCode): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "CAPACITY_EXCEEDED":
      return 409;
    case "SERVICE_CLOSED":
    case "SLOT_NOT_AVAILABLE":
    case "SLOT_IN_PAST":
    case "CONFIGURATION_INVALID":
      return 422;
  }
}
