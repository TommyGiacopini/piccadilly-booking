import {
  isOperationalTime,
  operationalTimeToMinutes,
} from "@/modules/configuration/domain/operational-time";

const MINUTES_PER_DAY = 24 * 60;

export function minutesToOperationalTime(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) {
    throw new Error("Invalid operational minutes.");
  }

  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
    minutes % 60,
  ).padStart(2, "0")}`;
}

export function generateInclusiveSlots(
  startTime: string,
  endTime: string,
  slotIntervalMinutes: number,
): string[] {
  if (
    !isOperationalTime(startTime) ||
    !isOperationalTime(endTime) ||
    !Number.isInteger(slotIntervalMinutes) ||
    slotIntervalMinutes <= 0 ||
    slotIntervalMinutes > MINUTES_PER_DAY
  ) {
    throw new Error("Invalid slot configuration.");
  }

  const start = operationalTimeToMinutes(startTime);
  const end = operationalTimeToMinutes(endTime);
  const duration = end - start;

  if (duration <= 0 || duration % slotIntervalMinutes !== 0) {
    throw new Error("Incoherent slot configuration.");
  }

  const slotCount = duration / slotIntervalMinutes + 1;

  if (slotCount > MINUTES_PER_DAY + 1) {
    throw new Error("Too many slots.");
  }

  return Array.from({ length: slotCount }, (_, index) =>
    minutesToOperationalTime(start + index * slotIntervalMinutes),
  );
}
