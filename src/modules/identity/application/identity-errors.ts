export type IdentityErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "DUPLICATE"
  | "CURRENT_PASSWORD_INVALID"
  | "SELF_PROTECTED"
  | "LAST_ADMIN";

export class IdentityError extends Error {
  constructor(
    readonly code: IdentityErrorCode,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = "IdentityError";
  }
}

export function identityErrorStatus(code: IdentityErrorCode): number {
  switch (code) {
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "DUPLICATE":
    case "SELF_PROTECTED":
    case "LAST_ADMIN":
      return 409;
    case "CURRENT_PASSWORD_INVALID":
    case "VALIDATION":
      return 400;
  }
}
