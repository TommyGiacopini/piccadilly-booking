import { ConfigurationShell } from "@/app/admin/_components/configuration-shell";
import { PublicSettingsPanel } from "@/app/admin/public-settings/public-settings-panel";
import { getAdminPublicSettings } from "@/modules/configuration/application/public-settings-service";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function PublicSettingsPage() {
  const user = await requireAdmin("/admin/public-settings");
  const configuration = await getAdminPublicSettings(user);

  return (
    <ConfigurationShell
      description="Contatti pubblici, testi editoriali completi in italiano e inglese e durata prospettica dei nuovi link personali."
      title="Configurazione pubblica"
    >
      <PublicSettingsPanel configuration={configuration} />
    </ConfigurationShell>
  );
}
