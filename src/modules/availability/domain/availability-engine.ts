import { isLocalDate } from "@/modules/configuration/domain/operational-time";
import { resolveEffectiveAvailabilityConfiguration } from "@/modules/availability/domain/effective-configuration";
import {
  getLocalDayOfWeek,
  getZonedDateTimeParts,
  isSlotInPastOrCurrentMinute,
  isSupportedTimezone,
} from "@/modules/availability/domain/local-calendar";
import { evaluateRollingCapacity } from "@/modules/availability/domain/rolling-capacity";
import { generateInclusiveSlots } from "@/modules/availability/domain/slot-generation";
import type {
  AvailabilityEngineInput,
  AvailabilityReason,
  AvailabilityResult,
} from "@/modules/availability/domain/types";

function configurationFailure(
  input: AvailabilityEngineInput,
  source: AvailabilityResult["source"],
  capacityLimit: number | null,
  rollingWindowMinutes: number | null,
  slotIntervalMinutes: number | null,
): AvailabilityResult {
  return {
    date: input.date,
    serviceType: input.serviceType,
    channel: input.channel,
    timezone: input.configuration.timezone,
    source,
    isOpen: false,
    capacityLimit,
    rollingWindowMinutes,
    slotIntervalMinutes,
    reason: "CONFIGURATION_INVALID",
    slots: [],
  };
}

function isPartySizeValid(partySize: number): boolean {
  return Number.isFinite(partySize) && Number.isInteger(partySize) && partySize >= 1;
}

export function calculateAvailability(
  input: AvailabilityEngineInput,
): AvailabilityResult {
  const effective = resolveEffectiveAvailabilityConfiguration(
    input.serviceType,
    input.configuration,
  );

  if (
    !isLocalDate(input.date) ||
    !isSupportedTimezone(input.configuration.timezone) ||
    Number.isNaN(input.now.getTime()) ||
    !effective.isValid ||
    effective.startTime === null ||
    effective.endTime === null ||
    effective.slotIntervalMinutes === null ||
    effective.capacityLimit === null ||
    effective.rollingWindowMinutes === null
  ) {
    return configurationFailure(
      input,
      effective.source,
      effective.capacityLimit,
      effective.rollingWindowMinutes,
      effective.slotIntervalMinutes,
    );
  }

  const resultBase = {
    date: input.date,
    serviceType: input.serviceType,
    channel: input.channel,
    timezone: input.configuration.timezone,
    source: effective.source,
    capacityLimit: effective.capacityLimit,
    rollingWindowMinutes: effective.rollingWindowMinutes,
    slotIntervalMinutes: effective.slotIntervalMinutes,
  } as const;

  if (!effective.isOpen) {
    return {
      ...resultBase,
      isOpen: false,
      reason: "SERVICE_CLOSED",
      slots: [],
    };
  }

  let slots: string[];

  try {
    slots = generateInclusiveSlots(
      effective.startTime,
      effective.endTime,
      effective.slotIntervalMinutes,
    );
  } catch {
    return configurationFailure(
      input,
      effective.source,
      effective.capacityLimit,
      effective.rollingWindowMinutes,
      effective.slotIntervalMinutes,
    );
  }

  const partySizeIsValid = isPartySizeValid(input.partySize);
  let capacity;

  try {
    capacity = evaluateRollingCapacity(
      slots,
      input.arrivals,
      effective.capacityLimit,
      effective.rollingWindowMinutes,
      partySizeIsValid ? input.partySize : 1,
    );
  } catch {
    return configurationFailure(
      input,
      effective.source,
      effective.capacityLimit,
      effective.rollingWindowMinutes,
      effective.slotIntervalMinutes,
    );
  }

  const localNow = getZonedDateTimeParts(
    input.now,
    input.configuration.timezone,
  );
  const dayOfWeek = getLocalDayOfWeek(input.date);
  const weekendDinnerCutoff =
    input.serviceType === "DINNER" && dayOfWeek === "FRIDAY"
      ? effective.fridayDinnerBookingCutoff
      : input.serviceType === "DINNER" && dayOfWeek === "SATURDAY"
        ? effective.saturdayDinnerBookingCutoff
        : null;
  const onlineCutoffReached =
    input.channel === "PUBLIC" &&
    input.date === localNow.date &&
    weekendDinnerCutoff !== null &&
    localNow.time >= weekendDinnerCutoff;

  return {
    ...resultBase,
    isOpen: true,
    slots: capacity.map((slot) => {
      let reason: AvailabilityReason | undefined;

      if (isSlotInPastOrCurrentMinute(input.date, slot.time, localNow)) {
        reason = "SLOT_IN_PAST";
      } else if (onlineCutoffReached) {
        reason = "ONLINE_CUTOFF_REACHED";
      } else if (!partySizeIsValid) {
        reason = "PARTY_SIZE_INVALID";
      } else if (!slot.available) {
        reason = "CAPACITY_EXCEEDED";
      }

      return {
        time: slot.time,
        available: reason === undefined,
        remainingCapacity: slot.remainingCapacity,
        ...(reason ? { reason } : {}),
      };
    }),
  };
}
