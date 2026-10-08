import { createHash } from "node:crypto";

import type { CreateReservationCommand } from "@/modules/reservations/domain/types";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalRequest(command: CreateReservationCommand, legacy = false): string {
  return JSON.stringify({
    localDate: command.localDate,
    serviceType: command.serviceType,
    arrivalTime: command.arrivalTime,
    partySize: command.partySize,
    origin: command.origin,
    customerFirstName: command.customerFirstName,
    customerLastName: command.customerLastName,
    customerPhone: command.customerPhone,
    customerEmail: command.customerEmail,
    notes: command.notes,
    preferences: command.preferences,
    allergies: command.allergies,
    privacyConsentMethod: command.privacyConsentMethod,
    capacityOverride: command.capacityOverride,
    capacityOverrideReason: command.capacityOverrideReason,
    ...(legacy ? {} : { childrenCount: command.childrenCount, gameRoomPreference: command.gameRoomPreference }),
  });
}

export function hashIdempotencyKey(
  restaurantId: string,
  rawKey: string,
): string {
  return sha256(`reservation-idempotency\u0000${restaurantId}\u0000${rawKey}`);
}

export function hashReservationRequest(
  command: CreateReservationCommand,
): string {
  return sha256(canonicalRequest(command));
}

export function hashPhoneReservationRequest(
  command: CreateReservationCommand,
  sendWhatsAppConfirmation: boolean,
): string {
  return sha256(
    JSON.stringify({
      reservation: canonicalRequest(command),
      sendWhatsAppConfirmation,
    }),
  );
}

// Exact old request representation, never used for a new reservation write.
export function hashLegacyPhoneReservationRequest(command: CreateReservationCommand, sendWhatsAppConfirmation: boolean): string {
  return sha256(JSON.stringify({ reservation: canonicalRequest(command, true), sendWhatsAppConfirmation }));
}

export function classifyIdempotencyRequest(
  storedRequestHash: string,
  currentRequestHash: string,
): "REPLAY" | "CONFLICT" {
  return storedRequestHash === currentRequestHash ? "REPLAY" : "CONFLICT";
}
