import { NextResponse } from "next/server";

import {
  ExportApplicationError,
  exportErrorStatus,
} from "@/modules/exports/application/export-errors";
import type { GeneratedExport } from "@/modules/exports/application/export-service";
import { createInfrastructureExportService } from "@/modules/exports/infrastructure/export-composition";
import {
  getRequestUser,
  passwordChangeRequiredResponse,
} from "@/server/auth/authorization";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { isSameOriginRequest } from "@/server/auth/request-security";
import type { AuthenticatedUser } from "@/server/auth/session";

const noStoreHeaders = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export const exportService = createInfrastructureExportService();

export function exportJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: noStoreHeaders });
}

export async function requireExportUser(
  request: Request,
): Promise<
  | { user: AuthenticatedUser; response: null }
  | { user: null; response: Response }
> {
  const user = await getRequestUser(request);
  if (!user) {
    return { user: null, response: exportJson({ error: "Unauthorized" }, 401) };
  }
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) return { user: null, response: passwordGuard };
  if (user.role !== "ADMIN" && user.role !== "STAFF") {
    return { user: null, response: exportJson({ error: "Forbidden" }, 403) };
  }
  if (!isSameOriginRequest(request, resolveAuthConfig().trustProxy)) {
    return { user: null, response: exportJson({ error: "Forbidden" }, 403) };
  }
  return { user, response: null };
}

export async function readExportJson(request: Request): Promise<unknown> {
  const contentType =
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (contentType !== "application/json") throw new TypeError("JSON_REQUIRED");
  try {
    return await request.json();
  } catch {
    throw new TypeError("INVALID_JSON");
  }
}

export function invalidExportRequest(): Response {
  return exportJson(
    {
      error: "La richiesta di esportazione non è valida.",
      code: "INVALID_EXPORT_REQUEST",
    },
    400,
  );
}

export function exportErrorResponse(error: unknown): Response {
  if (error instanceof ExportApplicationError) {
    return exportJson(
      { error: error.publicMessage, code: error.code },
      exportErrorStatus(error.code),
    );
  }
  console.error("Export request failed.");
  return exportJson(
    {
      error: "Non è stato possibile generare l'esportazione.",
      code: "EXPORT_GENERATION_FAILED",
    },
    500,
  );
}

export function downloadResponse(result: GeneratedExport): Response {
  return new Response(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      ...noStoreHeaders,
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Content-Length": String(result.buffer.byteLength),
      "X-Correlation-ID": result.correlationId,
    },
  });
}
