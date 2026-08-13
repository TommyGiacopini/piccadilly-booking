export type PublicSettingsErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "STATE_CHANGED"
  | "INCOMPLETE"
  | "INTERNAL";

export class PublicSettingsError extends Error {
  constructor(
    readonly code: PublicSettingsErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "PublicSettingsError";
  }
}
