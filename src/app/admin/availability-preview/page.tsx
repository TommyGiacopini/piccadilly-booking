import type { AvailabilityResult } from "@/modules/availability/domain/types";
import { AvailabilityApplicationError } from "@/modules/availability/application/availability-errors";
import { availabilityPreviewQuerySchema } from "@/modules/availability/application/availability-preview-query";
import { getAvailabilityPreview } from "@/modules/availability/application/availability-service";
import {
  ConfigurationShell,
  fieldClassName,
} from "@/app/admin/_components/configuration-shell";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface AvailabilityPreviewPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const SOURCE_LABELS: Record<AvailabilityResult["source"], string> = {
  SPECIAL_DATE_SERVICE: "Eccezione specifica del servizio",
  SPECIAL_DATE_ALL: "Eccezione per l'intera giornata",
  WEEKLY: "Regola settimanale",
};

const REASON_LABELS = {
  SERVICE_CLOSED: "Servizio chiuso",
  SLOT_IN_PAST: "Orario già trascorso",
  ONLINE_CUTOFF_REACHED: "Cutoff online raggiunto",
  CAPACITY_EXCEEDED: "Capacità superata",
  PARTY_SIZE_INVALID: "Numero di coperti non valido",
  CONFIGURATION_INVALID: "Configurazione non valida",
} as const;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AvailabilityPreviewPage({
  searchParams,
}: AvailabilityPreviewPageProps) {
  const user = await requireAdmin("/admin/availability-preview");
  const parameters = await searchParams;
  const rawQuery = {
    date: firstValue(parameters.date),
    service: firstValue(parameters.service),
    partySize: firstValue(parameters.partySize),
    channel: firstValue(parameters.channel) ?? "PUBLIC",
  };
  const hasQuery = Boolean(
    rawQuery.date && rawQuery.service && rawQuery.partySize,
  );
  let result: AvailabilityResult | null = null;
  let errorMessage: string | null = null;

  if (hasQuery) {
    const parsed = availabilityPreviewQuerySchema.safeParse(rawQuery);

    if (!parsed.success) {
      errorMessage =
        parsed.error.issues[0]?.message ?? "I parametri non sono validi.";
    } else {
      try {
        result = await getAvailabilityPreview({
          restaurantId: user.restaurantId,
          date: parsed.data.date,
          serviceType: parsed.data.service,
          partySize: parsed.data.partySize,
          channel: parsed.data.channel,
          now: new Date(),
        });
      } catch (error) {
        if (error instanceof AvailabilityApplicationError) {
          errorMessage = error.publicMessage;
        } else {
          console.error("Availability preview page read failed.");
          errorMessage = "Non è stato possibile calcolare la disponibilità.";
        }
      }
    }
  }

  return (
    <ConfigurationShell
      description="Verifica tecnica server-side di slot, cutoff e capacità mobile. Nessuna prenotazione viene creata o modificata."
      title="Anteprima disponibilità"
    >
      <section className="rounded-3xl border border-orange-200 bg-orange-50 p-5 text-sm font-bold leading-6 text-orange-950">
        Anteprima basata sulla configurazione. Le prenotazioni persistenti non
        sono ancora incluse.
      </section>

      <section className="mt-5 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
        <form className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4" method="get">
          <label className="text-sm font-bold text-zinc-800">
            Data locale
            <input
              className={fieldClassName}
              defaultValue={rawQuery.date}
              name="date"
              required
              type="date"
            />
          </label>

          <label className="text-sm font-bold text-zinc-800">
            Servizio
            <select
              className={fieldClassName}
              defaultValue={rawQuery.service ?? "LUNCH"}
              name="service"
            >
              <option value="LUNCH">Pranzo</option>
              <option value="DINNER">Cena</option>
            </select>
          </label>

          <label className="text-sm font-bold text-zinc-800">
            Coperti richiesti
            <input
              className={fieldClassName}
              defaultValue={rawQuery.partySize ?? "2"}
              min="1"
              name="partySize"
              required
              step="1"
              type="number"
            />
          </label>

          <label className="text-sm font-bold text-zinc-800">
            Canale simulato
            <select
              className={fieldClassName}
              defaultValue={rawQuery.channel}
              name="channel"
            >
              <option value="PUBLIC">PUBLIC</option>
              <option value="STAFF">STAFF</option>
            </select>
          </label>

          <div className="sm:col-span-2 lg:col-span-4">
            <button
              className="rounded-xl bg-zinc-950 px-5 py-3 text-sm font-bold text-white transition hover:bg-orange-600 focus:ring-4 focus:ring-orange-200 focus:outline-none"
              type="submit"
            >
              Calcola anteprima
            </button>
          </div>
        </form>
      </section>

      {errorMessage ? (
        <div
          className="mt-5 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm font-bold text-red-800"
          role="alert"
        >
          {errorMessage}
        </div>
      ) : null}

      {result ? (
        <section className="mt-5 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <dl className="grid gap-4 rounded-2xl bg-zinc-100 p-5 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs font-bold text-zinc-500 uppercase">Data</dt>
              <dd className="mt-1 font-bold">{result.date}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold text-zinc-500 uppercase">
                Servizio / canale
              </dt>
              <dd className="mt-1 font-bold">
                {result.serviceType} / {result.channel}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold text-zinc-500 uppercase">
                Origine
              </dt>
              <dd className="mt-1 font-bold">{SOURCE_LABELS[result.source]}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold text-zinc-500 uppercase">
                Stato
              </dt>
              <dd className="mt-1 font-bold">
                {result.isOpen ? "Aperto" : "Chiuso"}
                {result.reason ? ` · ${REASON_LABELS[result.reason]}` : ""}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold text-zinc-500 uppercase">
                Timezone
              </dt>
              <dd className="mt-1 font-bold">{result.timezone}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold text-zinc-500 uppercase">
                Limite
              </dt>
              <dd className="mt-1 font-bold">{result.capacityLimit ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold text-zinc-500 uppercase">
                Finestra mobile
              </dt>
              <dd className="mt-1 font-bold">
                {result.rollingWindowMinutes
                  ? `${result.rollingWindowMinutes} minuti`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-bold text-zinc-500 uppercase">
                Intervallo slot
              </dt>
              <dd className="mt-1 font-bold">
                {result.slotIntervalMinutes
                  ? `${result.slotIntervalMinutes} minuti`
                  : "—"}
              </dd>
            </div>
          </dl>

          {result.isOpen && result.slots.length === 0 ? (
            <p className="mt-6 rounded-2xl bg-zinc-100 p-5 font-bold text-zinc-700">
              Il servizio è aperto, ma non sono disponibili slot effettivi.
            </p>
          ) : null}

          {result.slots.length > 0 ? (
            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[600px] border-separate border-spacing-0 text-left text-sm">
                <thead>
                  <tr className="text-xs text-zinc-500 uppercase">
                    <th className="border-b border-zinc-200 px-3 py-3">Slot</th>
                    <th className="border-b border-zinc-200 px-3 py-3">
                      Disponibilità di base
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-3">
                      Capacità residua di base
                    </th>
                    <th className="border-b border-zinc-200 px-3 py-3">Motivo</th>
                  </tr>
                </thead>
                <tbody>
                  {result.slots.map((slot) => (
                    <tr key={slot.time}>
                      <td className="border-b border-zinc-100 px-3 py-3 font-black">
                        {slot.time}
                      </td>
                      <td className="border-b border-zinc-100 px-3 py-3">
                        {slot.available ? "Disponibile" : "Non disponibile"}
                      </td>
                      <td className="border-b border-zinc-100 px-3 py-3">
                        {slot.remainingCapacity}
                      </td>
                      <td className="border-b border-zinc-100 px-3 py-3 text-zinc-600">
                        {slot.reason ? REASON_LABELS[slot.reason] : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </ConfigurationShell>
  );
}
