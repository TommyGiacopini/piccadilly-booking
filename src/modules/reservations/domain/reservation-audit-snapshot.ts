import {
  parsePublicAllergies,
  parsePublicPreferences,
} from "@/modules/reservations/domain/public-validation";
import type { StoredReservation } from "@/modules/reservations/domain/types";

function hasText(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

/**
 * Canonical, allow-listed reservation audit representation.
 * Operational DTOs intentionally remain separate because audit must never copy PII
 * or the free-text contents of customer requests.
 */
export function reservationAuditSnapshot(reservation: StoredReservation) {
  const preferences = parsePublicPreferences(reservation.preferences);
  const foodRequests = parsePublicAllergies(reservation.allergies);
  const allergiesPresent =
    hasText(foodRequests.allergies) || hasText(foodRequests.legacyText);
  const intolerancesPresent = hasText(foodRequests.intolerances);

  return {
    localDate: reservation.localDate,
    serviceType: reservation.serviceType,
    arrivalTime: reservation.arrivalTime,
    partySize: reservation.partySize,
    status: reservation.status,
    origin: reservation.origin,
    version: reservation.version,
    requests: {
      roomCode: preferences.roomCode || null,
      legacyPreferencePresent: hasText(preferences.legacyText),
      highChair: preferences.highChair,
      stroller: preferences.stroller,
      accessibility: preferences.accessibility,
      children: preferences.children,
      celiac: foodRequests.celiac,
      foodRequestsPresent:
        foodRequests.celiac || allergiesPresent || intolerancesPresent,
      allergiesPresent,
      intolerancesPresent,
      celebrationPresent: hasText(preferences.celebration),
      animals: preferences.animals,
      notesPresent: hasText(reservation.notes),
    },
    capacityOverride: reservation.capacityOverride,
    capacityOverrideReason: reservation.capacityOverrideReason,
  };
}
