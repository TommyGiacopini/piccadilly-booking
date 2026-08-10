export const RESERVATION_STATUSES = ["CONFIRMED", "CANCELLED"] as const;
export const RESERVATION_ORIGINS = ["STAFF", "PHONE", "PUBLIC"] as const;
export const PRIVACY_CONSENT_METHODS = [
  "VERBAL",
  "STAFF_RECORDED",
  "WEB_CHECKBOX",
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export type ReservationOrigin = (typeof RESERVATION_ORIGINS)[number];
export type PrivacyConsentMethod =
  (typeof PRIVACY_CONSENT_METHODS)[number];
export type ReservationActorRole = "ADMIN" | "STAFF";
export type ReservationServiceType = "LUNCH" | "DINNER";

export interface ReservationActor {
  id: string;
  restaurantId: string;
  role: ReservationActorRole;
}

export interface CreateReservationCommand {
  localDate: string;
  serviceType: ReservationServiceType;
  arrivalTime: string;
  partySize: number;
  origin: ReservationOrigin;
  customerFirstName: string;
  customerLastName: string;
  customerPhone: string;
  customerEmail: string | null;
  notes: string | null;
  preferences: string | null;
  allergies: string | null;
  privacyConsentMethod: PrivacyConsentMethod;
  capacityOverride: boolean;
  capacityOverrideReason: string | null;
}

export interface StoredReservation {
  id: string;
  restaurantId: string;
  localDate: string;
  serviceType: ReservationServiceType;
  arrivalTime: string;
  partySize: number;
  status: ReservationStatus;
  origin: ReservationOrigin;
  customerFirstName: string;
  customerLastName: string;
  customerPhone: string;
  customerEmail: string | null;
  notes: string | null;
  preferences: string | null;
  allergies: string | null;
  privacyPolicyVersion: string;
  privacyConsentAt: Date;
  privacyConsentMethod: PrivacyConsentMethod;
  termsPolicyVersion: string | null;
  termsConsentAt: Date | null;
  termsConsentMethod: PrivacyConsentMethod | null;
  consentLanguage: "it" | "en" | null;
  createdByUserId: string | null;
  capacityOverride: boolean;
  capacityOverrideReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
  version: number;
}
