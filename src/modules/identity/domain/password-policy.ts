export const SELECTED_PASSWORD_MINIMUM_CODE_POINTS = 15;
export const SELECTED_PASSWORD_MAXIMUM_CODE_POINTS = 128;

const ESSENTIAL_BLOCKLIST = new Set(
  [
    "password",
    "password123",
    "password1234",
    "qwerty",
    "qwerty123",
    "123456789",
    "1234567890",
    "admin",
    "administrator",
    "letmein",
    "welcome",
    "piccadilly",
    "piccadilly2026",
    "piccadillydemoadmin-local-2026",
    "piccadillydemostaff-local-2026",
  ].map((value) => value.normalize("NFKC").toLowerCase()),
);

export type PasswordPolicyCode =
  | "TOO_SHORT"
  | "TOO_LONG"
  | "CONTROL_CHARACTER"
  | "BLOCKED"
  | "MATCHES_USERNAME";

export interface PasswordPolicyFailure {
  code: PasswordPolicyCode;
  message: string;
}

function comparisonValue(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function unicodeCodePointLength(value: string): number {
  return Array.from(value).length;
}

export function validateSelectedPassword(
  password: string,
  username: string,
): PasswordPolicyFailure | null {
  const length = unicodeCodePointLength(password);

  if (length < SELECTED_PASSWORD_MINIMUM_CODE_POINTS) {
    return {
      code: "TOO_SHORT",
      message: `La password deve contenere almeno ${SELECTED_PASSWORD_MINIMUM_CODE_POINTS} caratteri.`,
    };
  }

  if (length > SELECTED_PASSWORD_MAXIMUM_CODE_POINTS) {
    return {
      code: "TOO_LONG",
      message: `La password non può superare ${SELECTED_PASSWORD_MAXIMUM_CODE_POINTS} caratteri.`,
    };
  }

  if (/\p{Cc}/u.test(password)) {
    return {
      code: "CONTROL_CHARACTER",
      message: "La password non può contenere caratteri di controllo.",
    };
  }

  const comparablePassword = comparisonValue(password);

  if (ESSENTIAL_BLOCKLIST.has(comparablePassword)) {
    return {
      code: "BLOCKED",
      message: "Questa password è troppo comune o riservata agli ambienti demo.",
    };
  }

  if (comparablePassword === comparisonValue(username)) {
    return {
      code: "MATCHES_USERNAME",
      message: "La password non può coincidere con lo username.",
    };
  }

  return null;
}
