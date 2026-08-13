export const RESTAURANT_TIMEZONE = "Europe/Rome";
export const DEFAULT_SLOT_INTERVAL_MINUTES = 15;
export const DEFAULT_ROLLING_CAPACITY_COVERS = 30;
export const FIXED_ROLLING_WINDOW_MINUTES = 30;
export const DEFAULT_MANAGEMENT_LINK_DURATION_HOURS = 24;

export const DEFAULT_SERVICE_TIMES = {
  LUNCH: { startTime: "12:00", endTime: "14:00" },
  DINNER: { startTime: "19:00", endTime: "22:15" },
} as const;

export const DEFAULT_BOOKING_CUTOFFS = {
  lunchModificationCutoff: "10:30",
  dinnerModificationCutoff: "17:30",
  publicBookingCutoffTime: "17:30",
} as const;

export const DAY_OF_WEEK_VALUES = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

export const SERVICE_TYPE_VALUES = ["LUNCH", "DINNER"] as const;
export const SPECIAL_DATE_SCOPE_VALUES = ["ALL", "LUNCH", "DINNER"] as const;

export const DAY_LABELS: Record<(typeof DAY_OF_WEEK_VALUES)[number], string> = {
  MONDAY: "Lunedì",
  TUESDAY: "Martedì",
  WEDNESDAY: "Mercoledì",
  THURSDAY: "Giovedì",
  FRIDAY: "Venerdì",
  SATURDAY: "Sabato",
  SUNDAY: "Domenica",
};

export const SERVICE_LABELS: Record<(typeof SERVICE_TYPE_VALUES)[number], string> = {
  LUNCH: "Pranzo",
  DINNER: "Cena",
};

export const SPECIAL_DATE_SCOPE_LABELS: Record<
  (typeof SPECIAL_DATE_SCOPE_VALUES)[number],
  string
> = {
  ALL: "Intera giornata",
  LUNCH: "Solo pranzo",
  DINNER: "Solo cena",
};

export const DEMO_ROOMS = [
  { name: "Sala 1", code: "sala-1", displayOrder: 1, serviceAvailabilityPolicy: "DEFAULT_AVAILABLE" },
  { name: "Sala 2", code: "sala-2", displayOrder: 2, serviceAvailabilityPolicy: "DEFAULT_AVAILABLE" },
  { name: "Sala 3", code: "sala-3", displayOrder: 3, serviceAvailabilityPolicy: "DEFAULT_AVAILABLE" },
  { name: "Galleria", code: "galleria", displayOrder: 4, serviceAvailabilityPolicy: "EXPLICIT_ONLY" },
  { name: "Terrazzo", code: "terrazzo", displayOrder: 5, serviceAvailabilityPolicy: "EXPLICIT_ONLY" },
] as const;
