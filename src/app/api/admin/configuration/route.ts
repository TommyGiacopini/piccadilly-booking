import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { ConfigurationError } from "@/modules/configuration/application/configuration-errors";
import {
  createSpecialDate,
  archiveSpecialDate,
  reactivateSpecialDate,
  updateSpecialDate,
} from "@/modules/configuration/application/configuration-service";
import {
  getRequestUser,
  passwordChangeRequiredResponse,
} from "@/server/auth/authorization";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { resolveTrustedRequestOrigin } from "@/server/auth/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION_DESTINATIONS: Record<string, string> = {
  "create-special-date": "/admin/special-dates",
  "update-special-date": "/admin/special-dates",
  "archive-special-date": "/admin/special-dates",
  "reactivate-special-date": "/admin/special-dates",
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
  requestOrigin: string,
  destination: string,
  status: "saved" | "archived" | "reactivated" | "error",
  message?: string,
): Response {
  if (prefersJson(request)) {
    return NextResponse.json(
      status === "error" ? { ok: false, error: message } : { ok: true },
      { status: status === "error" ? 400 : 200 },
    );
  }

  const location = new URL(destination, requestOrigin);
  location.searchParams.set("status", status);

  if (message) {
    location.searchParams.set("message", message);
  }

  return NextResponse.redirect(location, { status: 303 });
}

export async function POST(request: Request): Promise<Response> {
  const authConfig = resolveAuthConfig();
  const requestOrigin = resolveTrustedRequestOrigin(
    request,
    authConfig.trustProxy,
  );

  if (!requestOrigin) {
    return new Response("Forbidden", { status: 403 });
  }

  const user = await getRequestUser(request);

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return passwordGuard;

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
    id: user.id,
    restaurantId: user.restaurantId,
    role: user.role,
  } as const;

  try {
    switch (action) {
      case "create-special-date":
        await createSpecialDate(actor, specialDateInput(formData));
        break;
      case "update-special-date":
        await updateSpecialDate(actor, specialDateInput(formData));
        break;
      case "archive-special-date":
        await archiveSpecialDate(actor, { id: formValue(formData, "id") });
        break;
      case "reactivate-special-date":
        await reactivateSpecialDate(actor, { id: formValue(formData, "id") });
        break;
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return controlledResponse(
        request,
        requestOrigin,
        destination,
        "error",
        error.publicMessage,
      );
    }

    console.error("Operational configuration mutation failed.");
    return controlledResponse(
      request,
      requestOrigin,
      destination,
      "error",
      "Non è stato possibile salvare la configurazione.",
    );
  }

  revalidatePath(destination);
  return controlledResponse(
    request,
    requestOrigin,
    destination,
    action === "archive-special-date"
      ? "archived"
      : action === "reactivate-special-date"
        ? "reactivated"
        : "saved",
  );
}
