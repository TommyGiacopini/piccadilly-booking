import { configurationJson } from "@/app/api/admin/operational-configuration/_shared";
import { PublicSettingsError } from "@/modules/configuration/application/public-settings-errors";

export function publicSettingsErrorResponse(error: unknown): Response {
  if (error instanceof TypeError && error.message === "JSON_REQUIRED") {
    return configurationJson(
      { error: "Content-Type application/json richiesto." },
      415,
    );
  }
  if (error instanceof SyntaxError) {
    return configurationJson({ error: "Il corpo JSON non è valido." }, 400);
  }
  if (error instanceof PublicSettingsError) {
    const status =
      error.code === "FORBIDDEN"
        ? 403
        : error.code === "NOT_FOUND"
          ? 404
          : error.code === "STATE_CHANGED"
            ? 409
            : error.code === "VALIDATION" || error.code === "INCOMPLETE"
              ? 400
              : 500;
    return configurationJson(
      { code: error.code, error: error.message },
      status,
    );
  }
  return configurationJson(
    { error: "La configurazione pubblica non è disponibile." },
    500,
  );
}
