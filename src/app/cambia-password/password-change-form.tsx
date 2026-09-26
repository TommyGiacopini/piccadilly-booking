"use client";

import { FormEvent, useState } from "react";

import { Alert } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { PasswordField } from "@/app/_components/ui/password-field";

export function PasswordChangeForm({ mandatory }: { mandatory: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError(null);
    setSuccess(false);

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

      setSuccess(true);
      window.setTimeout(() => {
        window.location.replace("/login?passwordChanged=1&returnTo=%2Fdashboard");
      }, 900);
    } catch {
      form.reset();
      setError("Non è stato possibile cambiare la password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-busy={busy} className="mt-7 space-y-5" onSubmit={submit}>
      {error ? <Alert>{error}</Alert> : null}
      {success ? (
        <Alert tone="success">
          Password aggiornata. Reindirizzamento all’Agenda…
        </Alert>
      ) : null}
      {mandatory ? (
        <Alert tone="warning">
          Devi scegliere una password personale prima di usare le funzioni operative.
        </Alert>
      ) : null}
      <PasswordField
        autoComplete="current-password"
        id="current-password"
        label="Password attuale"
        maxLength={256}
        minLength={1}
        name="currentPassword"
      />
      <PasswordField
        autoComplete="new-password"
        describedBy="password-rules"
        id="new-password"
        label="Nuova password"
        maxLength={256}
        minLength={15}
        name="newPassword"
      />
      <PasswordField
        autoComplete="new-password"
        describedBy="password-rules"
        id="confirm-password"
        label="Conferma nuova password"
        maxLength={256}
        minLength={15}
        name="confirmPassword"
      />
      <p className="text-xs leading-5 text-text-muted" id="password-rules">
        Usa da 15 a 128 caratteri. Sono ammessi spazi e caratteri Unicode stampabili; evita password comuni, lo username e la password attuale. Non imponiamo composizioni artificiali.
      </p>
      <Button disabled={busy || success} fullWidth type="submit">
        <span aria-live="polite">
          {busy ? "Aggiornamento in corso…" : "Cambia password"}
        </span>
      </Button>
    </form>
  );
}
