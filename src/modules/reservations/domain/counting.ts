import type { ReservationStatus } from "@/modules/reservations/domain/types";

export function countsTowardCapacity(status: ReservationStatus): boolean {
  return status === "CONFIRMED";
}
