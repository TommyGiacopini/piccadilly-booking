"use client";

import { useRef, useState, type FormEvent } from "react";

interface ReservationCreateFormProps {
  isAdmin: boolean;
  privacyPolicyVersion: string;
}

interface SubmissionIdentity {
  signature: string;
  key: string;
}

const fieldClassName =
  "mt-2 block w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-base text-zinc-950 outline-none transition focus:border-orange-500 focus:ring-4 focus:ring-orange-100";

function stringValue(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export function ReservationCreateForm({
  isAdmin,
  privacyPolicyVersion,
}: ReservationCreateFormProps) {
  const [origin, setOrigin] = useState<"STAFF" | "PHONE">("PHONE");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const submissionIdentity = useRef<SubmissionIdentity | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);

    const formData = new FormData(event.currentTarget);
    const capacityOverride = isAdmin && formData.get("capacityOverride") === "on";
    const payload = {
      localDate: stringValue(formData, "localDate"),
      serviceType: stringValue(formData, "serviceType"),
      arrivalTime: stringValue(formData, "arrivalTime"),
      partySize: Number(stringValue(formData, "partySize")),
      origin,
      customerFirstName: stringValue(formData, "customerFirstName"),
      customerLastName: stringValue(formData, "customerLastName"),
      customerPhone: stringValue(formData, "customerPhone"),
      customerEmail: stringValue(formData, "customerEmail"),
      notes: stringValue(formData, "notes"),
      preferences: stringValue(formData, "preferences"),
      allergies: stringValue(formData, "allergies"),
      privacyConsentMethod:
        origin === "PHONE" ? "VERBAL" : "STAFF_RECORDED",
      capacityOverride,
      capacityOverrideReason: capacityOverride
        ? stringValue(formData, "capacityOverrideReason")
        : null,
    };
    const signature = JSON.stringify(payload);

    if (submissionIdentity.current?.signature !== signature) {
      submissionIdentity.current = {
        signature,
        key: crypto.randomUUID(),
      };
    }

    try {
      const response = await fetch("/api/staff/reservations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": submissionIdentity.current.key,
        },
        body: signature,
      });
      const body = (await response.json()) as {
        error?: string;
        replayed?: boolean;
        reservation?: { id: string };
      };

      if (!response.ok || !body.reservation) {
        setMessage({
          kind: "error",
          text: body.error ?? "Non è stato possibile creare la prenotazione.",
        });
        return;
      }

      setMessage({
        kind: "success",
        text: `${body.replayed ? "Richiesta già registrata" : "Prenotazione creata"}. ID: ${body.reservation.id}`,
      });
      submissionIdentity.current = null;
    } catch {
      setMessage({
        kind: "error",
        text: "Errore di rete. Riprova: verrà riutilizzata la stessa chiave di idempotenza.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="mt-6 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-9"
      onSubmit={submit}
    >
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-bold text-zinc-800">
          Origine
          <select
            className={fieldClassName}
            name="origin"
            onChange={(event) =>
              setOrigin(event.target.value as "STAFF" | "PHONE")
            }
            value={origin}
          >
            <option value="PHONE">PHONE</option>
            <option value="STAFF">STAFF</option>
          </select>
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Data
          <input className={fieldClassName} name="localDate" required type="date" />
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Servizio
          <select className={fieldClassName} name="serviceType">
            <option value="LUNCH">Pranzo</option>
            <option value="DINNER">Cena</option>
          </select>
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Slot
          <input
            className={fieldClassName}
            name="arrivalTime"
            required
            step="900"
            type="time"
          />
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Coperti
          <input
            className={fieldClassName}
            min="1"
            name="partySize"
            required
            step="1"
            type="number"
          />
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Nome
          <input
            className={fieldClassName}
            maxLength={80}
            name="customerFirstName"
            required
          />
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Cognome
          <input
            className={fieldClassName}
            maxLength={80}
            name="customerLastName"
            required
          />
        </label>

        <label className="text-sm font-bold text-zinc-800">
          Telefono
          <input
            className={fieldClassName}
            maxLength={40}
            name="customerPhone"
            required
            type="tel"
          />
        </label>

        <label className="text-sm font-bold text-zinc-800 sm:col-span-2">
          Email (facoltativa)
          <input
            className={fieldClassName}
            maxLength={254}
            name="customerEmail"
            type="email"
          />
        </label>

        <label className="text-sm font-bold text-zinc-800 sm:col-span-2">
          Preferenze
          <textarea
            className={fieldClassName}
            maxLength={1000}
            name="preferences"
            rows={3}
          />
        </label>

        <label className="text-sm font-bold text-zinc-800 sm:col-span-2">
          Allergie dichiarate
          <textarea
            className={fieldClassName}
            maxLength={1000}
            name="allergies"
            rows={3}
          />
        </label>

        <label className="text-sm font-bold text-zinc-800 sm:col-span-2">
          Note operative
          <textarea
            className={fieldClassName}
            maxLength={1000}
            name="notes"
            rows={3}
          />
        </label>
      </div>

      <section className="mt-6 rounded-2xl bg-zinc-100 p-5">
        <label className="flex items-start gap-3 text-sm font-bold text-zinc-800">
          <input className="mt-1 size-4" name="privacyConfirmed" required type="checkbox" />
          <span>
            Confermo di aver registrato il consenso {origin === "PHONE" ? "verbale" : "dello staff"}.
            Versione tecnica locale: {privacyPolicyVersion} (non è una policy legale definitiva).
          </span>
        </label>
      </section>

      {isAdmin ? (
        <section className="mt-6 rounded-2xl border border-orange-200 bg-orange-50 p-5">
          <label className="flex items-center gap-3 text-sm font-black text-orange-950">
            <input className="size-4" name="capacityOverride" type="checkbox" />
            Override esplicito della sola capacità (ADMIN)
          </label>
          <label className="mt-4 block text-sm font-bold text-orange-950">
            Motivo dell&apos;override
            <textarea
              className={fieldClassName}
              maxLength={500}
              name="capacityOverrideReason"
              rows={2}
            />
          </label>
        </section>
      ) : null}

      {message ? (
        <div
          className={`mt-6 rounded-2xl px-5 py-4 text-sm font-bold ${
            message.kind === "success"
              ? "border border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border border-red-200 bg-red-50 text-red-800"
          }`}
          role={message.kind === "error" ? "alert" : "status"}
        >
          {message.text}
        </div>
      ) : null}

      <button
        className="mt-7 rounded-xl bg-zinc-950 px-6 py-3.5 font-bold text-white transition hover:bg-orange-600 focus:ring-4 focus:ring-orange-200 focus:outline-none disabled:cursor-wait disabled:opacity-60"
        disabled={submitting}
        type="submit"
      >
        {submitting ? "Salvataggio…" : "Crea prenotazione"}
      </button>
    </form>
  );
}
