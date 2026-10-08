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
  childrenCount: number | null;
  gameRoomPreference: boolean | null;
  status: "CONFIRMED" | "CANCELLED";
  origin: "PUBLIC" | "PHONE" | "STAFF";
  version: number;
  updatedAt: string;
  arrivedAt: string | null;
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
  legacyAllergy: string | null;
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
    childrenCount: reservation.childrenCount,
    gameRoomPreference: reservation.gameRoomPreference,
    status: reservation.status,
    origin: reservation.origin,
    version: reservation.version,
    updatedAt: reservation.updatedAt.toISOString(),
    arrivedAt: reservation.arrivedAt?.toISOString() ?? null,
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
    allergies: allergyData.allergies,
    legacyAllergy: allergyData.legacyText,
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
