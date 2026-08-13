import {
  getZonedDateTimeParts,
  isSupportedTimezone,
} from "@/modules/availability/domain/local-calendar";
import {
  isLocalDate,
  isOperationalTime,
} from "@/modules/configuration/domain/operational-time";

function localEpochMinutes(localDate: string, localTime: string): number {
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) / 60_000;
}

export function localReservationInstant(
  localDate: string,
  localTime: string,
  timezone: string,
): Date {
  if (
    !isLocalDate(localDate) ||
    !isOperationalTime(localTime) ||
    !isSupportedTimezone(timezone)
  ) {
    throw new Error("Invalid local reservation datetime.");
  }

  const targetMinutes = localEpochMinutes(localDate, localTime);
  let candidateMs = targetMinutes * 60_000;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const represented = getZonedDateTimeParts(new Date(candidateMs), timezone);
    const representedMinutes = localEpochMinutes(
      represented.date,
      represented.time,
    );
    candidateMs += (targetMinutes - representedMinutes) * 60_000;
  }

  const candidate = new Date(candidateMs);
  const represented = getZonedDateTimeParts(candidate, timezone);

  if (represented.date !== localDate || represented.time !== localTime) {
    throw new Error("The local reservation datetime does not exist.");
  }

  return candidate;
}

export function managementViewExpiry(input: {
  localDate: string;
  arrivalTime: string;
  timezone: string;
  durationHours: number;
}): Date {
  if (
    !Number.isInteger(input.durationHours) ||
    input.durationHours < 1 ||
    input.durationHours > 24
  ) {
    throw new Error("Invalid management-link duration.");
  }

  return new Date(
    localReservationInstant(
      input.localDate,
      input.arrivalTime,
      input.timezone,
    ).getTime() +
      input.durationHours * 60 * 60 * 1_000,
  );
}

export function originalManagementLinkDurationHours(input: {
  localDate: string;
  arrivalTime: string;
  timezone: string;
  viewExpiresAt: Date;
}): number {
  if (
    !(input.viewExpiresAt instanceof Date) ||
    !Number.isFinite(input.viewExpiresAt.getTime())
  ) {
    throw new Error("Invalid management-link expiry.");
  }

  const reservationInstant = localReservationInstant(
    input.localDate,
    input.arrivalTime,
    input.timezone,
  );
  const exactHours =
    (input.viewExpiresAt.getTime() - reservationInstant.getTime()) /
    (60 * 60 * 1_000);

  if (!Number.isInteger(exactHours) || exactHours < 1 || exactHours > 24) {
    throw new Error("Incoherent legacy management-link duration.");
  }

  return exactHours;
}

export function isBeforeModificationCutoff(input: {
  now: Date;
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  timezone: string;
  lunchCutoff: string;
  dinnerCutoff: string;
}): boolean {
  const localNow = getZonedDateTimeParts(input.now, input.timezone);
  const cutoff =
    input.serviceType === "LUNCH" ? input.lunchCutoff : input.dinnerCutoff;

  if (!isLocalDate(input.localDate) || !isOperationalTime(cutoff)) {
    throw new Error("Invalid modification cutoff configuration.");
  }

  return (
    localNow.date < input.localDate ||
    (localNow.date === input.localDate && localNow.time < cutoff)
  );
}
