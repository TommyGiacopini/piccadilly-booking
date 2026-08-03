import {
  isOperationalTime,
  operationalTimeToMinutes,
} from "@/modules/configuration/domain/operational-time";
import type { CapacityArrival } from "@/modules/availability/domain/types";

export interface SlotCapacityEvaluation {
  time: string;
  available: boolean;
  remainingCapacity: number;
}

function validateArrivals(arrivals: readonly CapacityArrival[]): void {
  for (const arrival of arrivals) {
    if (
      !isOperationalTime(arrival.arrivalTime) ||
      !Number.isInteger(arrival.covers) ||
      arrival.covers <= 0 ||
      typeof arrival.countsTowardCapacity !== "boolean"
    ) {
      throw new Error("Invalid capacity arrival.");
    }
  }
}

export function evaluateRollingCapacity(
  slots: readonly string[],
  arrivals: readonly CapacityArrival[],
  capacityLimit: number,
  rollingWindowMinutes: number,
  partySize: number,
): SlotCapacityEvaluation[] {
  validateArrivals(arrivals);

  if (
    !Number.isInteger(capacityLimit) ||
    capacityLimit <= 0 ||
    !Number.isInteger(rollingWindowMinutes) ||
    rollingWindowMinutes <= 0
  ) {
    throw new Error("Invalid rolling capacity configuration.");
  }

  const slotMinutes = slots.map((slot) => operationalTimeToMinutes(slot));
  const countedArrivals = arrivals
    .filter((arrival) => arrival.countsTowardCapacity)
    .map((arrival) => ({
      minutes: operationalTimeToMinutes(arrival.arrivalTime),
      covers: arrival.covers,
    }));
  const windowLoads = slotMinutes.map((windowStart) =>
    countedArrivals
      .filter(
        (arrival) =>
          arrival.minutes >= windowStart &&
          arrival.minutes < windowStart + rollingWindowMinutes,
      )
      .reduce((total, arrival) => total + arrival.covers, 0),
  );

  return slots.map((time, candidateIndex) => {
    const candidate = slotMinutes[candidateIndex];
    const affectedWindowIndexes = slotMinutes
      .map((windowStart, index) => ({ windowStart, index }))
      .filter(
        ({ windowStart }) =>
          candidate >= windowStart &&
          candidate < windowStart + rollingWindowMinutes,
      )
      .map(({ index }) => index);
    const minimumMargin = Math.min(
      ...affectedWindowIndexes.map(
        (windowIndex) => capacityLimit - windowLoads[windowIndex],
      ),
    );

    return {
      time,
      available: affectedWindowIndexes.every(
        (windowIndex) => windowLoads[windowIndex] + partySize <= capacityLimit,
      ),
      remainingCapacity: Math.max(0, minimumMargin),
    };
  });
}
