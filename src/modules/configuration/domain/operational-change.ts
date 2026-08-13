import { z } from "zod";

import {
  DAY_OF_WEEK_VALUES,
  SERVICE_TYPE_VALUES,
} from "@/modules/configuration/domain/defaults";
import {
  isOperationalTime,
  operationalTimeToMinutes,
} from "@/modules/configuration/domain/operational-time";

const timeSchema = z
  .string()
  .refine(isOperationalTime, "Inserisci un orario valido nel formato HH:mm.");

const bookingSettingsProposalSchema = z.strictObject({
  kind: z.literal("BOOKING_SETTINGS"),
  rollingCapacityCovers: z
    .number()
    .int("La capacità deve essere un numero intero.")
    .positive("La capacità deve essere positiva."),
  lunchModificationCutoff: timeSchema,
  dinnerModificationCutoff: timeSchema,
});

const weeklyScheduleProposalSchema = z
  .strictObject({
    kind: z.literal("WEEKLY_SCHEDULE"),
    id: z.uuid("Identificativo del servizio non valido."),
    dayOfWeek: z.enum(DAY_OF_WEEK_VALUES),
    serviceType: z.enum(SERVICE_TYPE_VALUES),
    isEnabled: z.boolean(),
    startTime: timeSchema,
    endTime: timeSchema,
  })
  .refine(
    (value) =>
      operationalTimeToMinutes(value.startTime) <
      operationalTimeToMinutes(value.endTime),
    {
      message: "L'orario iniziale deve precedere quello finale.",
      path: ["endTime"],
    },
  );

const bookingCutoffRuleProposalSchema = z.strictObject({
  kind: z.literal("BOOKING_CUTOFF_RULE"),
  dayOfWeek: z.enum(DAY_OF_WEEK_VALUES),
  serviceType: z.enum(SERVICE_TYPE_VALUES),
  isEnabled: z.boolean(),
  cutoffTime: timeSchema,
});

export const operationalChangeProposalSchema = z.discriminatedUnion("kind", [
  bookingSettingsProposalSchema,
  weeklyScheduleProposalSchema,
  bookingCutoffRuleProposalSchema,
]);

export const operationalChangeConfirmationSchema = z.strictObject({
  proposal: operationalChangeProposalSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export type BookingSettingsProposal = z.infer<
  typeof bookingSettingsProposalSchema
>;
export type WeeklyScheduleProposal = z.infer<
  typeof weeklyScheduleProposalSchema
>;
export type BookingCutoffRuleProposal = z.infer<
  typeof bookingCutoffRuleProposalSchema
>;
export type OperationalChangeProposal = z.infer<
  typeof operationalChangeProposalSchema
>;

export const IMPACT_CLASSIFICATIONS = [
  "SERVICE_DISABLED",
  "OUTSIDE_NEW_HOURS",
  "CAPACITY_EXCEEDED",
  "MODIFICATION_CUTOFF_CHANGED",
  "NO_EXISTING_RESERVATION_IMPACT",
] as const;

export type ImpactClassification =
  (typeof IMPACT_CLASSIFICATIONS)[number];

export interface ConfigurationImpactItem {
  reservationCount: number;
  covers: number;
  classification: ImpactClassification;
  localDate: string | null;
  serviceType: "LUNCH" | "DINNER" | null;
  slot: string | null;
  previousLimit: number | null;
  proposedLimit: number | null;
  maxLoad: number | null;
}

export interface ConfigurationImpactDto {
  reservationCount: number;
  covers: number;
  items: ConfigurationImpactItem[];
}
