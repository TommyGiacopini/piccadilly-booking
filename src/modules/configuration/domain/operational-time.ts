const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isOperationalTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

export function operationalTimeToMinutes(value: string): number {
  if (!isOperationalTime(value)) {
    throw new Error("Invalid operational time.");
  }

  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function operationalTimeToDatabase(value: string): Date {
  if (!isOperationalTime(value)) {
    throw new Error("Invalid operational time.");
  }

  return new Date(`1970-01-01T${value}:00.000Z`);
}

export function operationalTimeFromDatabase(value: Date): string {
  return `${String(value.getUTCHours()).padStart(2, "0")}:${String(
    value.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && localDateFromDatabase(date) === value;
}

export function localDateToDatabase(value: string): Date {
  if (!isLocalDate(value)) {
    throw new Error("Invalid local date.");
  }

  return new Date(`${value}T00:00:00.000Z`);
}

export function localDateFromDatabase(value: Date): string {
  return [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

