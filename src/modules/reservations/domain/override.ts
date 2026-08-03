import type { ReservationActorRole } from "@/modules/reservations/domain/types";

export function canUseCapacityOverride(
  role: ReservationActorRole,
  requested: boolean,
): boolean {
  return !requested || role === "ADMIN";
}
