export type ConfigurationErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "DUPLICATE"
  | "IMPACT_CHANGED"
  | "INTERNAL";

export class ConfigurationError extends Error {
  constructor(
    readonly code: ConfigurationErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ConfigurationError";
  }
}
