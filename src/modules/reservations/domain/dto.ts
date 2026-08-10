import type { StoredReservation } from "@/modules/reservations/domain/types";

export interface ReservationDto {
  id: string;
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  partySize: number;
  status: "CONFIRMED" | "CANCELLED";
  origin: "STAFF" | "PHONE" | "PUBLIC";
  customer: {
    firstName: string;
    lastName: string;
    phone: string;
    email: string | null;
  };
  notes: string | null;
  preferences: string | null;
  allergies: string | null;
  override: {
    applied: boolean;
    reason: string | null;
  };
  createdAt: string;
}

export function toReservationDto(
  reservation: StoredReservation,
): ReservationDto {
  return {
    id: reservation.id,
    localDate: reservation.localDate,
    serviceType: reservation.serviceType,
    arrivalTime: reservation.arrivalTime,
    partySize: reservation.partySize,
    status: reservation.status,
    origin: reservation.origin,
    customer: {
      firstName: reservation.customerFirstName,
      lastName: reservation.customerLastName,
      phone: reservation.customerPhone,
      email: reservation.customerEmail,
    },
    notes: reservation.notes,
    preferences: reservation.preferences,
    allergies: reservation.allergies,
    override: {
      applied: reservation.capacityOverride,
      reason: reservation.capacityOverrideReason,
    },
    createdAt: reservation.createdAt.toISOString(),
  };
}
