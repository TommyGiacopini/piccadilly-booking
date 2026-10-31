import { downloadResponse, exportErrorResponse, previewJson, readPreviewJson, requirePreviewUser } from "@/app/api/staff/exports/_shared";
import { pdfV2RequestSchema } from "@/modules/exports/domain/pdf-v2-domain";
import { pdfV2Service } from "@/modules/exports/infrastructure/export-composition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request): Promise<Response> {
  let response: Response;
  try {
    const authorization = await requirePreviewUser(request);
    if (authorization.response) return authorization.response;
    let payload: unknown;
    try { payload = await readPreviewJson(request); }
    catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) return previewJson({ code: "INVALID_EXPORT_REQUEST", error: "La richiesta di esportazione non è valida." }, 400);
      throw error;
    }
    const parsed = pdfV2RequestSchema.safeParse(payload);
    if (!parsed.success) return previewJson({ code: "INVALID_EXPORT_REQUEST", error: "La richiesta di esportazione non è valida." }, 400);
    response = downloadResponse(await pdfV2Service.generate({
      actor: { id: authorization.user.id, restaurantId: authorization.user.restaurantId }, request: parsed.data,
    }));
  } catch (error) { response = exportErrorResponse(error); }
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  return response;
}
