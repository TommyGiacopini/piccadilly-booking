import {
  downloadResponse,
  exportErrorResponse,
  exportService,
  invalidExportRequest,
  readExportJson,
  requireExportUser,
} from "@/app/api/staff/exports/_shared";
import { excelExportRequestSchema } from "@/modules/exports/domain/export-domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  const authorization = await requireExportUser(request);
  if (authorization.response) return authorization.response;

  let rawPayload: unknown;
  try {
    rawPayload = await readExportJson(request);
  } catch {
    return invalidExportRequest();
  }
  const parsed = excelExportRequestSchema.safeParse(rawPayload);
  if (!parsed.success) return invalidExportRequest();

  try {
    return downloadResponse(
      await exportService.generateExcelExport({
        actor: {
          id: authorization.user.id,
          restaurantId: authorization.user.restaurantId,
        },
        request: parsed.data,
      }),
    );
  } catch (error) {
    return exportErrorResponse(error);
  }
}
