import { isLocalDate } from "@/modules/configuration/domain/operational-time";

export type LocalDayOfWeek =
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY"
  | "SUNDAY";

export interface ZonedDateTimeParts {
  date: string;
  time: string;
  second: number;
}

const WEEKDAYS: readonly LocalDayOfWeek[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

const MONTH_OFFSETS = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4] as const;

export function getLocalDayOfWeek(localDate: string): LocalDayOfWeek {
  if (!isLocalDate(localDate)) {
    throw new Error("Invalid local date.");
  }

  const [yearValue, month, day] = localDate.split("-").map(Number);
  const year = month < 3 ? yearValue - 1 : yearValue;
  const index =
    (year +
      Math.floor(year / 4) -
      Math.floor(year / 100) +
      Math.floor(year / 400) +
      MONTH_OFFSETS[month - 1] +
      day) %
    7;

  return WEEKDAYS[index];
}

export function isSupportedTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function getZonedDateTimeParts(
  instant: Date,
  timezone: string,
): ZonedDateTimeParts {
  if (Number.isNaN(instant.getTime()) || !isSupportedTimezone(timezone)) {
    throw new Error("Invalid instant or timezone.");
  }

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = new Map(
    formatter
      .formatToParts(instant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  const second = parts.get("second");

  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error("Timezone conversion failed.");
  }

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    second: Number(second),
  };
}

export function isSlotInPastOrCurrentMinute(
  date: string,
  time: string,
  now: ZonedDateTimeParts,
): boolean {
  if (date < now.date) {
    return true;
  }

  if (date > now.date) {
    return false;
  }

  return time <= now.time;
}
