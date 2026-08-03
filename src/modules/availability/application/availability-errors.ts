export type AvailabilityApplicationErrorCode = "NOT_FOUND" | "VALIDATION";

export class AvailabilityApplicationError extends Error {
  constructor(
    readonly code: AvailabilityApplicationErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "AvailabilityApplicationError";
  }
}
