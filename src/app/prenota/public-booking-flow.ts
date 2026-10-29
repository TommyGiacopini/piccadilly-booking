import { isLocalDate, isOperationalTime } from "@/modules/configuration/domain/operational-time";
import { publicCreateReservationSchema } from "@/modules/reservations/domain/public-validation";
import type { ClientSubmissionIdentity } from "@/shared/client/client-idempotency";

export type Section = 1 | 2 | 3;
export type Language = "it" | "en";
export interface BookingValues {
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  arrivalTime: string;
  partySize: number;
  customerFirstName: string;
  customerLastName: string;
  customerPhone: string;
  customerEmail: string;
  highChair: boolean;
  stroller: boolean;
  accessibility: boolean;
  celiac: boolean;
  allergies: string;
  intolerances: string;
  celebration: string;
  animals: boolean;
  notes: string;
  privacyAccepted: boolean;
  termsAccepted: boolean;
}
export const initialBookingValues: BookingValues = {
  localDate: "", serviceType: "DINNER", arrivalTime: "", partySize: 2,
  customerFirstName: "", customerLastName: "", customerPhone: "", customerEmail: "",
  highChair: false, stroller: false, accessibility: false, celiac: false,
  allergies: "", intolerances: "", celebration: "", animals: false, notes: "",
  privacyAccepted: false, termsAccepted: false,
};
export type BookingPayload = BookingValues & {
  childrenCount: number | null;
  gameRoomPreference: boolean | null;
  language: Language;
};
export interface AvailabilityQuery {
  localDate: string;
  serviceType: "LUNCH" | "DINNER";
  partySize: number;
}
export interface AvailabilityState {
  status: "IDLE" | "LOADING" | "READY" | "EMPTY" | "ERROR";
  key: string | null;
  generation: number;
  slots: string[];
}
export const idleAvailability: AvailabilityState = { status: "IDLE", key: null, generation: 0, slots: [] };
export function availabilityQuery(values: AvailabilityQuery): string | null {
  return isLocalDate(values.localDate) && Number.isInteger(values.partySize) && values.partySize > 0
    ? JSON.stringify([values.localDate, values.serviceType, values.partySize]) : null;
}
export function settleAvailability(current: AvailabilityState, key: string, generation: number, body: unknown): AvailabilityState {
  if (current.key !== key || current.generation !== generation) return current;
  if (!body || typeof body !== "object" || !("slots" in body) || !Array.isArray(body.slots) ||
    !("isOpen" in body) || typeof body.isOpen !== "boolean" ||
    body.slots.some(slot => !slot || typeof slot !== "object" || typeof slot.time !== "string" ||
      !isOperationalTime(slot.time) || typeof slot.available !== "boolean")) {
    return { ...current, status: "ERROR", slots: [] };
  }
  const slots: string[] = body.isOpen ? body.slots.filter(slot => slot.available).map(slot => slot.time) : [];
  return { ...current, status: slots.length ? "READY" : "EMPTY", slots };
}
export function hasCurrentSlot(state: AvailabilityState, values: BookingValues): boolean {
  return state.status === "READY" && state.key === availabilityQuery(values) && state.slots.includes(values.arrivalTime);
}
export interface FieldIssue { field: string; section: Section }
export function fieldSection(field: string): Section {
  return ["localDate", "serviceType", "partySize", "arrivalTime"].includes(field) ? 1
    : ["childrenCount", "gameRoomPreference", "highChair", "stroller", "accessibility", "celiac", "allergies", "intolerances", "celebration", "animals", "notes"].includes(field) ? 2 : 3;
}
export function bookingIssues(payload: BookingPayload, availability: AvailabilityState, through: Section, composition?: { mode: string; count: string; games: string }): FieldIssue[] {
  const result = publicCreateReservationSchema.safeParse(payload);
  const fields = result.success ? [] : result.error.issues.map(issue => String(issue.path[0]));
  // Preserve the native composition controls' required/min constraints before serializing.
  if (composition) {
    if (!["adults", "children"].includes(composition.mode)) fields.push("childrenCount");
    if (composition.mode === "children") {
      if (!composition.count.trim() || !Number.isInteger(Number(composition.count)) || Number(composition.count) < 1 || Number(composition.count) > payload.partySize) fields.push("childrenCount");
      if (!["yes", "no"].includes(composition.games)) fields.push("gameRoomPreference");
    }
  }
  if (!hasCurrentSlot(availability, payload)) fields.push("arrivalTime");
  return Array.from(new Set(fields)).map(field => ({ field, section: fieldSection(field) })).filter(issue => issue.section <= through);
}
export function reachSection(reached: Section, requested: Section): Section { return Math.max(reached, requested) as Section; }
export interface SubmissionAttempt extends ClientSubmissionIdentity {
  id: number;
  payload: Readonly<BookingPayload>;
}
export function freezeAttempt(payload: BookingPayload, identity: ClientSubmissionIdentity, id: number): SubmissionAttempt {
  return Object.freeze({ ...identity, id, payload: Object.freeze({ ...payload }) });
}
export function ownsAttempt(current: SubmissionAttempt | null, attempt: SubmissionAttempt): boolean {
  return current === attempt && current.id === attempt.id;
}
