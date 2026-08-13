import { ConfigurationShell } from "@/app/admin/_components/configuration-shell";
import { BookingSettingsPanel } from "@/app/admin/configuration/booking-settings-panel";
import { getImpactAwareOperationalConfiguration } from "@/modules/configuration/application/operational-configuration-service";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";

export default async function ConfigurationPage() {
  const user = await requireAdmin("/admin/configuration");
  const configuration = await getImpactAwareOperationalConfiguration(user);

  return (
    <ConfigurationShell
      description="Capacità, termini cliente e regole generiche di chiusura pubblica, con anteprima server-side e grandfathering."
      title="Impostazioni operative"
    >
      <section className="mb-5 grid gap-3 rounded-3xl bg-zinc-950 p-5 text-white sm:grid-cols-2">
        <p><span className="text-xs font-bold text-zinc-400 uppercase">Ristorante</span><br /><strong>{configuration.name}</strong></p>
        <p><span className="text-xs font-bold text-zinc-400 uppercase">Timezone</span><br /><strong>{configuration.timezone}</strong></p>
      </section>
      <BookingSettingsPanel
        key={JSON.stringify({ settings: configuration.settings, rules: configuration.bookingCutoffRules })}
        bookingCutoffRules={configuration.bookingCutoffRules}
        settings={configuration.settings}
      />
    </ConfigurationShell>
  );
}
