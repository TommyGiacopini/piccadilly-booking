import {
  configurationJson,
  readStrictJson,
  requireOperationalAdmin,
} from "@/app/api/admin/operational-configuration/_shared";
import { ConfigurationError } from "@/modules/configuration/application/configuration-errors";
import { previewOperationalConfigurationChange } from "@/modules/configuration/application/operational-configuration-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const authorization = await requireOperationalAdmin(request, true);
  if (authorization.response) return authorization.response;

  try {
    const preview = await previewOperationalConfigurationChange(
      {
        id: authorization.user.id,
        restaurantId: authorization.user.restaurantId,
      },
      await readStrictJson(request),
    );
    return configurationJson({ preview });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return configurationJson(
        { error: error.publicMessage, code: error.code },
        error.code === "FORBIDDEN"
          ? 403
          : error.code === "NOT_FOUND"
            ? 404
            : 400,
      );
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return configurationJson({ error: "Il corpo JSON non è valido." }, 400);
    }
    console.error("Operational configuration preview failed.");
    return configurationJson(
      { error: "Non è stato possibile calcolare l'impatto." },
      500,
    );
  }
}
