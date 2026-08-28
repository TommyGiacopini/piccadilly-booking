export type ExportApplicationErrorCode =
  | "FORBIDDEN"
  | "EXPORT_RANGE_TOO_LARGE"
  | "EXPORT_TOO_LARGE"
  | "EXPORT_GENERATION_FAILED"
  | "EXPORT_AUDIT_FAILED";

export class ExportApplicationError extends Error {
  constructor(
    readonly code: ExportApplicationErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "ExportApplicationError";
  }
}

export class ExportActorUnavailableError extends Error {
  constructor() {
    super("Export actor is no longer authorized.");
    this.name = "ExportActorUnavailableError";
  }
}

export function exportErrorStatus(code: ExportApplicationErrorCode): number {
  switch (code) {
    case "FORBIDDEN":
      return 403;
    case "EXPORT_RANGE_TOO_LARGE":
      return 422;
    case "EXPORT_TOO_LARGE":
      return 413;
    case "EXPORT_GENERATION_FAILED":
    case "EXPORT_AUDIT_FAILED":
      return 500;
  }
}
