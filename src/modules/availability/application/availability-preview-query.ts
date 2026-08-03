import { z } from "zod";

import {
  AVAILABILITY_CHANNELS,
  AVAILABILITY_SERVICE_TYPES,
} from "@/modules/availability/domain/types";
import { isLocalDate } from "@/modules/configuration/domain/operational-time";

const positiveIntegerQuerySchema = z
  .string()
  .regex(/^\d+$/, "Il numero di coperti deve essere un intero positivo.")
  .transform(Number)
  .refine(
    (value) => Number.isSafeInteger(value) && value > 0,
    "Il numero di coperti deve essere un intero positivo.",
  );

export const availabilityPreviewQuerySchema = z.object({
  date: z
    .string()
    .refine(isLocalDate, "La data deve essere valida e nel formato YYYY-MM-DD."),
  service: z.enum(AVAILABILITY_SERVICE_TYPES, {
    error: "Il servizio deve essere LUNCH o DINNER.",
  }),
  partySize: positiveIntegerQuerySchema,
  channel: z.enum(AVAILABILITY_CHANNELS).default("PUBLIC"),
});

export type AvailabilityPreviewQuery = z.infer<
  typeof availabilityPreviewQuerySchema
>;
