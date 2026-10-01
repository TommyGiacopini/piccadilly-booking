"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

interface ArrivalMutationResponse {
  changed?: boolean;
  reservationVersion?: number;
  arrivedAt?: string | null;
  error?: string;
  code?: string;
}

export function ReservationArrivalControl(props: {
  reservationId: string;
  version: number;
  arrivedAt: string | null;
  cancelled: boolean;
  historical: boolean;
  onCommitted: (result: {
    version: number;
    arrivedAt: string | null;
  }) => void;
}) {
  const router = useRouter();
  const requestInFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const arrived = props.arrivedAt !== null;
  const actionLabel = arrived
    ? props.cancelled || props.historical
      ? "Rimuovi arrivo registrato"
      : "Segna atteso"
    : "Segna arrivato";

  async function updateArrival() {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setPending(true);
    setMessage(null);
    setError(null);

    try {
      const response = await fetch(
        `/api/staff/reservations/${props.reservationId}/arrival`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: props.version, arrived: !arrived }),
        },
      );
      const body = (await response.json()) as ArrivalMutationResponse;
      if (!response.ok) {
        if (body.code === "VERSION_CONFLICT") {
          setError("La prenotazione è stata aggiornata da un altro operatore.");
          router.refresh();
          return;
        }
        setError(
          body.error ?? "Non è stato possibile aggiornare lo stato di arrivo.",
        );
        return;
      }
      if (
        typeof body.reservationVersion !== "number" ||
        !(typeof body.arrivedAt === "string" || body.arrivedAt === null)
      ) {
        setError("La risposta ricevuta non è valida. Ricarica la pagina.");
        return;
      }

      props.onCommitted({
        version: body.reservationVersion,
        arrivedAt: body.arrivedAt,
      });
      setMessage(
        body.changed === false
          ? "Lo stato di arrivo era già aggiornato."
          : body.arrivedAt
            ? "Arrivo registrato."
            : "Arrivo annullato.",
      );
      router.refresh();
    } catch {
      setError("Errore di rete. Lo stato precedente è stato conservato.");
    } finally {
      requestInFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="mt-4 border-t border-border pt-4">
      <button
        aria-busy={pending}
        className="min-h-11 rounded-control border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-text-primary hover:border-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-wait disabled:opacity-60"
        data-testid="arrival-action"
        disabled={pending}
        onClick={() => void updateArrival()}
        type="button"
      >
        {pending ? "Aggiornamento arrivo…" : actionLabel}
      </button>
      {message ? (
        <p className="mt-2 text-sm font-medium text-success" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
