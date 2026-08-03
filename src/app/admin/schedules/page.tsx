import {
  buttonClassName,
  ConfigurationShell,
  fieldClassName,
  StatusBanner,
} from "@/app/admin/_components/configuration-shell";
import { getOperationalConfiguration } from "@/modules/configuration/application/configuration-service";
import {
  DAY_LABELS,
  DAY_OF_WEEK_VALUES,
  SERVICE_LABELS,
  SERVICE_TYPE_VALUES,
} from "@/modules/configuration/domain/defaults";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ message?: string; status?: string }>;
}

export default async function SchedulesPage({ searchParams }: PageProps) {
  const user = await requireAdmin("/admin/schedules");
  const configuration = await getOperationalConfiguration(user.restaurantId);
  const parameters = await searchParams;
  const schedules = [...configuration.weeklySchedules].sort((left, right) => {
    const dayDifference =
      DAY_OF_WEEK_VALUES.indexOf(left.dayOfWeek) -
      DAY_OF_WEEK_VALUES.indexOf(right.dayOfWeek);

    if (dayDifference !== 0) {
      return dayDifference;
    }

    return (
      SERVICE_TYPE_VALUES.indexOf(left.serviceType) -
      SERVICE_TYPE_VALUES.indexOf(right.serviceType)
    );
  });

  return (
    <ConfigurationShell
      description="Regole ricorrenti per pranzo e cena. Le date speciali prevalgono su queste impostazioni settimanali."
      title="Orari settimanali"
    >
      <StatusBanner
        message={parameters.message}
        status={parameters.status}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {schedules.map((schedule) => (
          <form
            action="/api/admin/configuration"
            className="rounded-3xl border border-zinc-200 bg-white p-5 shadow-sm"
            key={schedule.id}
            method="post"
          >
            <input name="action" type="hidden" value="update-schedule" />
            <input name="id" type="hidden" value={schedule.id} />
            <input name="dayOfWeek" type="hidden" value={schedule.dayOfWeek} />
            <input name="serviceType" type="hidden" value={schedule.serviceType} />

            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-black">
                  {DAY_LABELS[schedule.dayOfWeek]}
                </h2>
                <p className="text-sm font-bold text-orange-700">
                  {SERVICE_LABELS[schedule.serviceType]}
                </p>
              </div>
              <label className="flex items-center gap-2 text-sm font-bold">
                <input
                  defaultChecked={schedule.isEnabled}
                  name="isEnabled"
                  type="checkbox"
                />
                Servizio abilitato
              </label>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <label className="text-xs font-bold">
                Inizio
                <input
                  className={fieldClassName}
                  defaultValue={schedule.startTime}
                  name="startTime"
                  required
                  type="time"
                />
              </label>
              <label className="text-xs font-bold">
                Fine
                <input
                  className={fieldClassName}
                  defaultValue={schedule.endTime}
                  name="endTime"
                  required
                  type="time"
                />
              </label>
              <label className="text-xs font-bold">
                Slot (minuti)
                <input
                  className={fieldClassName}
                  defaultValue={schedule.slotIntervalMinutes}
                  min="1"
                  name="slotIntervalMinutes"
                  required
                  type="number"
                />
              </label>
            </div>

            <button className={`${buttonClassName} mt-5`} type="submit">
              Salva servizio
            </button>
          </form>
        ))}
      </div>
    </ConfigurationShell>
  );
}

