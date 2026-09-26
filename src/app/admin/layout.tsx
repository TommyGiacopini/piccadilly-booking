import type { ReactNode } from "react";

import { StaffShell } from "@/app/_components/staff/staff-shell";
import {
  canAccessAdminArea,
  getCurrentUser,
} from "@/server/auth/authorization";

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user || user.mustChangePassword || !canAccessAdminArea(user.role)) {
    return children;
  }

  return (
    <StaffShell role={user.role} username={user.username}>
      {children}
    </StaffShell>
  );
}
