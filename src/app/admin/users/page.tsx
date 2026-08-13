import { ConfigurationShell } from "@/app/admin/_components/configuration-shell";
import { UserManagementPanel } from "@/app/admin/users/user-management-panel";
import { listManagedUsers } from "@/modules/identity/application/identity-service";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function UsersPage() {
  const user = await requireAdmin("/admin/users");
  const users = await listManagedUsers({
    id: user.id,
    restaurantId: user.restaurantId,
  });

  return (
    <ConfigurationShell
      description="Crea account individuali, assegna ruoli e gestisci lo stato senza condividere credenziali."
      title="Utenti e accessi"
    >
      <UserManagementPanel currentUserId={user.id} users={users} />
    </ConfigurationShell>
  );
}
