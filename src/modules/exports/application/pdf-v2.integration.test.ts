import { createHash, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { POST } from "@/app/api/staff/exports/pdf-v2/route";
import { POST as proof } from "@/app/api/auth/draft-context/route";
import { POST as preview } from "@/app/api/staff/exports/preview/route";
import { createInfrastructurePdfV2Service, pdfV2Service } from "@/modules/exports/infrastructure/export-composition";
import { readExportPreviewWithClient } from "@/modules/exports/infrastructure/export-repository";
import { ExportApplicationError } from "@/modules/exports/application/export-errors";
import type { PdfV2Request } from "@/modules/exports/domain/pdf-v2-domain";
import * as sessions from "@/server/auth/session";
import { prisma } from "@/server/db/prisma";

const origin = "http://localhost:4000", endpoint = origin + "/api/staff/exports/pdf-v2";
const tenant = randomUUID(), otherTenant = randomUUID(), staff = randomUUID(), admin = randomUUID(), other = randomUUID(), password = randomUUID();
const day = "2090-11-20", room1 = randomUUID(), room2 = randomUUID(), table = randomUUID();
const ids = Array.from({ length: 8 }, () => randomUUID());
const payload: PdfV2Request = { version: 2, target: "PDF", period: { mode: "DAY", date: day }, service: "DINNER", room: "ALL", order: "CREATED_ASC" };
let safe = false, tokenA = "", tokenB = "", tokenAdmin = "", tokenOther = "", tokenPassword = "";
const bindings = new Map<string, string>();
async function binding(token: string) {
  const result = await proof(new Request(origin + "/api/auth/draft-context", { method: "POST", headers: { host: "localhost:4000", origin, "content-type": "application/json", cookie: "piccadilly_session=" + token }, body: JSON.stringify({ challenge: randomUUID() }) }));
  expect(result.status).toBe(200); return (await result.json()).sessionBinding as string;
}
function request(options: { token?: string | null; binding?: string | null; raw?: string; headers?: Record<string, string> } = {}) {
  const token = options.token === undefined ? tokenA : options.token;
  const value = options.binding === undefined ? bindings.get(token ?? "") : options.binding;
  const headers = new Headers({ host: "localhost:4000", origin, "content-type": "application/json", ...options.headers });
  if (token) headers.set("cookie", "piccadilly_session=" + token);
  if (value !== undefined && value !== null) headers.set("X-Piccadilly-Draft-Session-Binding", value);
  return new Request(endpoint, { method: "POST", headers, body: options.raw ?? JSON.stringify(payload) });
}
async function checked(req = request()) {
  const response = await POST(req);
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return response;
}
async function text(response: Response) {
  const pdf = await getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
  try {
    const parts: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) parts.push((await (await pdf.getPage(n)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" "));
    return parts.join(" ").replace(/\s+/gu, " ");
  } finally { await pdf.destroy(); }
}
function data(id: string, overrides: Record<string, unknown> = {}) {
  return { id, restaurantId: tenant, localDate: new Date(day + "T00:00:00Z"), serviceType: "DINNER" as const,
    arrivalTime: new Date("1970-01-01T19:15:00Z"), partySize: 4, childrenCount: 1, gameRoomPreference: true,
    origin: "PHONE" as const, customerFirstName: "Artificial", customerLastName: "T10_" + id.slice(0, 8),
    customerPhone: "+390000000910", customerEmail: "t10@example.test", preferences: "{}", allergies: "{}", notes: "T10_NC_ALLOWED", privateNotes: "T10_PRIVATE_FORBIDDEN",
    privacyPolicyVersion: "test-only", privacyConsentAt: new Date(), privacyConsentMethod: "VERBAL" as const, createdByUserId: staff, ...overrides };
}
async function fingerprint() {
  const rows = await Promise.all([
    prisma.reservation.findMany({ where: { restaurantId: tenant }, orderBy: { id: "asc" } }),
    prisma.reservationAssignment.findMany({ where: { restaurantId: tenant }, orderBy: { id: "asc" } }),
    prisma.reservationAssignmentTable.findMany({ where: { restaurantId: tenant }, orderBy: [{ assignmentId: "asc" }, { diningTableId: "asc" }] }),
    prisma.notificationOutbox.findMany({ where: { restaurantId: tenant }, orderBy: { id: "asc" } }),
    prisma.serviceInstance.findMany({ where: { restaurantId: tenant }, orderBy: { id: "asc" } }),
    prisma.reservationAuditEvent.findMany({ where: { restaurantId: tenant }, orderBy: { id: "asc" } }),
  ]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
describe.sequential("T10 real bound PDF API and isolated PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/piccadilly_vitest_[0-9a-f]{32}$/u.test(url.pathname)) throw new Error("T10_TEMPORARY_DATABASE_REQUIRED");
    safe = true; process.env.APP_ENV = "development"; process.env.AUTH_TRUST_PROXY = "false";
    await prisma.restaurant.create({ data: { id: tenant, name: "T10 Artificial", timezone: "Europe/Rome", users: { create: [
      { id: staff, username: "t10.staff", role: "STAFF", passwordHash: "fixture-not-used" },
      { id: admin, username: "t10.admin", role: "ADMIN", passwordHash: "fixture-not-used" },
      { id: password, username: "t10.password", role: "STAFF", passwordHash: "fixture-not-used", mustChangePassword: true },
    ] } } });
    await prisma.restaurant.create({ data: { id: otherTenant, name: "T10 Other", timezone: "Europe/Rome", users: { create: { id: other, username: "t10.other", role: "STAFF", passwordHash: "fixture-not-used" } } } });
    tokenA = (await sessions.createSessionForUser(staff)).token; tokenB = (await sessions.createSessionForUser(staff)).token;
    tokenAdmin = (await sessions.createSessionForUser(admin)).token; tokenOther = (await sessions.createSessionForUser(other)).token; tokenPassword = (await sessions.createSessionForUser(password)).token;
    for (const token of [tokenA, tokenB, tokenAdmin, tokenOther]) bindings.set(token, await binding(token));
    await prisma.room.createMany({ data: [{ id: room1, restaurantId: tenant, code: "sala-1", name: "Sala 1", isActive: false }, { id: room2, restaurantId: tenant, code: "sala-2", name: "Sala 2" }] });
    await prisma.diningTable.create({ data: { id: table, roomId: room2, name: "T10_DIGITAL_FORBIDDEN", minimumSeats: 1, maximumSeats: 4, isActive: false } });
    await prisma.reservation.createMany({ data: [
      data(ids[0], { childrenCount: null, gameRoomPreference: null, preferences: JSON.stringify({ roomCode: "", highChair: false, stroller: false, accessibility: false, children: true, celebration: null, animals: false }) }),
      data(ids[1], { childrenCount: 0, gameRoomPreference: null }), data(ids[2]), data(ids[3]),
      data(ids[4], { status: "CANCELLED", cancelledAt: new Date() }),
      data(ids[5], { serviceType: "LUNCH", arrivalTime: new Date("1970-01-01T12:30:00Z") }),
      data(ids[6], { localDate: new Date("2090-11-21T00:00:00Z") }),
      data(ids[7], { restaurantId: otherTenant, createdByUserId: other, notes: "OTHER_TENANT_FORBIDDEN" }),
    ] });
    for (const [id, roomId, cleared] of [[ids[1], room1, false], [ids[2], room2, false], [ids[3], room2, true]] as const) {
      const assignment = await prisma.reservationAssignment.create({ data: { restaurantId: tenant, reservationId: id, roomId, clearedAt: cleared ? new Date() : null,
        internalNotes: "T10_LEGACY_FORBIDDEN", assignedByUserId: staff, updatedByUserId: staff } });
      if (roomId === room2) await prisma.reservationAssignmentTable.create({ data: { restaurantId: tenant, assignmentId: assignment.id, roomId, diningTableId: table } });
    }
  }, 30_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (!safe) return;
    for (const id of [tenant, otherTenant]) {
      await prisma.auditEvent.deleteMany({ where: { restaurantId: id } });
      await prisma.reservationAssignmentTable.deleteMany({ where: { restaurantId: id } });
      await prisma.reservationAssignment.deleteMany({ where: { restaurantId: id } });
      await prisma.reservation.deleteMany({ where: { restaurantId: id } });
      await prisma.diningTable.deleteMany({ where: { room: { restaurantId: id } } });
      await prisma.room.deleteMany({ where: { restaurantId: id } });
      await prisma.user.deleteMany({ where: { restaurantId: id } });
      await prisma.restaurant.deleteMany({ where: { id } });
    }
  });
  it.each(["STAFF", "ADMIN"])("authenticates %s exactly once and returns a real private PDF only after audit", async role => {
    const before = await fingerprint(), validator = vi.spyOn(sessions, "validateSessionToken");
    const response = await checked(request({ token: role === "ADMIN" ? tokenAdmin : tokenA }));
    expect(response.status).toBe(200); expect(validator).toHaveBeenCalledTimes(1);
    expect(response.headers.get("content-type")).toBe("application/pdf"); expect(response.headers.get("content-disposition")).toContain("piccadilly-operativo-v2-");
    const extracted = await text(response); expect(extracted).toContain("T10_NC_ALLOWED"); expect(extracted).toContain("4 prenotazioni");
    expect(extracted).toContain("Bambini segnalati senza conteggio"); expect(extracted).toContain("TA");
    for (const forbidden of ["T10_DIGITAL_FORBIDDEN", "T10_PRIVATE_FORBIDDEN", "T10_LEGACY_FORBIDDEN", "+390000000910", "t10@example.test", ids[0], tenant, bindings.get(tokenA)!]) expect(extracted).not.toContain(forbidden);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { restaurantId: tenant, correlationId: response.headers.get("x-correlation-id")! } });
    expect(event).toMatchObject({ action: "PDF_EXPORT_REQUESTED", outcome: "SUCCESS", entityId: null, entityType: null, previousState: null, newState: null });
    expect(event.metadata).toEqual({ format: "PDF", mode: "DAY", fromDate: day, toDate: day, dayCount: 1, reservationCount: 4 });
    expect(await fingerprint()).toBe(before);
  });
  it("filters actual room, room-only, cleared, lunch and day without interpreting preferences", async () => {
    for (const [selection, count] of [
      [{ ...payload, room: "SALA_1" }, 1], [{ ...payload, room: "SALA_2" }, 1], [{ ...payload, room: "UNASSIGNED" }, 2],
      [{ ...payload, service: "LUNCH" }, 1], [{ ...payload, period: { mode: "DAY", date: "2090-11-22" } }, 0],
    ] as const) {
      const response = await checked(request({ raw: JSON.stringify(selection) })); expect(response.status).toBe(200);
      expect(await text(response)).toContain(`${count} prenotazioni`);
    }
    const otherResponse = await checked(request({ token: tokenOther })); expect(otherResponse.status).toBe(200);
    expect(await text(otherResponse)).not.toContain("T10_NC_ALLOWED");
  });
  it.each(["same-user", "admin", "other-tenant"])("SERVER_REJECTED_BEFORE_EXPORT_READ after cookie A/B switch %s", async kind => {
    const spy = vi.spyOn(pdfV2Service, "generate"), before = await fingerprint();
    const audits = await prisma.auditEvent.count({ where: { restaurantId: tenant } });
    const response = await checked(request({ token: kind === "same-user" ? tokenB : kind === "admin" ? tokenAdmin : tokenOther, binding: bindings.get(tokenA) }));
    expect(response.status).toBe(403); expect((await response.json()).code).toBe("DRAFT_SESSION_MISMATCH"); expect(spy).not.toHaveBeenCalled();
    expect(await fingerprint()).toBe(before); expect(await prisma.auditEvent.count({ where: { restaurantId: tenant } })).toBe(audits);
  });
  it.each([null, "", "A".repeat(42), "A".repeat(42) + "B", "é".repeat(43), "A".repeat(44)])("rejects missing/malformed binding %# without legacy fallback", async value => {
    const spy = vi.spyOn(pdfV2Service, "generate"), response = await checked(request({ binding: value }));
    expect(response.status).toBe(400); expect((await response.json()).code).toBe("DRAFT_SESSION_BINDING_INVALID"); expect(spy).not.toHaveBeenCalled();
  });
  it("rejects duplicate binding headers and altered canonical bindings", async () => {
    const req = request(); req.headers.append("X-Piccadilly-Draft-Session-Binding", bindings.get(tokenA)!);
    expect((await checked(req)).status).toBe(400);
    const value = bindings.get(tokenA)!, altered = (value.startsWith("A") ? "B" : "A") + value.slice(1);
    expect((await checked(request({ binding: altered }))).status).toBe(403);
  });
  it("rejects anonymous, expired, revoked, disabled and password-change sessions", async () => {
    const expired = (await sessions.createSessionForUser(staff, { ttlMs: -1 })).token;
    const revoked = (await sessions.createSessionForUser(staff)).token; await sessions.revokeSessionToken(revoked);
    for (const token of [null, expired, revoked]) expect((await checked(request({ token, binding: bindings.get(tokenA) }))).status).toBe(401);
    expect((await checked(request({ token: tokenPassword, binding: bindings.get(tokenA) }))).status).toBe(403);
    const id = randomUUID(); await prisma.user.create({ data: { id, restaurantId: tenant, username: "t10.disabled", role: "STAFF", passwordHash: "fixture" } });
    const session = await sessions.createSessionForUser(id), owner = await binding(session.token);
    await prisma.user.update({ where: { id }, data: { isActive: false, disabledAt: new Date() } });
    expect((await checked(request({ token: session.token, binding: owner }))).status).toBe(401);
  });
  it.each(["https://attacker.example", "null", "http://localhost:4001"])("rejects Origin %s before generation", async value => {
    const spy = vi.spyOn(pdfV2Service, "generate"); expect((await checked(request({ headers: { origin: value } }))).status).toBe(403); expect(spy).not.toHaveBeenCalled();
  });
  it("rejects missing Origin and forged proxy authority", async () => {
    const req = request(); req.headers.delete("origin"); expect((await checked(req)).status).toBe(403);
    expect((await checked(request({ headers: { origin: "https://forged.example", "x-forwarded-host": "forged.example", "x-forwarded-proto": "https" } }))).status).toBe(403);
  });
  it.each(["text/plain", "application/json; charset=iso-8859-1", "application/x-www-form-urlencoded"])("rejects media %s", async content => expect((await checked(request({ headers: { "content-type": content } }))).status).toBe(400));
  it.each(["{", "[]", "null", JSON.stringify({ ...payload, target: "EXCEL" }), JSON.stringify({ date: day }), JSON.stringify({ ...payload, rows: [] }), JSON.stringify({ ...payload, service: "ALL" })])("rejects invalid payload %#", async raw => {
    const spy = vi.spyOn(pdfV2Service, "generate"); expect((await checked(request({ raw }))).status).toBe(400); expect(spy).not.toHaveBeenCalled();
  });
  it("counts actual body bytes including chunked and multibyte streams, not Content-Length", async () => {
    const raw = JSON.stringify(payload);
    expect((await checked(request({ raw: raw.padEnd(2048, " ") }))).status).toBe(200);
    for (const length of [undefined, "1", "2048"]) {
      const response = await checked(request({ raw: raw.padEnd(2049, " "), headers: length ? { "content-length": length } : {} }));
      expect(response.status).toBe(413); expect((await response.json()).code).toBe("EXPORT_REQUEST_TOO_LARGE");
    }
    expect((await checked(request({ raw: raw + "é".repeat(1025) }))).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024).fill(32)); controller.enqueue(new Uint8Array(1025).fill(32)); controller.close(); } });
    const streamed = new Request(endpoint, { method: "POST", headers: request().headers, body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
    expect((await checked(streamed)).status).toBe(413);
    expect((await checked(new Request(endpoint, { method: "POST", headers: request().headers, body: new Uint8Array([255]).buffer }))).status).toBe(400);
  });
  it("preserves canonical sanitized service errors and no-store", async () => {
    for (const [code, status] of [["EXPORT_TOO_LARGE", 413], ["EXPORT_DATA_INCONSISTENT", 422], ["EXPORT_AUDIT_FAILED", 500]] as const) {
      vi.spyOn(pdfV2Service, "generate").mockRejectedValueOnce(new ExportApplicationError(code, "Messaggio statico."));
      const response = await checked(); expect(response.status).toBe(status); expect((await response.json()).code).toBe(code);
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(pdfV2Service, "generate").mockRejectedValueOnce(new Error("PRIVATE_RAW_EXCEPTION"));
    const response = await checked(); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("PRIVATE_RAW_EXCEPTION");
  });
  it("records real generation FAILURE before returning a sanitized API error", async () => {
    const failing = createInfrastructurePdfV2Service({ renderer: { render: async () => { throw new Error("T10_PRIVATE_RENDER_ERROR"); } } });
    vi.spyOn(pdfV2Service, "generate").mockImplementationOnce(value => failing.generate(value));
    const before = await fingerprint(), count = await prisma.auditEvent.count({ where: { restaurantId: tenant, outcome: "FAILURE" } });
    const response = await checked(); expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("T10_PRIVATE_RENDER_ERROR");
    expect(await prisma.auditEvent.count({ where: { restaurantId: tenant, outcome: "FAILURE" } })).toBe(count + 1);
    expect(await fingerprint()).toBe(before);
  });
  it("discards a real rendered PDF when the SUCCESS audit writer fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = createInfrastructurePdfV2Service({ auditWriter: { write: async () => { throw new Error("T10_PRIVATE_AUDIT_ERROR"); } } });
    vi.spyOn(pdfV2Service, "generate").mockImplementationOnce(value => failing.generate(value));
    const response = await checked(); expect(response.status).toBe(500); expect(response.headers.get("content-disposition")).toBeNull();
    expect((await response.json()).code).toBe("EXPORT_AUDIT_FAILED");
  });
  it("fails explicitly on an unsupported NC glyph without substituting or echoing the note", async () => {
    const original = (await prisma.reservation.findUniqueOrThrow({ where: { id: ids[0] } })).notes;
    try {
      await prisma.reservation.update({ where: { id: ids[0] }, data: { notes: "NC_GLYPH_PRIVATE_\u{10ffff}" } });
      const response = await checked(); expect(response.status).toBe(422); expect(response.headers.get("content-disposition")).toBeNull();
      const body = JSON.stringify(await response.json()); expect(body).toContain("EXPORT_DATA_INCONSISTENT"); expect(body).not.toContain("NC_GLYPH_PRIVATE");
    } finally { await prisma.reservation.update({ where: { id: ids[0] }, data: { notes: original } }); }
  });
  it("queries no excluded columns, bounds cardinality after filters and keeps a bounded query count", async () => {
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }), log: [{ emit: "event", level: "query" }] });
    const queries: string[] = []; client.$on("query", event => queries.push(event.query));
    try {
      const renderer = { render: vi.fn().mockResolvedValue(Buffer.from("%PDF-test")) };
      const service = createInfrastructurePdfV2Service({ snapshotReader: { read: value => readExportPreviewWithClient(client, value) }, renderer });
      await service.generate({ actor: { id: staff, restaurantId: tenant }, request: payload });
      expect(queries.some(query => /private_notes|internal_notes|customer_phone|customer_email/u.test(query))).toBe(false);
      expect(queries.some(query => /LIMIT/u.test(query))).toBe(true); expect(queries.length).toBeLessThanOrEqual(12);
      const count = queries.length; queries.length = 0;
      const added = Array.from({ length: 100 }, () => randomUUID()); await prisma.reservation.createMany({ data: added.map(id => data(id)) });
      try { await service.generate({ actor: { id: staff, restaurantId: tenant }, request: payload }); expect(queries.length).toBe(count); }
      finally { await prisma.reservation.deleteMany({ where: { id: { in: added }, restaurantId: tenant } }); }
    } finally { await client.$disconnect(); }
  });
  it("rejects 2001 matching rows before render, while an actual-room filter remains valid", async () => {
    const date = "2090-11-25", added = Array.from({ length: 2001 }, () => randomUUID());
    await prisma.reservation.createMany({ data: added.map(id => data(id, { localDate: new Date(date + "T00:00:00Z") })) });
    try {
      const renderer = { render: vi.fn().mockResolvedValue(Buffer.from("%PDF-test")) }, service = createInfrastructurePdfV2Service({ renderer });
      const before = await fingerprint();
      await expect(service.generate({ actor: { id: staff, restaurantId: tenant }, request: { ...payload, period: { mode: "DAY", date } } })).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
      expect(renderer.render).not.toHaveBeenCalled(); expect(await fingerprint()).toBe(before);
      await service.generate({ actor: { id: staff, restaurantId: tenant }, request: { ...payload, period: { mode: "DAY", date }, room: "SALA_1" } });
      expect(renderer.render).toHaveBeenCalledTimes(1);
      const events = await prisma.auditEvent.findMany({ where: { restaurantId: tenant, outcome: "FAILURE", action: "PDF_EXPORT_REQUESTED" } });
      expect(events.some(event => JSON.stringify(event.metadata).includes("EXPORT_TOO_LARGE"))).toBe(true);
    } finally { await prisma.reservation.deleteMany({ where: { id: { in: added }, restaurantId: tenant } }); }
  }, 30_000);
  it("keeps each RepeatableRead coherent while a later PDF reads a changed NC", async () => {
    const actor = { id: staff, restaurantId: tenant }, original = (await prisma.reservation.findUniqueOrThrow({ where: { id: ids[0] } })).notes;
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
    try {
      const snapshot = await readExportPreviewWithClient(prisma, { actor, selection: payload, maximumReservations: 2000 }, { afterContextRead: async () => { await client.reservation.update({ where: { id: ids[0] }, data: { notes: "T10_LATER_READ" } }); } });
      expect(snapshot.reservations.find(row => row.id === ids[0])!.notes).toBe(original);
      expect(await text(await checked())).toContain("T10_LATER_READ");
      const response = await preview(new Request(origin + "/api/staff/exports/preview", { method: "POST", headers: request().headers, body: JSON.stringify(payload) }));
      expect(response.status).toBe(200); expect(JSON.stringify(await response.json())).toContain("T10_LATER_READ");
    } finally { await client.$disconnect(); await prisma.reservation.update({ where: { id: ids[0] }, data: { notes: original } }); }
  });
});
