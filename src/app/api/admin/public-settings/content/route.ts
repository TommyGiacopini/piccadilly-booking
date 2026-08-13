import {
  configurationJson,
  readStrictJson,
  requireOperationalAdmin,
} from "@/app/api/admin/operational-configuration/_shared";
import { publicSettingsErrorResponse } from "@/app/api/admin/public-settings/_shared";
import { updatePublicContents } from "@/modules/configuration/application/public-settings-service";

export async function POST(request: Request): Promise<Response> {
  const authorization = await requireOperationalAdmin(request, true);
  if (authorization.response) return authorization.response;

  try {
    return configurationJson(
      await updatePublicContents(
        authorization.user,
        await readStrictJson(request),
      ),
    );
  } catch (error) {
    return publicSettingsErrorResponse(error);
  }
}
