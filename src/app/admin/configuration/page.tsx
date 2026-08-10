import {
  buttonClassName,
  ConfigurationShell,
  fieldClassName,
  StatusBanner,
} from "@/app/admin/_components/configuration-shell";
import { getOperationalConfiguration } from "@/modules/configuration/application/configuration-service";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ message?: string; status?: string }>;
}

export default async function ConfigurationPage({ searchParams }: PageProps) {
  const user = await requireAdmin("/admin/configuration");
  const configuration = await getOperationalConfiguration(user.restaurantId);
  const parameters = await searchParams;
  const settings = configuration.settings;

  return (
    <ConfigurationShell
      description="Capacità mobile e cut-off operativi del ristorante. La durata della finestra resta fissata dalla decisione architetturale iniziale."
      title="Impostazioni operative"
    >
      <StatusBanner
        message={parameters.message}
        status={parameters.status}
      />

      <section className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
        <dl className="grid gap-4 rounded-2xl bg-zinc-100 p-5 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-bold uppercase text-zinc-500">Ristorante</dt>
            <dd className="mt-1 font-bold">{configuration.name}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase text-zinc-500">Timezone</dt>
            <dd className="mt-1 font-bold">{configuration.timezone}</dd>
          </div>
        </dl>

        <form
          action="/api/admin/configuration"
          className="mt-7 grid gap-5 sm:grid-cols-2"
          method="post"
        >
          <input name="action" type="hidden" value="update-settings" />

          <label className="text-sm font-bold text-zinc-800">
            Capacità nella finestra (coperti)
            <input
              className={fieldClassName}
              defaultValue={settings.rollingCapacityCovers}
              min="1"
              name="rollingCapacityCovers"
              required
              type="number"
            />
          </label>

          <label className="text-sm font-bold text-zinc-800">
            Finestra mobile (minuti, fissa in V1)
            <input
              className={`${fieldClassName} bg-zinc-100`}
              name="rollingWindowMinutes"
              readOnly
              type="number"
              value={settings.rollingWindowMinutes}
            />
          </label>

          <label className="text-sm font-bold text-zinc-800">
            Cut-off modifica/cancellazione pranzo
            <input
              className={fieldClassName}
              defaultValue={settings.lunchModificationCutoff}
              name="lunchModificationCutoff"
              required
              type="time"
            />
          </label>

          <label className="text-sm font-bold text-zinc-800">
            Cut-off modifica/cancellazione cena
            <input
              className={fieldClassName}
              defaultValue={settings.dinnerModificationCutoff}
              name="dinnerModificationCutoff"
              required
              type="time"
            />
          </label>

          <label className="text-sm font-bold text-zinc-800">
            Cut-off nuove cene online del venerdì
            <input
              className={fieldClassName}
              defaultValue={settings.fridayDinnerBookingCutoff}
              name="fridayDinnerBookingCutoff"
              required
              type="time"
            />
          </label>

          <label className="text-sm font-bold text-zinc-800">
            Cut-off nuove cene online del sabato
            <input
              className={fieldClassName}
              defaultValue={settings.saturdayDinnerBookingCutoff}
              name="saturdayDinnerBookingCutoff"
              required
              type="time"
            />
          </label>

          <label className="text-sm font-bold text-zinc-800">
            Durata link personale (ore)
            <input
              className={fieldClassName}
              defaultValue={settings.managementLinkDurationHours}
              max="24"
              min="1"
              name="managementLinkDurationHours"
              required
              step="1"
              type="number"
            />
          </label>

          <div className="sm:col-span-2">
            <button className={buttonClassName} type="submit">
              Salva impostazioni
            </button>
          </div>
        </form>
      </section>
    </ConfigurationShell>
  );
}
