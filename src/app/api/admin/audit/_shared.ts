import { NextResponse } from "next/server";

import { requireOperationalAdmin } from "@/app/api/admin/operational-configuration/_shared";
import { AuditQueryError } from "@/modules/audit/domain/audit-query";

const auditHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

export function auditJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: auditHeaders });
}

export async function requireAuditAdmin(request: Request) {
  const authorization = await requireOperationalAdmin(request, false);
  if (authorization.response) {
    authorization.response.headers.set("Cache-Control", auditHeaders["Cache-Control"]);
    authorization.response.headers.set("X-Robots-Tag", auditHeaders["X-Robots-Tag"]);
  }
  return authorization;
}

export function auditErrorResponse(error: unknown): Response {
  if (error instanceof AuditQueryError) {
    const status = error.code === "FORBIDDEN" ? 403 : error.code === "NOT_FOUND" ? 404 : 400;
    return auditJson({ error: error.message, code: error.code }, status);
  }
  console.error("Audit consultation failed.");
  return auditJson({ error: "La consultazione dell'audit non è disponibile." }, 500);
}
