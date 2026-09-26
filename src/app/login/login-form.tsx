"use client";

import { useState } from "react";

import { Button } from "@/app/_components/ui/button";
import { PasswordField } from "@/app/_components/ui/password-field";

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [busy, setBusy] = useState(false);

  function submit(form: HTMLFormElement) {
    setBusy(true);
    window.requestAnimationFrame(() => form.submit());
  }

  return (
    <form
      action="/api/auth/login"
      aria-busy={busy}
      className="mt-7 space-y-5"
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
    >
      <input name="returnTo" type="hidden" value={returnTo} />

      <div>
        <label
          className="block text-sm font-medium text-text-primary"
          htmlFor="username"
        >
          Username
        </label>
        <input
          autoCapitalize="none"
          autoComplete="username"
          className="mt-2 block min-h-12 w-full rounded-control border border-border bg-surface px-3.5 py-2.5 text-md text-text-primary transition-colors hover:border-border-strong focus:border-focus"
          id="username"
          maxLength={64}
          minLength={3}
          name="username"
          required
          spellCheck={false}
          type="text"
        />
      </div>

      <PasswordField
        autoComplete="current-password"
        id="password"
        label="Password"
        maxLength={128}
        minLength={12}
        name="password"
      />

      <Button disabled={busy} fullWidth type="submit">
        <span aria-live="polite">{busy ? "Accesso in corso…" : "Accedi"}</span>
      </Button>
    </form>
  );
}
