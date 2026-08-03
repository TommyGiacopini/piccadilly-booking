import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { ConfigurationError } from "@/modules/configuration/application/configuration-errors";
import {
  createSpecialDate,
  deleteSpecialDate,
  updateBookingSettings,
  updateDiningTable,
  updateRoom,
  updateSpecialDate,
  updateWeeklySchedule,
} from "@/modules/configuration/application/configuration-service";
import { getRequestUser } from "@/server/auth/authorization";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { isSameOriginRequest } from "@/server/auth/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_DESTINATIONS: Record<string, string> = {
  "update-settings": "/admin/configuration",
  "update-room": "/admin/rooms",
  "update-table": "/admin/rooms",
  "update-schedule": "/admin/schedules",
  "create-special-date": "/admin/special-dates",
  "update-special-date": "/admin/special-dates",
  "delete-special-date": "/admin/special-dates",
};

function formValue(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

function specialDateInput(formData: FormData) {
  return {
    id: formValue(formData, "id"),
    date: formValue(formData, "date"),
    scope: formValue(formData, "scope"),
    isClosed: formValue(formData, "isClosed"),
    specialStartTime: formValue(formData, "specialStartTime") ?? "",
    specialEndTime: formValue(formData, "specialEndTime") ?? "",
    specialCapacityCovers:
      formValue(formData, "specialCapacityCovers") ?? "",
    operationalNotes: formValue(formData, "operationalNotes") ?? "",
  };
}

function prefersJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

function controlledResponse(
  request: Request,
  destination: string,
  status: "saved" | "deleted" | "error",
  message?: string,
): Response {
  if (prefersJson(request)) {
    return NextResponse.json(
      status === "error" ? { ok: false, error: message } : { ok: true },
      { status: status === "error" ? 400 : 200 },
    );
  }

  const location = new URL(destination, request.url);
  location.searchParams.set("status", status);

  if (message) {
    location.searchParams.set("message", message);
  }

  return NextResponse.redirect(location, { status: 303 });
}

export async function POST(request: Request): Promise<Response> {
  const authConfig = resolveAuthConfig();

  if (!isSameOriginRequest(request, authConfig.trustProxy)) {
    return new Response("Forbidden", { status: 403 });
  }

  const user = await getRequestUser(request);

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (user.role !== "ADMIN") {
    return new Response("Forbidden", { status: 403 });
  }

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const action = formValue(formData, "action") ?? "";
  const destination = ACTION_DESTINATIONS[action];

  if (!destination) {
    return new Response("Bad Request", { status: 400 });
  }

  const actor = {
    restaurantId: user.restaurantId,
    role: user.role,
  } as const;

  try {
    switch (action) {
      case "update-settings":
        await updateBookingSettings(actor, {
          rollingCapacityCovers: formValue(
            formData,
            "rollingCapacityCovers",
          ),
          rollingWindowMinutes: formValue(formData, "rollingWindowMinutes"),
          lunchModificationCutoff: formValue(
            formData,
            "lunchModificationCutoff",
          ),
          dinnerModificationCutoff: formValue(
            formData,
            "dinnerModificationCutoff",
          ),
          fridayDinnerBookingCutoff: formValue(
            formData,
            "fridayDinnerBookingCutoff",
          ),
          saturdayDinnerBookingCutoff: formValue(
            formData,
            "saturdayDinnerBookingCutoff",
          ),
        });
        break;
      case "update-room":
        await updateRoom(actor, {
          id: formValue(formData, "id"),
          displayOrder: formValue(formData, "displayOrder"),
          isActive: formValue(formData, "isActive"),
        });
        break;
      case "update-table":
        await updateDiningTable(actor, {
          id: formValue(formData, "id"),
          name: formValue(formData, "name"),
          minimumSeats: formValue(formData, "minimumSeats"),
          maximumSeats: formValue(formData, "maximumSeats"),
          displayOrder: formValue(formData, "displayOrder"),
          isActive: formValue(formData, "isActive"),
        });
        break;
      case "update-schedule":
        await updateWeeklySchedule(actor, {
          id: formValue(formData, "id"),
          dayOfWeek: formValue(formData, "dayOfWeek"),
          serviceType: formValue(formData, "serviceType"),
          isEnabled: formValue(formData, "isEnabled"),
          startTime: formValue(formData, "startTime"),
          endTime: formValue(formData, "endTime"),
          slotIntervalMinutes: formValue(formData, "slotIntervalMinutes"),
        });
        break;
      case "create-special-date":
        await createSpecialDate(actor, specialDateInput(formData));
        break;
      case "update-special-date":
        await updateSpecialDate(actor, specialDateInput(formData));
        break;
      case "delete-special-date":
        await deleteSpecialDate(actor, { id: formValue(formData, "id") });
        break;
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return controlledResponse(
        request,
        destination,
        "error",
        error.publicMessage,
      );
    }

    console.error("Operational configuration mutation failed.");
    return controlledResponse(
      request,
      destination,
      "error",
      "Non è stato possibile salvare la configurazione.",
    );
  }

  revalidatePath(destination);
  return controlledResponse(
    request,
    destination,
    action === "delete-special-date" ? "deleted" : "saved",
  );
}
