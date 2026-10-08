import { createHash } from "node:crypto";

import { type PublicCreateReservationInput, legacyPublicCreateReservationSchema } from "@/modules/reservations/domain/public-validation";
import type { z } from "zod";

export function hashPublicReservationRequest(
  input: PublicCreateReservationInput | z.infer<typeof legacyPublicCreateReservationSchema>,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}
