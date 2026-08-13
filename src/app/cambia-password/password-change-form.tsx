"use client";

import { FormEvent, useState } from "react";

const fieldClass =
  "mt-2 block w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-base outline-none focus:border-orange-500 focus:ring-4 focus:ring-orange-100";

export function PasswordChangeForm({ mandatory }: { mandatory: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: data.get("currentPassword"),
          newPassword: data.get("newPassword"),
          confirmPassword: data.get("confirmPassword"),
        }),
        cache: "no-store",
      });
      const result = (await response.json()) as { error?: string };
      form.reset();

      if (!response.ok) {
        setError(result.error ?? "Non è stato possibile cambiare la password.");
        return;
      }

      window.location.replace("/login?passwordChanged=1");
    } catch {
      form.reset();
      setError("Non è stato possibile cambiare la password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-7 space-y-5" onSubmit={submit}>
      {error ? <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-800" role="alert">{error}</p> : null}
      {mandatory ? <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-900">Devi scegliere una password personale prima di usare le funzioni operative.</p> : null}
      <label className="block text-sm font-bold text-zinc-800">
        Password attuale
        <input autoComplete="current-password" className={fieldClass} maxLength={256} name="currentPassword" required type="password" />
      </label>
      <label className="block text-sm font-bold text-zinc-800">
        Nuova password
        <input aria-describedby="password-rules" autoComplete="new-password" className={fieldClass} maxLength={256} minLength={15} name="newPassword" required type="password" />
      </label>
      <label className="block text-sm font-bold text-zinc-800">
        Conferma nuova password
        <input autoComplete="new-password" className={fieldClass} maxLength={256} minLength={15} name="confirmPassword" required type="password" />
      </label>
      <p className="text-xs leading-5 text-zinc-500" id="password-rules">
        Usa da 15 a 128 caratteri. Sono ammessi spazi e caratteri Unicode stampabili; evita password comuni, lo username e la password attuale. Non imponiamo composizioni artificiali.
      </p>
      <button className="w-full rounded-xl bg-orange-600 px-5 py-3.5 font-black text-white disabled:opacity-50" disabled={busy} type="submit">
        {busy ? "Salvataggio…" : "Cambia password"}
      </button>
    </form>
  );
}
