import {
  buttonClassName,
  ConfigurationShell,
  fieldClassName,
  StatusBanner,
} from "@/app/admin/_components/configuration-shell";
import { getOperationalConfiguration } from "@/modules/configuration/application/configuration-service";
import {
  SPECIAL_DATE_SCOPE_LABELS,
  SPECIAL_DATE_SCOPE_VALUES,
} from "@/modules/configuration/domain/defaults";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ message?: string; status?: string }>;
}

function ScopeOptions() {
  return SPECIAL_DATE_SCOPE_VALUES.map((scope) => (
    <option key={scope} value={scope}>
      {SPECIAL_DATE_SCOPE_LABELS[scope]}
    </option>
  ));
}

export default async function SpecialDatesPage({ searchParams }: PageProps) {
  const user = await requireAdmin("/admin/special-dates");
  const configuration = await getOperationalConfiguration(user);
  const parameters = await searchParams;

  return (
    <ConfigurationShell
      description="Chiusure e variazioni locali per una data specifica. ALL indica l'intera giornata; LUNCH e DINNER limitano l'eccezione al servizio scelto."
      title="Date speciali"
    >
      <StatusBanner
        message={parameters.message}
        status={parameters.status}
      />

      <section className="rounded-3xl border border-orange-200 bg-orange-50 p-6">
        <h2 className="text-xl font-black">Aggiungi una data speciale</h2>
        <form
          action="/api/admin/configuration"
          className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          method="post"
        >
          <input name="action" type="hidden" value="create-special-date" />
          <label className="text-xs font-bold">
            Data locale
            <input className={fieldClassName} name="date" required type="date" />
          </label>
          <label className="text-xs font-bold">
            Ambito
            <select className={fieldClassName} name="scope">
              <ScopeOptions />
            </select>
          </label>
          <label className="text-xs font-bold">
            Orario speciale iniziale
            <input className={fieldClassName} name="specialStartTime" type="time" />
          </label>
          <label className="text-xs font-bold">
            Orario speciale finale
            <input className={fieldClassName} name="specialEndTime" type="time" />
          </label>
          <label className="text-xs font-bold">
            Capacità speciale
            <input
              className={fieldClassName}
              min="1"
              name="specialCapacityCovers"
              type="number"
            />
          </label>
          <label className="text-xs font-bold sm:col-span-2">
            Note operative fittizie
            <input
              className={fieldClassName}
              maxLength={500}
              name="operationalNotes"
            />
          </label>
          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 pb-3 text-sm font-bold">
              <input name="isClosed" type="checkbox" />
              Chiusura
            </label>
            <button className={`${buttonClassName} mb-0.5`} type="submit">
              Aggiungi
            </button>
          </div>
        </form>
      </section>

      <div className="mt-6 space-y-4">
        {configuration.specialDateOverrides.length === 0 ? (
          <p className="rounded-2xl border border-zinc-200 bg-white p-6 text-zinc-600">
            Nessuna data speciale configurata.
          </p>
        ) : null}

        {configuration.specialDateOverrides.map((override) => (
          <section
            className={`rounded-3xl border p-5 shadow-sm ${
              override.archivedAt
                ? "border-zinc-300 bg-zinc-100"
                : "border-zinc-200 bg-white"
            }`}
            key={override.id}
          >
            {override.archivedAt ? (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-zinc-500">
                    Data archiviata
                  </p>
                  <h2 className="mt-1 text-lg font-black">
                    {override.date} · {SPECIAL_DATE_SCOPE_LABELS[override.scope]}
                  </h2>
                </div>
                <form action="/api/admin/configuration" method="post">
                  <input
                    name="action"
                    type="hidden"
                    value="reactivate-special-date"
                  />
                  <input name="id" type="hidden" value={override.id} />
                  <button className={buttonClassName} type="submit">
                    Ripristina
                  </button>
                </form>
              </div>
            ) : (
              <>
                <form
                  action="/api/admin/configuration"
                  className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
                  method="post"
                >
                  <input
                    name="action"
                    type="hidden"
                    value="update-special-date"
                  />
                  <input name="id" type="hidden" value={override.id} />
                  <label className="text-xs font-bold">
                    Data locale
                    <input
                      className={fieldClassName}
                      defaultValue={override.date}
                      name="date"
                      required
                      type="date"
                    />
                  </label>
                  <label className="text-xs font-bold">
                    Ambito
                    <select
                      className={fieldClassName}
                      defaultValue={override.scope}
                      name="scope"
                    >
                      <ScopeOptions />
                    </select>
                  </label>
                  <label className="text-xs font-bold">
                    Inizio speciale
                    <input
                      className={fieldClassName}
                      defaultValue={override.specialStartTime ?? ""}
                      name="specialStartTime"
                      type="time"
                    />
                  </label>
                  <label className="text-xs font-bold">
                    Fine speciale
                    <input
                      className={fieldClassName}
                      defaultValue={override.specialEndTime ?? ""}
                      name="specialEndTime"
                      type="time"
                    />
                  </label>
                  <label className="text-xs font-bold">
                    Capacità speciale
                    <input
                      className={fieldClassName}
                      defaultValue={override.specialCapacityCovers ?? ""}
                      min="1"
                      name="specialCapacityCovers"
                      type="number"
                    />
                  </label>
                  <label className="text-xs font-bold sm:col-span-2">
                    Note operative
                    <input
                      className={fieldClassName}
                      defaultValue={override.operationalNotes ?? ""}
                      maxLength={500}
                      name="operationalNotes"
                    />
                  </label>
                  <div className="flex items-end justify-between gap-3">
                    <label className="flex items-center gap-2 pb-3 text-sm font-bold">
                      <input
                        defaultChecked={override.isClosed}
                        name="isClosed"
                        type="checkbox"
                      />
                      Chiusura
                    </label>
                    <button
                      className={`${buttonClassName} mb-0.5`}
                      type="submit"
                    >
                      Salva
                    </button>
                  </div>
                </form>

                <form
                  action="/api/admin/configuration"
                  className="mt-3"
                  method="post"
                >
                  <input
                    name="action"
                    type="hidden"
                    value="archive-special-date"
                  />
                  <input name="id" type="hidden" value={override.id} />
                  <button
                    className="text-sm font-bold text-red-700 underline underline-offset-4"
                    type="submit"
                  >
                    Archivia data speciale
                  </button>
                </form>
              </>
            )}
          </section>
        ))}
      </div>
    </ConfigurationShell>
  );
}
