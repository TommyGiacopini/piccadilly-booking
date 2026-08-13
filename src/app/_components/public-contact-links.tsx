import type { PublicContacts } from "@/modules/configuration/domain/public-settings";

export function PublicContactLinks({
  contacts,
  language,
}: {
  contacts: PublicContacts;
  language: "it" | "en";
}) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <a className="rounded-full border border-current px-4 py-2 text-sm font-bold" href={`tel:${contacts.publicPhone}`}>
        {language === "it" ? "Telefona" : "Call"}
      </a>
      {contacts.publicEmail ? (
        <a className="rounded-full border border-current px-4 py-2 text-sm font-bold" href={`mailto:${contacts.publicEmail}`}>
          Email
        </a>
      ) : null}
      {contacts.whatsappNumber ? (
        <a
          className="rounded-full border border-current px-4 py-2 text-sm font-bold"
          href={`https://wa.me/${contacts.whatsappNumber.slice(1)}`}
          rel="noreferrer"
        >
          WhatsApp
        </a>
      ) : null}
    </div>
  );
}
