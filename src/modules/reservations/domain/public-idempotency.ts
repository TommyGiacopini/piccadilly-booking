import { createHash } from "node:crypto";

import type { PublicCreateReservationInput } from "@/modules/reservations/domain/public-validation";

export function hashPublicReservationRequest(
  input: PublicCreateReservationInput,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}
