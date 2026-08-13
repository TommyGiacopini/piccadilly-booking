import { configurationJson, readStrictJson, requireOperationalAdmin } from "@/app/api/admin/operational-configuration/_shared";
import { RoomAvailabilityError } from "@/modules/rooms/application/room-availability-errors";
import { mutateDiningTable } from "@/modules/rooms/application/room-configuration-service";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const authorization = await requireOperationalAdmin(request, true);
  if (authorization.response) return authorization.response;
  try {
    const result = await mutateDiningTable(authorization.user, await readStrictJson(request));
    return configurationJson(result);
  } catch (error) {
    if (error instanceof TypeError && error.message === "JSON_REQUIRED") return configurationJson({ error: "Content-Type application/json richiesto." }, 415);
    if (error instanceof RoomAvailabilityError) return configurationJson({ code: error.code, error: error.message }, error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : 400);
    console.error("Admin dining table mutation failed.");
    return configurationJson({ error: "Salvataggio tavolo non riuscito." }, 500);
  }
}
