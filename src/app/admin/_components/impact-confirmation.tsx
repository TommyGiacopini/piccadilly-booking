"use client";

import { useState } from "react";

import type {
  ConfigurationImpactDto,
  OperationalChangeProposal,
} from "@/modules/configuration/domain/operational-change";

interface Preview {
  proposal: OperationalChangeProposal;
  fingerprint: string;
  changed: boolean;
  confirmationRequired: boolean;
  impact: ConfigurationImpactDto;
}

const classificationLabels = {
  SERVICE_DISABLED: "Servizio disabilitato",
  OUTSIDE_NEW_HOURS: "Prenotazione fuori dai nuovi orari",
  CAPACITY_EXCEEDED: "Finestra oltre il nuovo limite",
  MODIFICATION_CUTOFF_CHANGED: "Termine modifica/cancellazione cambiato",
  NO_EXISTING_RESERVATION_IMPACT: "Nessun impatto sulle prenotazioni esistenti",
} as const;

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const result = (await response.json()) as Record<string, unknown>;
  return { response, result };
}

export function useImpactAwareMutation() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingPreview, setPendingPreview] = useState<Preview | null>(null);

  async function apply(preview: Preview) {
    const { response, result } = await postJson(
      "/api/admin/operational-configuration/apply",
      { proposal: preview.proposal, fingerprint: preview.fingerprint },
    );

    if (!response.ok) {
      if (result.code === "IMPACT_CHANGED" && result.preview) {
        setPendingPreview(result.preview as Preview);
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : "L'anteprima è cambiata: controllala di nuovo.",
        );
      }
      throw new Error(
        typeof result.error === "string"
          ? result.error
          : "Salvataggio non riuscito.",
      );
    }

    setPendingPreview(null);
    setMessage(
      result.changed === false
        ? "Nessuna modifica da applicare."
        : "Configurazione salvata.",
    );
  }

  async function propose(proposal: OperationalChangeProposal) {
    setBusy(true);
    setMessage(null);
    try {
      const { response, result } = await postJson(
        "/api/admin/operational-configuration/preview",
        proposal,
      );
      if (!response.ok || !result.preview) {
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : "Anteprima non disponibile.",
        );
      }
      const preview = result.preview as Preview;
      if (!preview.changed) {
        setMessage("Nessuna modifica da applicare.");
      } else if (preview.confirmationRequired) {
        setPendingPreview(preview);
      } else {
        await apply(preview);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operazione non riuscita.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pendingPreview) return;
    setBusy(true);
    setMessage(null);
    try {
      await apply(pendingPreview);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operazione non riuscita.");
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    message,
    pendingPreview,
    propose,
    confirm,
    cancel: () => setPendingPreview(null),
  };
}

export function MutationStatus({ message }: { message: string | null }) {
  return message ? (
    <p
      className="mb-5 rounded-2xl border border-zinc-300 bg-white px-5 py-4 text-sm font-bold text-zinc-800"
      role="status"
    >
      {message}
    </p>
  ) : null;
}

export function ImpactConfirmationDialog({
  busy,
  onCancel,
  onConfirm,
  preview,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  preview: Preview | null;
}) {
  if (!preview) return null;

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 overflow-y-auto bg-black/70 px-4 py-8"
      role="dialog"
    >
      <section className="mx-auto w-full max-w-3xl rounded-3xl bg-white p-5 shadow-2xl sm:p-7">
        <p className="text-xs font-black tracking-widest text-orange-700 uppercase">
          Conferma esplicita richiesta
        </p>
        <h2 className="mt-2 text-2xl font-black text-zinc-950">
          Prenotazioni future coinvolte
        </h2>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          La configurazione può essere applicata senza modificare o cancellare
          le prenotazioni esistenti. Controlla i soli conteggi operativi.
        </p>
        <dl className="mt-5 grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl bg-zinc-100 p-4">
            <dt className="text-xs font-bold text-zinc-500 uppercase">Prenotazioni</dt>
            <dd className="mt-1 text-2xl font-black">{preview.impact.reservationCount}</dd>
          </div>
          <div className="rounded-2xl bg-zinc-100 p-4">
            <dt className="text-xs font-bold text-zinc-500 uppercase">Coperti</dt>
            <dd className="mt-1 text-2xl font-black">{preview.impact.covers}</dd>
          </div>
        </dl>
        <div className="mt-5 grid gap-3">
          {preview.impact.items.map((item, index) => (
            <article
              className="min-w-0 rounded-2xl border border-zinc-200 p-4 text-sm"
              key={`${item.classification}-${item.localDate}-${item.slot}-${index}`}
            >
              <h3 className="font-black text-zinc-950">
                {classificationLabels[item.classification]}
              </h3>
              <p className="mt-1 break-words text-zinc-600">
                {item.localDate ?? "Configurazione generale"}
                {item.serviceType ? ` · ${item.serviceType === "LUNCH" ? "Pranzo" : "Cena"}` : ""}
                {item.slot ? ` · fascia ${item.slot}` : ""}
              </p>
              <p className="mt-2 font-bold text-zinc-800">
                {item.reservationCount} prenotazioni · {item.covers} coperti
                {item.proposedLimit !== null
                  ? ` · limite ${item.previousLimit} → ${item.proposedLimit} · carico ${item.maxLoad}`
                  : ""}
              </p>
            </article>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            className="rounded-xl border border-zinc-300 px-4 py-2.5 font-bold text-zinc-800 disabled:opacity-50"
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            Annulla
          </button>
          <button
            className="rounded-xl bg-orange-600 px-4 py-2.5 font-black text-white disabled:opacity-50"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            Conferma e applica
          </button>
        </div>
      </section>
    </div>
  );
}
