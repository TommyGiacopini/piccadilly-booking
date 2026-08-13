import { ConfigurationShell } from "@/app/admin/_components/configuration-shell";
import { WeeklySchedulesPanel } from "@/app/admin/schedules/weekly-schedules-panel";
import { getImpactAwareOperationalConfiguration } from "@/modules/configuration/application/operational-configuration-service";
import {
  DAY_OF_WEEK_VALUES,
  SERVICE_TYPE_VALUES,
} from "@/modules/configuration/domain/defaults";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

export default async function SchedulesPage() {
  const user = await requireAdmin("/admin/schedules");
  const configuration = await getImpactAwareOperationalConfiguration(user);
  const schedules = [...configuration.weeklySchedules].sort((left, right) => {
    const day = DAY_OF_WEEK_VALUES.indexOf(left.dayOfWeek) - DAY_OF_WEEK_VALUES.indexOf(right.dayOfWeek);
    return day || SERVICE_TYPE_VALUES.indexOf(left.serviceType) - SERVICE_TYPE_VALUES.indexOf(right.serviceType);
  });

  return (
    <ConfigurationShell
      description="Regole ricorrenti per pranzo e cena con intervallo fisso di 15 minuti, analisi d'impatto e conferma sicura."
      title="Orari settimanali"
    >
      <WeeklySchedulesPanel key={JSON.stringify(schedules)} schedules={schedules} />
    </ConfigurationShell>
  );
}
