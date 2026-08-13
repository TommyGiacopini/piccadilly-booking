import {
  configurationJson,
  requireOperationalAdmin,
} from "@/app/api/admin/operational-configuration/_shared";
import { publicSettingsErrorResponse } from "@/app/api/admin/public-settings/_shared";
import { getAdminPublicSettings } from "@/modules/configuration/application/public-settings-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await requireOperationalAdmin(request, false);
  if (authorization.response) return authorization.response;

  try {
    return configurationJson({
      configuration: await getAdminPublicSettings(authorization.user),
    });
  } catch (error) {
    return publicSettingsErrorResponse(error);
  }
}
