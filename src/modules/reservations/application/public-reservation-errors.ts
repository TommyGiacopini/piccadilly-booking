export type PublicReservationErrorCode =
  | "VALIDATION"
  | "INVALID_LINK"
  | "IDEMPOTENCY_CONFLICT"
  | "CAPACITY_EXCEEDED"
  | "SERVICE_CLOSED"
  | "SLOT_NOT_AVAILABLE"
  | "CUTOFF_REACHED"
  | "RESERVATION_CANCELLED"
  | "CONFIGURATION_INVALID";

export class PublicReservationError extends Error {
  constructor(readonly code: PublicReservationErrorCode) {
    super(code);
    this.name = "PublicReservationError";
  }
}

export function publicReservationErrorStatus(
  code: PublicReservationErrorCode,
): number {
  switch (code) {
    case "VALIDATION":
      return 400;
    case "INVALID_LINK":
      return 404;
    case "IDEMPOTENCY_CONFLICT":
    case "CAPACITY_EXCEEDED":
    case "CUTOFF_REACHED":
    case "RESERVATION_CANCELLED":
      return 409;
    case "SERVICE_CLOSED":
    case "SLOT_NOT_AVAILABLE":
      return 422;
    case "CONFIGURATION_INVALID":
      return 500;
  }
}

export function publicReservationErrorMessage(
  code: PublicReservationErrorCode,
): string {
  switch (code) {
    case "VALIDATION":
      return "I dati inviati non sono validi.";
    case "INVALID_LINK":
      return "Il link non è valido o non è più disponibile.";
    case "IDEMPOTENCY_CONFLICT":
      return "La richiesta è già stata usata con dati diversi.";
    case "CAPACITY_EXCEEDED":
    case "SLOT_NOT_AVAILABLE":
      return "La disponibilità è cambiata. Scegli un altro orario o contatta il ristorante.";
    case "SERVICE_CLOSED":
      return "Il servizio selezionato non è disponibile.";
    case "CUTOFF_REACHED":
      return "La prenotazione è consultabile, ma non può più essere modificata online.";
    case "RESERVATION_CANCELLED":
      return "La prenotazione risulta già annullata.";
    case "CONFIGURATION_INVALID":
      return "Il servizio non è temporaneamente disponibile.";
  }
}
