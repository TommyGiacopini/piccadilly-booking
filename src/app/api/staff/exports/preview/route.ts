import { exportPreviewRequestSchema } from "@/modules/exports/domain/export-contract";
import { ExportApplicationError } from "@/modules/exports/application/export-errors";
import { previewJson, previewErrorResponse, previewService, readPreviewJson, requirePreviewUser } from "@/app/api/staff/exports/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function POST(request: Request): Promise<Response> {
  try {
    const authorization = await requirePreviewUser(request);
    if (authorization.response) return authorization.response;
    let payload: unknown;
    try { payload = await readPreviewJson(request); }
    catch (error) {
      if (error instanceof ExportApplicationError) return previewErrorResponse(error);
      return previewJson({ code: "INVALID_EXPORT_REQUEST", error: "La richiesta di anteprima non è valida." }, 400);
    }
    const parsed = exportPreviewRequestSchema.safeParse(payload);
    if (!parsed.success) return previewJson({ code: "INVALID_EXPORT_REQUEST", error: "La richiesta di anteprima non è valida." }, 400);
    return previewJson(await previewService.readPreview({
      actor: { id: authorization.user.id, restaurantId: authorization.user.restaurantId }, selection: parsed.data,
    }));
  } catch (error) { return previewErrorResponse(error); }
}
