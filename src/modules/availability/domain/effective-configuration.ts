import {
  isOperationalTime,
  operationalTimeToMinutes,
} from "@/modules/configuration/domain/operational-time";
import type {
  AvailabilityConfigurationInput,
  AvailabilityConfigurationSource,
  AvailabilityServiceType,
  SpecialDateAvailabilityRule,
} from "@/modules/availability/domain/types";

export interface EffectiveAvailabilityConfiguration {
  source: AvailabilityConfigurationSource;
  isOpen: boolean;
  startTime: string | null;
  endTime: string | null;
  slotIntervalMinutes: number | null;
  capacityLimit: number | null;
  rollingWindowMinutes: number | null;
  publicBookingCutoffEnabled: boolean;
  publicBookingCutoffTime: string | null;
  isValid: boolean;
}

function selectOverride(
  configuration: AvailabilityConfigurationInput,
): {
  rule: SpecialDateAvailabilityRule | null;
  source: AvailabilityConfigurationSource;
} {
  if (configuration.serviceDateOverride) {
    return {
      rule: configuration.serviceDateOverride,
      source: "SPECIAL_DATE_SERVICE",
    };
  }

  if (configuration.allDateOverride) {
    return {
      rule: configuration.allDateOverride,
      source: "SPECIAL_DATE_ALL",
    };
  }

  return { rule: null, source: "WEEKLY" };
}

function hasValidPositiveInteger(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value > 0;
}

export function resolveEffectiveAvailabilityConfiguration(
  serviceType: AvailabilityServiceType,
  configuration: AvailabilityConfigurationInput,
): EffectiveAvailabilityConfiguration {
  const selected = selectOverride(configuration);
  const weeklyRule = configuration.weeklyRule;
  const settings = configuration.settings;
  const isOpen = selected.rule
    ? !selected.rule.isClosed
    : Boolean(weeklyRule?.isEnabled);
  const startTime = selected.rule?.specialStartTime ?? weeklyRule?.startTime ?? null;
  const endTime = selected.rule?.specialEndTime ?? weeklyRule?.endTime ?? null;
  const slotIntervalMinutes = weeklyRule?.slotIntervalMinutes ?? null;
  const capacityLimit =
    selected.rule?.specialCapacityCovers ??
    settings?.rollingCapacityCovers ??
    null;
  const rollingWindowMinutes = settings?.rollingWindowMinutes ?? null;
  const publicBookingCutoffEnabled =
    configuration.bookingCutoffRule?.isEnabled ?? false;
  const publicBookingCutoffTime =
    configuration.bookingCutoffRule?.cutoffTime ?? null;

  const specialTimesAreCoherent =
    !selected.rule ||
    (selected.rule.specialStartTime === null) ===
      (selected.rule.specialEndTime === null);
  const timesAreValid =
    startTime !== null &&
    endTime !== null &&
    isOperationalTime(startTime) &&
    isOperationalTime(endTime) &&
    operationalTimeToMinutes(startTime) < operationalTimeToMinutes(endTime);
  const cutoffTimeIsValid =
    !publicBookingCutoffEnabled ||
    (publicBookingCutoffTime !== null &&
      isOperationalTime(publicBookingCutoffTime));
  const serviceMatches = weeklyRule?.serviceType === serviceType;
  const isValid =
    specialTimesAreCoherent &&
    timesAreValid &&
    serviceMatches &&
    hasValidPositiveInteger(slotIntervalMinutes) &&
    hasValidPositiveInteger(capacityLimit) &&
    hasValidPositiveInteger(rollingWindowMinutes) &&
    rollingWindowMinutes >= slotIntervalMinutes &&
    cutoffTimeIsValid;

  return {
    source: selected.source,
    isOpen,
    startTime,
    endTime,
    slotIntervalMinutes,
    capacityLimit,
    rollingWindowMinutes,
    publicBookingCutoffEnabled,
    publicBookingCutoffTime,
    isValid,
  };
}
