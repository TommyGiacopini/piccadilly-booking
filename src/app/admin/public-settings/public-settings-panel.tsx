"use client";

import { useState, type FormEvent } from "react";

import {
  buttonClassName,
  fieldClassName,
} from "@/app/admin/_components/configuration-shell";

type Locale = "IT" | "EN";
type ContentKey =
  | "BOOKING_PAGE_TITLE"
  | "BOOKING_PAGE_INTRO"
  | "UNAVAILABLE_MESSAGE"
  | "CONTACT_PROMPT"
  | "CONFIRMATION_MESSAGE"
  | "MANAGEMENT_PAGE_TITLE"
  | "MANAGEMENT_PAGE_INTRO";

interface PublicContacts {
  publicPhone: string;
  publicBookingBaseUrl: string;
  publicEmail: string | null;
  whatsappNumber: string | null;
}

type PublicContents = Record<Locale, Record<ContentKey, string>>;

interface PublicSettingsConfiguration {
  contacts: PublicContacts | null;
  contents: PublicContents | null;
  managementLinkDurationHours: number;
  fingerprints: { contacts: string; contents: string; duration: string };
}

const contentFields: Array<{
  key: ContentKey;
  label: string;
  title?: boolean;
}> = [
  { key: "BOOKING_PAGE_TITLE", label: "Titolo prenotazione", title: true },
  { key: "BOOKING_PAGE_INTRO", label: "Introduzione prenotazione" },
  { key: "UNAVAILABLE_MESSAGE", label: "Messaggio non disponibile" },
  { key: "CONTACT_PROMPT", label: "Invito al contatto" },
  { key: "CONFIRMATION_MESSAGE", label: "Conferma prenotazione" },
  { key: "MANAGEMENT_PAGE_TITLE", label: "Titolo pagina personale", title: true },
  { key: "MANAGEMENT_PAGE_INTRO", label: "Introduzione pagina personale" },
];

async function postConfiguration(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(result.error ?? "Salvataggio non riuscito.");
  }
}

export function PublicSettingsPanel({
  configuration,
}: {
  configuration: PublicSettingsConfiguration;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage("Configurazione salvata.");
      window.location.reload();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Salvataggio non riuscito.",
      );
    } finally {
      setBusy(null);
    }
  }

  function saveContacts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run("contacts", () =>
      postConfiguration("/api/admin/public-settings/contacts", {
        fingerprint: configuration.fingerprints.contacts,
        contacts: {
          publicPhone: String(data.get("publicPhone")),
          publicBookingBaseUrl: String(data.get("publicBookingBaseUrl")),
          publicEmail: String(data.get("publicEmail")),
          whatsappNumber: String(data.get("whatsappNumber")),
        },
      }),
    );
  }

  function saveContents(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const contents = Object.fromEntries(
      (["IT", "EN"] as const).map((locale) => [
        locale,
        Object.fromEntries(
          contentFields.map(({ key }) => [
            key,
            String(data.get(`${locale}.${key}`)),
          ]),
        ),
      ]),
    );
    void run("contents", () =>
      postConfiguration("/api/admin/public-settings/content", {
        fingerprint: configuration.fingerprints.contents,
        contents,
      }),
    );
  }

  function saveDuration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run("duration", () =>
      postConfiguration("/api/admin/public-settings/link-duration", {
        fingerprint: configuration.fingerprints.duration,
        managementLinkDurationHours: Number(
          data.get("managementLinkDurationHours"),
        ),
      }),
    );
  }

  return (
    <div className="space-y-6">
      {error ? (
        <p className="rounded-2xl bg-red-50 p-4 font-bold text-red-800" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="rounded-2xl bg-emerald-50 p-4 font-bold text-emerald-800" role="status">
          {message}
        </p>
      ) : null}

      <section className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-8">
        <h2 className="text-xl font-black">Contatti e URL pubblico</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          I collegamenti restano azioni esplicite del cliente; non parte alcun invio automatico.
        </p>
        <form className="mt-6 grid gap-5 md:grid-cols-2" onSubmit={saveContacts}>
          <label className="text-sm font-bold">
            Telefono pubblico E.164
            <input className={fieldClassName} defaultValue={configuration.contacts?.publicPhone ?? ""} name="publicPhone" placeholder="+390000000000" required />
          </label>
          <label className="text-sm font-bold">
            URL canonico HTTPS
            <input className={fieldClassName} defaultValue={configuration.contacts?.publicBookingBaseUrl ?? ""} name="publicBookingBaseUrl" placeholder="https://prenota.example.test/" required type="url" />
          </label>
          <label className="text-sm font-bold">
            Email pubblica facoltativa
            <input className={fieldClassName} defaultValue={configuration.contacts?.publicEmail ?? ""} name="publicEmail" placeholder="demo@example.test" type="email" />
          </label>
          <label className="text-sm font-bold">
            WhatsApp facoltativo E.164
            <input className={fieldClassName} defaultValue={configuration.contacts?.whatsappNumber ?? ""} name="whatsappNumber" placeholder="+390000000001" />
          </label>
          <div className="md:col-span-2">
            <button className={buttonClassName} disabled={busy !== null} type="submit">
              {busy === "contacts" ? "Salvataggio…" : "Salva contatti"}
            </button>
          </div>
        </form>
      </section>

      <section className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-8">
        <h2 className="text-xl font-black">Contenuti editoriali completi</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          Il salvataggio comprende sempre tutte le sette chiavi per entrambe le lingue. Il pubblico le visualizza come testo semplice.
        </p>
        <form className="mt-6" onSubmit={saveContents}>
          <div className="grid gap-6 xl:grid-cols-2">
            {(["IT", "EN"] as const).map((locale) => (
              <fieldset className="min-w-0 rounded-3xl bg-zinc-100 p-5 sm:p-6" key={locale}>
                <legend className="px-2 text-lg font-black">
                  {locale === "IT" ? "Italiano" : "English"}
                </legend>
                <div className="mt-2 space-y-5">
                  {contentFields.map((field) => (
                    <label className="block text-sm font-bold" key={field.key}>
                      {field.label}
                      <textarea
                        className={fieldClassName}
                        defaultValue={configuration.contents?.[locale][field.key] ?? ""}
                        maxLength={field.title ? 120 : 1000}
                        name={`${locale}.${field.key}`}
                        required
                        rows={field.title ? 2 : 4}
                      />
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <button className={`${buttonClassName} mt-6`} disabled={busy !== null} type="submit">
            {busy === "contents" ? "Salvataggio…" : "Salva contenuti IT/EN"}
          </button>
        </form>
      </section>

      <section className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-8">
        <h2 className="text-xl font-black">Durata dei nuovi link personali</h2>
        <p className="mt-2 rounded-2xl border border-orange-200 bg-orange-50 p-4 text-sm font-bold text-orange-950">
          La nuova durata si applica soltanto ai link creati successivamente.
        </p>
        <form className="mt-6 flex flex-col items-start gap-4 sm:flex-row sm:items-end" onSubmit={saveDuration}>
          <label className="w-full max-w-xs text-sm font-bold">
            Ore dopo l’orario prenotato (1–24)
            <input className={fieldClassName} defaultValue={configuration.managementLinkDurationHours} max="24" min="1" name="managementLinkDurationHours" required step="1" type="number" />
          </label>
          <button className={buttonClassName} disabled={busy !== null} type="submit">
            {busy === "duration" ? "Salvataggio…" : "Salva durata"}
          </button>
        </form>
      </section>
    </div>
  );
}
