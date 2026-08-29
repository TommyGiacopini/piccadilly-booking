import { ConfigurationShell } from "@/app/admin/_components/configuration-shell";
import { NotificationSettingsPanel } from "@/app/admin/notification-settings/notification-settings-panel";
import { readAdminNotificationSettings } from "@/modules/notifications/infrastructure/notification-settings-composition";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function NotificationSettingsPage() {
  const user = await requireAdmin("/admin/notification-settings");
  const settings = await readAdminNotificationSettings(user);
  return (
    <ConfigurationShell
      description="Scegli come creare le nuove delivery leg. Gli elementi già pianificati conservano la strategia salvata al momento dell’evento."
      title="Strategia notifiche"
    >
      <NotificationSettingsPanel strategy={settings.strategy} />
    </ConfigurationShell>
  );
}
