export class RoomAvailabilityError extends Error {
  constructor(
    readonly code:
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "VALIDATION"
      | "HISTORICAL"
      | "INVARIANT"
      | "IMPACT_CHANGED",
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "RoomAvailabilityError";
  }
}
