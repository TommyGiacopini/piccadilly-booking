import { z } from "zod";

export const reservationArrivalInputSchema = z.strictObject({
  version: z.number().int().positive(),
  arrived: z.boolean(),
});

export type ReservationArrivalInput = z.infer<
  typeof reservationArrivalInputSchema
>;

export type ReservationArrivalUiState =
  | "EXPECTED"
  | "ARRIVED"
  | "NOT_RECORDED";

export type ReservationArrivalAuditSnapshot = Record<
  string,
  Record<string, boolean | string | null>
>;

export function reservationArrivalAuditSnapshot(
  arrivedAt: Date | null,
): ReservationArrivalAuditSnapshot {
  if (arrivedAt && Number.isNaN(arrivedAt.getTime())) {
    throw new Error("Invalid arrival timestamp.");
  }

  return {
    arrival: {
      recorded: arrivedAt !== null,
      arrivedAt: arrivedAt?.toISOString() ?? null,
    },
  };
}

export function reservationArrivalUiState(input: {
  arrivedAt: string | null;
  status: "CONFIRMED" | "CANCELLED";
  isHistorical: boolean;
}): ReservationArrivalUiState {
  if (input.arrivedAt !== null) return "ARRIVED";
  if (input.status === "CANCELLED" || input.isHistorical) {
    return "NOT_RECORDED";
  }
  return "EXPECTED";
}
