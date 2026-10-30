import { NextResponse } from "next/server";

import {
  ExportApplicationError,
  exportErrorStatus,
} from "@/modules/exports/application/export-errors";
import type { GeneratedExport } from "@/modules/exports/application/export-service";
import { createInfrastructureExportService, createInfrastructurePreviewService } from "@/modules/exports/infrastructure/export-composition";
import { readDraftRequestSession, draftSessionBindingError, DRAFT_SESSION_BINDING_HEADER } from "@/server/auth/draft-session-context";
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
export const previewService = createInfrastructurePreviewService();
export function previewJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { ...noStoreHeaders, "Cache-Control": "private, no-store, max-age=0" } });
}
export function previewErrorResponse(error: unknown): Response {
  if (error instanceof ExportApplicationError) return previewJson({ code: error.code, error: error.publicMessage }, exportErrorStatus(error.code));
  return previewJson({ code: "EXPORT_PREVIEW_FAILED", error: "Non è stato possibile leggere l'anteprima." }, 500);
}
export async function requirePreviewUser(request: Request): Promise<
  { user: AuthenticatedUser; response: null } | { user: null; response: Response }
> {
  const session = await readDraftRequestSession(request);
  if (!session) return { user: null, response: previewJson({ code: "UNAUTHENTICATED", error: "Unauthorized" }, 401) };
  const { user, sessionBinding } = session;
  const passwordGuard = passwordChangeRequiredResponse(user);
  if (passwordGuard) {
    const headers = new Headers(passwordGuard.headers);
    for (const [key, value] of Object.entries(noStoreHeaders)) headers.set(key, value);
    headers.set("Cache-Control", "private, no-store, max-age=0");
    return { user: null, response: new Response(passwordGuard.body, { status: passwordGuard.status, headers }) };
  }
  if ((user.role !== "STAFF" && user.role !== "ADMIN") || !isSameOriginRequest(request, resolveAuthConfig().trustProxy)) {
    return { user: null, response: previewJson({ code: "FORBIDDEN", error: "Forbidden" }, 403) };
  }
  // The existing helper permits headerless legacy requests; this new boundary does not.
  if (!request.headers.has(DRAFT_SESSION_BINDING_HEADER)) return {
    user: null, response: previewJson({ code: "DRAFT_SESSION_BINDING_INVALID", error: "Contesto della sessione non valido." }, 400),
  };
  const bindingError = draftSessionBindingError(request, sessionBinding);
  if (bindingError) return { user: null, response: previewJson({ code: bindingError.code, error: "Contesto della sessione non valido." }, bindingError.status) };
  return { user, response: null };
}
export async function readPreviewJson(request: Request): Promise<unknown> {
  const media = request.headers.get("content-type")?.split(";").map(part => part.trim().toLowerCase()) ?? [];
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (media[0] !== "application/json" || media.slice(1).some(part => part && part !== "charset=utf-8")
    || encoding && encoding !== "identity") throw new TypeError("INVALID_PREVIEW_JSON");
  const length = request.headers.get("content-length");
  const tooLarge = () => new ExportApplicationError("EXPORT_REQUEST_TOO_LARGE", "La richiesta supera il limite consentito.");
  if (length && /^\d+$/u.test(length) && Number(length) > 2048) throw tooLarge();
  if (!request.body) throw new TypeError("INVALID_PREVIEW_JSON");
  const reader = request.body.getReader(), bytes = new Uint8Array(2048);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > bytes.byteLength) { void reader.cancel().catch(() => undefined); throw tooLarge(); }
      bytes.set(value, size); size += value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } finally { reader.releaseLock(); }
}

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
