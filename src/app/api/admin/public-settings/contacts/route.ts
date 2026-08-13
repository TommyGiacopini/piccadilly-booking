import {
  configurationJson,
  readStrictJson,
  requireOperationalAdmin,
} from "@/app/api/admin/operational-configuration/_shared";
import { publicSettingsErrorResponse } from "@/app/api/admin/public-settings/_shared";
import { updatePublicContacts } from "@/modules/configuration/application/public-settings-service";

export async function POST(request: Request): Promise<Response> {
  const authorization = await requireOperationalAdmin(request, true);
  if (authorization.response) return authorization.response;

  try {
    return configurationJson(
      await updatePublicContacts(
        authorization.user,
        await readStrictJson(request),
      ),
    );
  } catch (error) {
    return publicSettingsErrorResponse(error);
  }
}
