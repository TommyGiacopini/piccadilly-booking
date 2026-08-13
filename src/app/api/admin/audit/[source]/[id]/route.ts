import { auditErrorResponse, auditJson, requireAuditAdmin } from "@/app/api/admin/audit/_shared";
import { getAuditEventDetail } from "@/modules/audit/application/audit-query-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ source: string; id: string }> },
): Promise<Response> {
  const authorization = await requireAuditAdmin(request);
  if (authorization.response) return authorization.response;

  try {
    const params = await context.params;
    const event = await getAuditEventDetail(
      {
        id: authorization.user.id,
        restaurantId: authorization.user.restaurantId,
      },
      params.source,
      params.id,
    );
    return auditJson({ event });
  } catch (error) {
    return auditErrorResponse(error);
  }
}
