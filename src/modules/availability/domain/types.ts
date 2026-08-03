export const AVAILABILITY_CHANNELS = ["PUBLIC", "STAFF"] as const;
export const AVAILABILITY_SERVICE_TYPES = ["LUNCH", "DINNER"] as const;

export type AvailabilityChannel = (typeof AVAILABILITY_CHANNELS)[number];
export type AvailabilityServiceType =
  (typeof AVAILABILITY_SERVICE_TYPES)[number];

export type AvailabilityConfigurationSource =
  | "SPECIAL_DATE_SERVICE"
  | "SPECIAL_DATE_ALL"
  | "WEEKLY";

export type AvailabilityReason =
  | "SERVICE_CLOSED"
  | "SLOT_IN_PAST"
  | "ONLINE_CUTOFF_REACHED"
  | "CAPACITY_EXCEEDED"
  | "PARTY_SIZE_INVALID"
  | "CONFIGURATION_INVALID";

export interface CapacityArrival {
  arrivalTime: string;
  covers: number;
  countsTowardCapacity: boolean;
}

export interface WeeklyAvailabilityRule {
  serviceType: AvailabilityServiceType;
  isEnabled: boolean;
  startTime: string;
  endTime: string;
  slotIntervalMinutes: number;
}

export interface SpecialDateAvailabilityRule {
  scope: "ALL" | AvailabilityServiceType;
  isClosed: boolean;
  specialStartTime: string | null;
  specialEndTime: string | null;
  specialCapacityCovers: number | null;
}

export interface RestaurantAvailabilitySettings {
  rollingCapacityCovers: number;
  rollingWindowMinutes: number;
  fridayDinnerBookingCutoff: string;
  saturdayDinnerBookingCutoff: string;
}

export interface AvailabilityConfigurationInput {
  timezone: string;
  settings: RestaurantAvailabilitySettings | null;
  weeklyRule: WeeklyAvailabilityRule | null;
  allDateOverride: SpecialDateAvailabilityRule | null;
  serviceDateOverride: SpecialDateAvailabilityRule | null;
}

export interface AvailabilitySlot {
  time: string;
  available: boolean;
  remainingCapacity: number;
  reason?: AvailabilityReason;
}

export interface AvailabilityResult {
  date: string;
  serviceType: AvailabilityServiceType;
  channel: AvailabilityChannel;
  timezone: string;
  source: AvailabilityConfigurationSource;
  isOpen: boolean;
  capacityLimit: number | null;
  rollingWindowMinutes: number | null;
  slotIntervalMinutes: number | null;
  reason?: AvailabilityReason;
  slots: AvailabilitySlot[];
}

export interface AvailabilityEngineInput {
  date: string;
  serviceType: AvailabilityServiceType;
  partySize: number;
  now: Date;
  channel: AvailabilityChannel;
  arrivals: readonly CapacityArrival[];
  configuration: AvailabilityConfigurationInput;
}
