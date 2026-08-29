import {
  configurationJson,
  readStrictJson,
  requireOperationalAdmin,
} from "@/app/api/admin/operational-configuration/_shared";
import { NotificationSettingsError } from "@/modules/notifications/application/notification-settings-service";
import {
  patchAdminNotificationSettings,
  readAdminNotificationSettings,
} from "@/modules/notifications/infrastructure/notification-settings-composition";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): Response {
  if (error instanceof TypeError && error.message === "JSON_REQUIRED") {
    return configurationJson(
      { error: "Content-Type application/json richiesto." },
      415,
    );
  }
  if (error instanceof SyntaxError) {
    return configurationJson({ error: "Il corpo JSON non è valido." }, 400);
  }
  if (error instanceof NotificationSettingsError) {
    return configurationJson(
      { code: error.code, error: error.message },
      error.code === "FORBIDDEN"
        ? 403
        : error.code === "NOT_FOUND"
          ? 404
          : 400,
    );
  }
  return configurationJson(
    { error: "La strategia di notifica non è disponibile." },
    500,
  );
}

export async function GET(request: Request): Promise<Response> {
  const authorization = await requireOperationalAdmin(request, false);
  if (authorization.response) return authorization.response;
  try {
    return configurationJson({
      configuration: await readAdminNotificationSettings(authorization.user),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const authorization = await requireOperationalAdmin(request, true);
  if (authorization.response) return authorization.response;
  try {
    return configurationJson(
      await patchAdminNotificationSettings(
        authorization.user,
        await readStrictJson(request),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
