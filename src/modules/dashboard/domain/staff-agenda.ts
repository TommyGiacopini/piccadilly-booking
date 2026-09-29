import type { DashboardReservation } from "@/modules/dashboard/domain/dashboard-domain";

export const STAFF_AGENDA_ORDER_VALUES = [
  "OLDEST",
  "SURNAME",
  "FIRST_NAME",
  "ARRIVAL",
] as const;

export type StaffAgendaOrder = (typeof STAFF_AGENDA_ORDER_VALUES)[number];

export const DEFAULT_STAFF_AGENDA_ORDER: StaffAgendaOrder = "OLDEST";

const phoneQueryPattern = /^[+\d\s()./-]+$/u;

export function normalizeAgendaText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("it-IT")
    .trim()
    .replace(/\s+/gu, " ");
}

export function normalizeAgendaPhone(value: string): string {
  return value.replace(/\D+/gu, "");
}

export function matchesAgendaSearch(
  reservation: DashboardReservation,
  rawQuery: string,
): boolean {
  const query = normalizeAgendaText(rawQuery);
  if (!query) return true;

  if (phoneQueryPattern.test(rawQuery.trim())) {
    const phoneQuery = normalizeAgendaPhone(rawQuery);
    return (
      phoneQuery.length > 0 &&
      normalizeAgendaPhone(reservation.customerPhone).includes(phoneQuery)
    );
  }

  const firstName = normalizeAgendaText(reservation.customerFirstName);
  const lastName = normalizeAgendaText(reservation.customerLastName);
  return (
    firstName.includes(query) ||
    lastName.includes(query) ||
    `${firstName} ${lastName}`.includes(query) ||
    `${lastName} ${firstName}`.includes(query)
  );
}

function compareText(left: string, right: string): number {
  return normalizeAgendaText(left).localeCompare(normalizeAgendaText(right), "it");
}

function compareBookingTimestamp(
  left: DashboardReservation,
  right: DashboardReservation,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

export function compareAgendaReservations(
  left: DashboardReservation,
  right: DashboardReservation,
  order: StaffAgendaOrder,
): number {
  if (order === "SURNAME") {
    return (
      compareText(left.customerLastName, right.customerLastName) ||
      compareText(left.customerFirstName, right.customerFirstName) ||
      compareBookingTimestamp(left, right)
    );
  }

  if (order === "FIRST_NAME") {
    return (
      compareText(left.customerFirstName, right.customerFirstName) ||
      compareText(left.customerLastName, right.customerLastName) ||
      compareBookingTimestamp(left, right)
    );
  }

  if (order === "ARRIVAL") {
    return (
      left.arrivalTime.localeCompare(right.arrivalTime) ||
      compareBookingTimestamp(left, right)
    );
  }

  return compareBookingTimestamp(left, right);
}

export function selectStaffAgendaReservations(
  reservations: readonly DashboardReservation[],
  input: {
    query?: string;
    order?: StaffAgendaOrder;
  } = {},
): DashboardReservation[] {
  const query = input.query ?? "";
  const order = input.order ?? DEFAULT_STAFF_AGENDA_ORDER;

  return reservations
    .filter((reservation) => matchesAgendaSearch(reservation, query))
    .sort((left, right) => compareAgendaReservations(left, right, order));
}
