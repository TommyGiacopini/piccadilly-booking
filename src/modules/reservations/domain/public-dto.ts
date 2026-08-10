import type { StoredReservation } from "@/modules/reservations/domain/types";
import {
  parsePublicAllergies,
  parsePublicPreferences,
} from "@/modules/reservations/domain/public-validation";

export interface PublicReservationDto {
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  partySize: number;
  status: "CONFIRMED" | "CANCELLED";
  customer: {
    firstName: string;
    lastName: string;
    phone: string;
    email: string | null;
  };
  roomCode: string;
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
  canModify: boolean;
  canCancel: boolean;
  viewExpiresAt: string;
}

export function toPublicReservationDto(input: {
  reservation: StoredReservation;
  canMutate: boolean;
  viewExpiresAt: Date;
}): PublicReservationDto {
  const preferences = parsePublicPreferences(input.reservation.preferences);
  const allergyData = parsePublicAllergies(input.reservation.allergies);
  const active = input.reservation.status === "CONFIRMED";

  return {
    localDate: input.reservation.localDate,
    serviceType: input.reservation.serviceType,
    arrivalTime: input.reservation.arrivalTime,
    partySize: input.reservation.partySize,
    status: input.reservation.status,
    customer: {
      firstName: input.reservation.customerFirstName,
      lastName: input.reservation.customerLastName,
      phone: input.reservation.customerPhone,
      email: input.reservation.customerEmail,
    },
    roomCode: preferences.roomCode,
    highChair: preferences.highChair,
    stroller: preferences.stroller,
    accessibility: preferences.accessibility,
    children: preferences.children,
    celiac: allergyData.celiac,
    allergies: allergyData.allergies,
    intolerances: allergyData.intolerances,
    celebration: preferences.celebration,
    animals: preferences.animals,
    notes: input.reservation.notes,
    canModify: active && input.canMutate,
    canCancel: active && input.canMutate,
    viewExpiresAt: input.viewExpiresAt.toISOString(),
  };
}

export function publicAuditSnapshot(reservation: StoredReservation) {
  return {
    localDate: reservation.localDate,
    serviceType: reservation.serviceType,
    arrivalTime: reservation.arrivalTime,
    partySize: reservation.partySize,
    status: reservation.status,
    preferences: reservation.preferences,
    allergies: reservation.allergies,
    notes: reservation.notes,
  };
}
