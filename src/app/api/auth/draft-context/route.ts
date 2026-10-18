import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveAuthConfig } from "@/server/auth/auth-config";
import { readDraftSessionContext } from "@/server/auth/draft-session-context";
import { isSameOriginRequest } from "@/server/auth/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const schema = z.object({ challenge: z.uuid() }).strict();
const MAX_BODY_BYTES = 1024;
function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0" } });
}

async function boundedBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function POST(request: Request): Promise<Response> {
  try {
    if (!isSameOriginRequest(request, resolveAuthConfig().trustProxy)) return json({ error: "FORBIDDEN" }, 403);
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") return json({ error: "BAD_REQUEST" }, 400);
    let body: string | null;
    try { body = await boundedBody(request); }
    catch { return json({ error: "BAD_REQUEST" }, 400); }
    if (body === null) return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
    let raw: unknown;
    try { raw = JSON.parse(body); }
    catch { return json({ error: "BAD_REQUEST" }, 400); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return json({ error: "BAD_REQUEST" }, 400);
    const result = await readDraftSessionContext(request);
    if (result.status !== "OK") return json({ error: result.status }, result.status === "UNAUTHENTICATED" ? 401 : 403);
    return json({ challenge: parsed.data.challenge, ...result.context }, 200);
  } catch {
    // Never serialize request, cookie, binding, database diagnostics or exception.
    return json({ error: "INTERNAL_ERROR" }, 500);
  }
}
