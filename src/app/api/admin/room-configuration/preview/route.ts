import { configurationJson, readStrictJson, requireOperationalAdmin } from "@/app/api/admin/operational-configuration/_shared";
import { RoomAvailabilityError } from "@/modules/rooms/application/room-availability-errors";
import { previewRoomConfigurationChange } from "@/modules/rooms/application/room-configuration-service";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const authorization = await requireOperationalAdmin(request, true);
  if (authorization.response) return authorization.response;
  try {
    const preview = await previewRoomConfigurationChange(authorization.user, await readStrictJson(request));
    return configurationJson({ preview });
  } catch (error) {
    if (error instanceof TypeError && error.message === "JSON_REQUIRED") return configurationJson({ error: "Content-Type application/json richiesto." }, 415);
    if (error instanceof RoomAvailabilityError) return configurationJson({ code: error.code, error: error.message }, error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : 400);
    console.error("Admin room configuration preview failed.");
    return configurationJson({ error: "Anteprima sale non disponibile." }, 500);
  }
}
