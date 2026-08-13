import type { Metadata } from "next";

import { ConfigurationShell } from "@/app/admin/_components/configuration-shell";
import { AuditPanel } from "@/app/admin/audit/audit-panel";
import { getAuditViewerContext, listAuditEvents } from "@/modules/audit/application/audit-query-service";
import { requireAdmin } from "@/server/auth/authorization";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Audit | Piccadilly Booking",
  robots: { index: false, follow: false, noarchive: true },
};

export default async function AuditPage() {
  const user = await requireAdmin("/admin/audit");
  const [context, initialPage] = await Promise.all([
    getAuditViewerContext(user),
    listAuditEvents(user, new URLSearchParams()),
  ]);

  return (
    <ConfigurationShell
      description="Consultazione cronologica e di sola lettura degli eventi di prenotazione, autenticazione e configurazione."
      title="Registro audit"
    >
      <AuditPanel initialPage={initialPage} timezone={context.timezone} />
    </ConfigurationShell>
  );
}
