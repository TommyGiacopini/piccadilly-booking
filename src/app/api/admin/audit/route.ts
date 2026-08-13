import { auditErrorResponse, auditJson, requireAuditAdmin } from "@/app/api/admin/audit/_shared";
import { listAuditEvents } from "@/modules/audit/application/audit-query-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await requireAuditAdmin(request);
  if (authorization.response) return authorization.response;

  try {
    const result = await listAuditEvents(
      {
        id: authorization.user.id,
        restaurantId: authorization.user.restaurantId,
      },
      new URL(request.url).searchParams,
    );
    return auditJson(result);
  } catch (error) {
    return auditErrorResponse(error);
  }
}
