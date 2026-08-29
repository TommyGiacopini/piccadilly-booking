"use client";

import { useState, type FormEvent } from "react";

import { buttonClassName } from "@/app/admin/_components/configuration-shell";
import type { NotificationStrategy } from "@/modules/notifications/domain/types";

const strategies: Array<{
  value: NotificationStrategy;
  label: string;
  description: string;
}> = [
  {
    value: "WHATSAPP_ONLY",
    label: "Solo WhatsApp",
    description: "Crea esclusivamente la delivery leg WhatsApp.",
  },
  {
    value: "WHATSAPP_WITH_EMAIL_FALLBACK",
    label: "WhatsApp con fallback email",
    description:
      "L’email viene pianificata solo dopo un fallimento permanente o l’esaurimento dei retry WhatsApp.",
  },
  {
    value: "WHATSAPP_AND_EMAIL_PARALLEL",
    label: "WhatsApp + email in parallelo",
    description: "I due canali vengono pianificati e processati indipendentemente.",
  },
];

export function NotificationSettingsPanel({
  strategy,
}: {
  strategy: NotificationStrategy;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/admin/notification-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: data.get("strategy") }),
      });
      const result = (await response.json()) as {
        changed?: boolean;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "Salvataggio non riuscito.");
      setMessage(
        result.changed
          ? "Strategia salvata per i nuovi eventi."
          : "La strategia era già impostata.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Salvataggio non riuscito.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-8">
      {error ? <p className="mb-5 rounded-xl bg-red-50 p-4 font-bold text-red-800" role="alert">{error}</p> : null}
      {message ? <p className="mb-5 rounded-xl bg-emerald-50 p-4 font-bold text-emerald-800" role="status">{message}</p> : null}
      <form onSubmit={submit}>
        <fieldset className="space-y-3">
          <legend className="text-xl font-black">Canali per i nuovi eventi</legend>
          {strategies.map((item) => (
            <label className="flex cursor-pointer gap-3 rounded-2xl border border-zinc-200 p-4" key={item.value}>
              <input defaultChecked={strategy === item.value} name="strategy" required type="radio" value={item.value} />
              <span>
                <span className="block font-black text-zinc-950">{item.label}</span>
                <span className="mt-1 block text-sm leading-6 text-zinc-600">{item.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="mt-5 rounded-xl bg-orange-50 p-4 text-sm font-bold text-orange-950">
          M12 usa soltanto provider simulati; non è disponibile alcuna selezione di provider reale.
        </p>
        <button className={`${buttonClassName} mt-5`} disabled={busy} type="submit">
          {busy ? "Salvataggio…" : "Salva strategia"}
        </button>
      </form>
    </section>
  );
}
