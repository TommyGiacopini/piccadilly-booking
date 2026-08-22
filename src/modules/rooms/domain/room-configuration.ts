import { z } from "zod";

import { SERVICE_TYPE_VALUES } from "@/modules/configuration/domain/defaults";
import { isLocalDate } from "@/modules/configuration/domain/operational-time";

const uuidSchema = z.uuid("Identificativo non valido.");
const displayOrderSchema = z
  .number()
  .int("L'ordine deve essere un numero intero.")
  .min(0, "L'ordine non può essere negativo.");

export const serviceRoomAvailabilityProposalSchema = z.strictObject({
  kind: z.literal("SERVICE_ROOM_AVAILABILITY"),
  localDate: z.string().refine(isLocalDate, "La data non è valida."),
  serviceType: z.enum(SERVICE_TYPE_VALUES),
  roomId: uuidSchema,
  isAvailable: z.boolean(),
});

export const roomCatalogProposalSchema = z.strictObject({
  kind: z.literal("ROOM_CATALOG"),
  roomId: uuidSchema,
  displayOrder: displayOrderSchema,
  isActive: z.boolean(),
});

const diningTableFields = {
  name: z.string().trim().min(1, "Il nome del tavolo è obbligatorio.").max(40),
  minimumSeats: z.number().int().positive(),
  maximumSeats: z.number().int().positive(),
  displayOrder: displayOrderSchema,
};

export const diningTableProposalSchema = z
  .strictObject({
    kind: z.literal("DINING_TABLE"),
    tableId: uuidSchema,
    ...diningTableFields,
    isActive: z.boolean(),
  })
  .refine((value) => value.maximumSeats >= value.minimumSeats, {
    message: "I posti massimi non possono essere inferiori ai posti minimi.",
    path: ["maximumSeats"],
  });

export const roomConfigurationProposalSchema = z.discriminatedUnion("kind", [
  serviceRoomAvailabilityProposalSchema,
  roomCatalogProposalSchema,
  diningTableProposalSchema,
]);

export const roomConfigurationConfirmationSchema = z.strictObject({
  proposal: roomConfigurationProposalSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const diningTableCreateSchema = z
  .strictObject({ roomId: uuidSchema, ...diningTableFields })
  .refine((value) => value.maximumSeats >= value.minimumSeats, {
    message: "I posti massimi non possono essere inferiori ai posti minimi.",
    path: ["maximumSeats"],
  });

export const diningTableMutationSchema = z.discriminatedUnion("action", [
  z
    .strictObject({
      action: z.literal("CREATE_TABLE"),
      roomId: uuidSchema,
      ...diningTableFields,
    })
    .refine((value) => value.maximumSeats >= value.minimumSeats, {
      message: "I posti massimi non possono essere inferiori ai posti minimi.",
      path: ["maximumSeats"],
    }),
  z
    .strictObject({
      action: z.literal("UPDATE_TABLE"),
      id: uuidSchema,
      ...diningTableFields,
      isActive: z.boolean(),
    })
    .refine((value) => value.maximumSeats >= value.minimumSeats, {
      message: "I posti massimi non possono essere inferiori ai posti minimi.",
      path: ["maximumSeats"],
    }),
]);

export const ROOM_IMPACT_CLASSIFICATIONS = [
  "ROOM_UNAVAILABLE",
  "ROOM_DISABLED",
  "TABLE_DISABLED",
  "RESERVATION_WITH_AFFECTED_ROOM_PREFERENCE",
  "RESERVATION_WITH_AFFECTED_FINAL_ASSIGNMENT",
  "NO_EXISTING_RESERVATION_IMPACT",
] as const;

export type RoomConfigurationProposal = z.infer<
  typeof roomConfigurationProposalSchema
>;
export type DiningTableMutation = z.infer<typeof diningTableMutationSchema>;
export type RoomImpactClassification =
  (typeof ROOM_IMPACT_CLASSIFICATIONS)[number];

export interface RoomConfigurationImpact {
  reservationCount: number;
  covers: number;
  preferenceReservationCount: number;
  assignmentReservationCount: number;
  items: Array<{
    classification: RoomImpactClassification;
    classifications: RoomImpactClassification[];
    localDate: string | null;
    serviceType: "LUNCH" | "DINNER" | null;
    roomCode: string;
    reservationCount: number;
    covers: number;
    preferenceReservationCount: number;
    assignmentReservationCount: number;
    previousAvailable: boolean;
    proposedAvailable: boolean;
  }>;
}
