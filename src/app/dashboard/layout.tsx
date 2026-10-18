import type { ReactNode } from "react";

import { StaffShell } from "@/app/_components/staff/staff-shell";
import { AgendaContext } from "@/app/dashboard/agenda-context";
import {
  canAccessStaffArea,
  getCurrentUser,
} from "@/server/auth/authorization";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user || user.mustChangePassword || !canAccessStaffArea(user.role)) {
    return children;
  }

  return (
    <StaffShell role={user.role} username={user.username}>
      <AgendaContext>{children}</AgendaContext>
    </StaffShell>
  );
}
