"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ReservationActions(props: {
  reservationId: string;
  version: number;
  cancelled: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancelReservation() {
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/staff/reservations/${props.reservationId}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: props.version }),
        },
      );
      const body = (await response.json()) as { error?: string };

      if (!response.ok) {
        setError(body.error ?? "Non è stato possibile cancellare.");
        return;
      }

      setConfirming(false);
      router.refresh();
    } catch {
      setError("Errore di rete. Riprova senza chiudere la pagina.");
    } finally {
      setSubmitting(false);
    }
  }

  if (props.cancelled) return null;

  return (
    <div className="mt-5 border-t border-zinc-200 pt-4">
      <div className="flex flex-wrap gap-2">
        <Link
          className="rounded-lg bg-zinc-950 px-4 py-2 text-sm font-bold text-white transition hover:bg-orange-600 focus:outline-none focus:ring-4 focus:ring-orange-200"
          href={`/dashboard/reservations/${props.reservationId}/edit`}
        >
          Modifica
        </Link>
        {!confirming ? (
          <button
            className="rounded-lg border border-red-300 px-4 py-2 text-sm font-bold text-red-700 transition hover:bg-red-50 focus:outline-none focus:ring-4 focus:ring-red-100"
            onClick={() => setConfirming(true)}
            type="button"
          >
            Cancella
          </button>
        ) : null}
      </div>

      {confirming ? (
        <div
          className="mt-3 rounded-xl border border-red-200 bg-red-50 p-4"
          role="alertdialog"
          aria-labelledby={`cancel-title-${props.reservationId}`}
        >
          <p
            className="font-bold text-red-950"
            id={`cancel-title-${props.reservationId}`}
          >
            Confermi la cancellazione logica?
          </p>
          <p className="mt-1 text-sm text-red-800">
            La prenotazione resterà nello storico e i coperti verranno liberati.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              className="rounded-lg bg-red-700 px-4 py-2 text-sm font-bold text-white focus:outline-none focus:ring-4 focus:ring-red-200 disabled:opacity-60"
              disabled={submitting}
              onClick={cancelReservation}
              type="button"
            >
              {submitting ? "Cancellazione…" : "Sì, cancella"}
            </button>
            <button
              className="rounded-lg bg-white px-4 py-2 text-sm font-bold text-zinc-800 focus:outline-none focus:ring-4 focus:ring-zinc-200"
              disabled={submitting}
              onClick={() => setConfirming(false)}
              type="button"
            >
              Indietro
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm font-bold text-red-800" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
