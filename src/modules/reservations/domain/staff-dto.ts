import type { StoredReservation } from "@/modules/reservations/domain/types";
import {
  parsePublicAllergies,
  parsePublicPreferences,
} from "@/modules/reservations/domain/public-validation";

export interface StaffReservationDto {
  id: string;
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  partySize: number;
  status: "CONFIRMED" | "CANCELLED";
  origin: "PUBLIC" | "PHONE" | "STAFF";
  version: number;
  updatedAt: string;
  customer: {
    firstName: string;
    lastName: string;
    phone: string;
    email: string | null;
  };
  roomCode: string;
  legacyPreference: string | null;
  highChair: boolean;
  stroller: boolean;
  accessibility: boolean;
  children: boolean;
  celiac: boolean;
  allergies: string | null;
  intolerances: string | null;
  celebration: string | null;
  animals: boolean;
  notes: string | null;
  override: {
    applied: boolean;
    reason: string | null;
  };
}

export function toStaffReservationDto(
  reservation: StoredReservation,
): StaffReservationDto {
  const preferences = parsePublicPreferences(reservation.preferences);
  const allergyData = parsePublicAllergies(reservation.allergies);

  return {
    id: reservation.id,
    localDate: reservation.localDate,
    serviceType: reservation.serviceType,
    arrivalTime: reservation.arrivalTime,
    partySize: reservation.partySize,
    status: reservation.status,
    origin: reservation.origin,
    version: reservation.version,
    updatedAt: reservation.updatedAt.toISOString(),
    customer: {
      firstName: reservation.customerFirstName,
      lastName: reservation.customerLastName,
      phone: reservation.customerPhone,
      email: reservation.customerEmail,
    },
    roomCode: preferences.roomCode,
    legacyPreference: preferences.legacyText,
    highChair: preferences.highChair,
    stroller: preferences.stroller,
    accessibility: preferences.accessibility,
    children: preferences.children,
    celiac: allergyData.celiac,
    allergies: allergyData.allergies ?? allergyData.legacyText,
    intolerances: allergyData.intolerances,
    celebration: preferences.celebration,
    animals: preferences.animals,
    notes: reservation.notes,
    override: {
      applied: reservation.capacityOverride,
      reason: reservation.capacityOverrideReason,
    },
  };
}

export function staffAuditSnapshot(reservation: StoredReservation) {
  const preferences = parsePublicPreferences(reservation.preferences);
  const allergyData = parsePublicAllergies(reservation.allergies);

  return {
    localDate: reservation.localDate,
    serviceType: reservation.serviceType,
    arrivalTime: reservation.arrivalTime,
    partySize: reservation.partySize,
    status: reservation.status,
    origin: reservation.origin,
    customer: {
      firstName: reservation.customerFirstName,
      lastName: reservation.customerLastName,
      phonePresent: reservation.customerPhone.length > 0,
      emailPresent: reservation.customerEmail !== null,
    },
    requests: {
      roomCode: preferences.roomCode || null,
      legacyPreferencePresent: preferences.legacyText !== null,
      highChair: preferences.highChair,
      stroller: preferences.stroller,
      accessibility: preferences.accessibility,
      children: preferences.children,
      celiac: allergyData.celiac,
      allergiesPresent:
        allergyData.allergies !== null || allergyData.legacyText !== null,
      intolerancesPresent: allergyData.intolerances !== null,
      celebrationPresent: preferences.celebration !== null,
      animals: preferences.animals,
      notesPresent: reservation.notes !== null,
    },
    capacityOverride: reservation.capacityOverride,
    capacityOverrideReason: reservation.capacityOverrideReason,
    version: reservation.version,
  };
}
