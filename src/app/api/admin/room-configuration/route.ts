import { configurationJson, requireOperationalAdmin } from "@/app/api/admin/operational-configuration/_shared";
import { RoomAvailabilityError } from "@/modules/rooms/application/room-availability-errors";
import { getAdminRoomConfiguration } from "@/modules/rooms/application/room-configuration-service";
import { isLocalDate } from "@/modules/configuration/domain/operational-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authorization = await requireOperationalAdmin(request, false);
  if (authorization.response) return authorization.response;

  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) => !["date", "service"].includes(key))) {
    return configurationJson({ error: "Parametri non validi." }, 400);
  }
  const localDate = url.searchParams.get("date");
  const serviceType = url.searchParams.get("service");
  if (!localDate || !isLocalDate(localDate) || (serviceType !== "LUNCH" && serviceType !== "DINNER")) {
    return configurationJson({ error: "Parametri non validi." }, 400);
  }

  try {
    const configuration = await getAdminRoomConfiguration(authorization.user, {
      localDate,
      serviceType,
    });
    return configurationJson({ configuration });
  } catch (error) {
    if (error instanceof RoomAvailabilityError) {
      return configurationJson({ code: error.code, error: error.message }, error.code === "FORBIDDEN" ? 403 : 400);
    }
    console.error("Admin room configuration read failed.");
    return configurationJson({ error: "Configurazione sale non disponibile." }, 500);
  }
}
