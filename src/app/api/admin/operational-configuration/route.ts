import {
  configurationJson,
  requireOperationalAdmin,
} from "@/app/api/admin/operational-configuration/_shared";
import {
  getImpactAwareOperationalConfiguration,
} from "@/modules/configuration/application/operational-configuration-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await requireOperationalAdmin(request, false);
  if (authorization.response) return authorization.response;

  try {
    const configuration = await getImpactAwareOperationalConfiguration({
      id: authorization.user.id,
      restaurantId: authorization.user.restaurantId,
    });
    return configurationJson({ configuration });
  } catch {
    console.error("Operational configuration read failed.");
    return configurationJson(
      { error: "Non è stato possibile leggere la configurazione." },
      500,
    );
  }
}
