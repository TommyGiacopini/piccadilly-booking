"use client";

import { useState } from "react";

export function PasswordField({
  autoComplete,
  describedBy,
  id,
  label,
  maxLength,
  minLength,
  name,
}: {
  autoComplete: "current-password" | "new-password";
  describedBy?: string;
  id: string;
  label: string;
  maxLength: number;
  minLength: number;
  name: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label className="block text-sm font-medium text-text-primary" htmlFor={id}>
        {label}
      </label>
      <div className="relative mt-2">
        <input
          aria-describedby={describedBy}
          autoComplete={autoComplete}
          className="block min-h-12 w-full rounded-control border border-border bg-surface px-3.5 py-2.5 pr-24 text-md text-text-primary transition-colors placeholder:text-text-muted hover:border-border-strong focus:border-focus"
          id={id}
          maxLength={maxLength}
          minLength={minLength}
          name={name}
          required
          type={visible ? "text" : "password"}
        />
        <button
          aria-controls={id}
          aria-label={visible ? "Nascondi contenuto" : "Mostra contenuto"}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 min-h-11 min-w-20 rounded-r-control px-3 text-sm font-semibold text-brand-primary hover:bg-brand-primary-subtle"
          onClick={() => setVisible((current) => !current)}
          type="button"
        >
          {visible ? "Nascondi" : "Mostra"}
        </button>
      </div>
    </div>
  );
}
