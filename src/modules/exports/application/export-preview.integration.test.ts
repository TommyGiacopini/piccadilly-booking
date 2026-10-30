import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/staff/exports/preview/route";
import { POST as proof } from "@/app/api/auth/draft-context/route";
import { POST as legacyPdf } from "@/app/api/staff/exports/pdf/route";
import { POST as legacyExcel } from "@/app/api/staff/exports/excel/route";
import { previewService, exportService } from "@/app/api/staff/exports/_shared";
import { ExportApplicationError } from "@/modules/exports/application/export-errors";
import * as sessions from "@/server/auth/session";
import { prisma } from "@/server/db/prisma";

const origin = "http://localhost:4000", endpoint = origin + "/api/staff/exports/preview";
const tenant = randomUUID(), otherTenant = randomUUID();
const staff = randomUUID(), admin = randomUUID(), other = randomUUID(), passwordUser = randomUUID();
const day = "2090-11-20", room = randomUUID(), reservation = randomUUID();
const payload = { version: 2, target: "PDF", period: { mode: "DAY", date: day }, service: "DINNER", room: "ALL", order: "CREATED_ASC" };
let tokenA = "", tokenB = "", adminToken = "", otherToken = "", passwordToken = "";
const bindings = new Map<string, string>();
async function liveBinding(token: string): Promise<string> {
  const result = await proof(new Request(origin + "/api/auth/draft-context", {
    method: "POST", headers: { host: "localhost:4000", origin, "content-type": "application/json", cookie: "piccadilly_session=" + token },
    body: JSON.stringify({ challenge: randomUUID() }),
  }));
  expect(result.status).toBe(200);
  return (await result.json()).sessionBinding;
}
function request(options: {
  token?: string | null; binding?: string | null; raw?: string;
  headers?: Record<string, string>;
} = {}): Request {
  const token = options.token === undefined ? tokenA : options.token;
  const binding = options.binding === undefined ? bindings.get(token ?? "") : options.binding;
  const headers = new Headers({ host: "localhost:4000", origin, "content-type": "application/json", ...options.headers });
  if (token) headers.set("cookie", "other=x; piccadilly_session=" + token);
  if (binding !== null && binding !== undefined) headers.set("X-Piccadilly-Draft-Session-Binding", binding);
  return new Request(endpoint, { method: "POST", headers, body: options.raw ?? JSON.stringify(payload) });
}
async function checked(req = request()) {
  const response = await POST(req);
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  return { response, body: await response.json() };
}
async function fingerprint() {
  const data = await Promise.all([
    prisma.reservation.findMany({ where: { restaurantId: tenant }, orderBy: { id: "asc" } }),
    prisma.reservationAssignment.findMany({ where: { restaurantId: tenant }, orderBy: { id: "asc" } }),
    prisma.auditEvent.findMany({ where: { restaurantId: tenant }, orderBy: { id: "asc" } }),
    prisma.notificationOutbox.findMany({ where: { restaurantId: tenant }, orderBy: { id: "asc" } }),
  ]);
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
function data(id: string, date = day) {
  return {
    id, restaurantId: tenant, localDate: new Date(date + "T00:00:00Z"), serviceType: "DINNER" as const,
    arrivalTime: new Date("1970-01-01T19:00:00Z"), partySize: 4, childrenCount: 1, gameRoomPreference: true,
    origin: "PHONE" as const, customerFirstName: "Artificial", customerLastName: "Preview sintetica",
    customerPhone: "+390000000909", customerEmail: "artificial@example.test",
    preferences: "{}", allergies: "{}", notes: "T09_HTTP_NC_ALLOWED", privateNotes: "T09_HTTP_NI_FORBIDDEN",
    privacyPolicyVersion: "test-only", privacyConsentAt: new Date(), privacyConsentMethod: "VERBAL" as const,
    createdByUserId: staff,
  };
}
describe.sequential("T09 real preview Route Handler, binding and PostgreSQL", () => {
  beforeAll(async () => {
    process.env.APP_ENV = "development"; process.env.AUTH_TRUST_PROXY = "false";
    await prisma.restaurant.create({ data: { id: tenant, name: "Artificial T09 HTTP", timezone: "Europe/Rome", users: { create: [
      { id: staff, username: "t09.staff", role: "STAFF", passwordHash: "fixture-not-used" },
      { id: admin, username: "t09.admin", role: "ADMIN", passwordHash: "fixture-not-used" },
      { id: passwordUser, username: "t09.password", role: "STAFF", passwordHash: "fixture-not-used", mustChangePassword: true },
    ] } } });
    await prisma.restaurant.create({ data: { id: otherTenant, name: "Other artificial tenant", timezone: "Europe/Rome", users: { create: {
      id: other, username: "t09.other", role: "STAFF", passwordHash: "fixture-not-used",
    } } } });
    tokenA = (await sessions.createSessionForUser(staff)).token; tokenB = (await sessions.createSessionForUser(staff)).token;
    adminToken = (await sessions.createSessionForUser(admin)).token; otherToken = (await sessions.createSessionForUser(other)).token;
    passwordToken = (await sessions.createSessionForUser(passwordUser)).token;
    for (const token of [tokenA, tokenB, adminToken, otherToken]) bindings.set(token, await liveBinding(token));
    await prisma.room.create({ data: { id: room, restaurantId: tenant, code: "sala-1", name: "Sala 1", isActive: false } });
    await prisma.reservation.create({ data: data(reservation) });
    await prisma.reservationAssignment.create({ data: {
      restaurantId: tenant, reservationId: reservation, roomId: room, internalNotes: "T09_HTTP_LEGACY_NI_FORBIDDEN",
      assignedByUserId: staff, updatedByUserId: staff,
    } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { restaurantId: { in: [tenant, otherTenant] } } });
    await prisma.reservationAssignment.deleteMany({ where: { restaurantId: tenant } });
    await prisma.reservation.deleteMany({ where: { restaurantId: tenant } });
    await prisma.room.deleteMany({ where: { restaurantId: tenant } });
    await prisma.user.deleteMany({ where: { restaurantId: { in: [tenant, otherTenant] } } });
    await prisma.restaurant.deleteMany({ where: { id: { in: [tenant, otherTenant] } } });
  });
  it.each(["STAFF", "ADMIN"] as const)("authenticates %s once and returns only the positive wire DTO without any write", async role => {
    const before = await fingerprint(), validate = vi.spyOn(sessions, "validateSessionToken");
    const pdf = vi.spyOn(exportService, "generatePdfExport"), excel = vi.spyOn(exportService, "generateExcelExport");
    const { response, body } = await checked(request({ token: role === "ADMIN" ? adminToken : tokenA }));
    expect(response.status).toBe(200); expect(validate).toHaveBeenCalledTimes(1);
    expect(body.summary).toMatchObject({ reservationCount: 1, partySizeTotal: 4, knownAdultsTotal: 3, knownChildrenTotal: 1 });
    expect(body.groups[1].rows[0]).toMatchObject({ assignmentState: "ROOM_ONLY", gameRoomPreference: true, notes: "T09_HTTP_NC_ALLOWED" });
    const json = JSON.stringify(body);
    for (const forbidden of [reservation, tenant, staff, tokenA, bindings.get(tokenA)!, "+390000000909", "artificial@example.test", "T09_HTTP_NI_FORBIDDEN", "T09_HTTP_LEGACY_NI_FORBIDDEN"]) expect(json.includes(forbidden)).toBe(false);
    expect(pdf).not.toHaveBeenCalled(); expect(excel).not.toHaveBeenCalled(); expect(await fingerprint()).toBe(before);
  });
  it("isolates a correctly bound other tenant without selecting the first tenant", async () => {
    const { response, body } = await checked(request({ token: otherToken }));
    expect(response.status).toBe(200); expect(body.summary.reservationCount).toBe(0);
    expect(JSON.stringify(body)).not.toContain("T09_HTTP_NC_ALLOWED");
  });
  it.each(["same-user", "admin", "other-tenant"] as const)("SERVER_REJECTED_BEFORE_EXPORT_READ: proof A then cookie switch %s", async kind => {
    const ownerBinding = await liveBinding(tokenA), cookie = kind === "same-user" ? tokenB : kind === "admin" ? adminToken : otherToken;
    expect(ownerBinding === bindings.get(cookie)).toBe(false);
    const read = vi.spyOn(previewService, "readPreview"), before = await fingerprint();
    const { response, body } = await checked(request({ token: cookie, binding: ownerBinding }));
    expect(response.status).toBe(403); expect(body.code).toBe("DRAFT_SESSION_MISMATCH");
    expect(read).not.toHaveBeenCalled(); expect(await fingerprint()).toBe(before);
    for (const value of [tokenA, cookie, ownerBinding]) expect(JSON.stringify(body).includes(value)).toBe(false);
  });
  it("rejects an omitted header instead of taking the legacy D01 fallback", async () => {
    const read = vi.spyOn(previewService, "readPreview");
    const result = await checked(request({ binding: null }));
    expect(result.response.status).toBe(400); expect(result.body.code).toBe("DRAFT_SESSION_BINDING_INVALID"); expect(read).not.toHaveBeenCalled();
  });
  it.each(["", "A".repeat(42), "A".repeat(44), "A".repeat(43) + "=", "é".repeat(43), "a b", "A".repeat(42) + "B"])("rejects malformed or noncanonical binding %#", async binding => {
    const read = vi.spyOn(previewService, "readPreview"), result = await checked(request({ binding }));
    expect(result.response.status).toBe(400); expect(result.body.code).toBe("DRAFT_SESSION_BINDING_INVALID"); expect(read).not.toHaveBeenCalled();
  });
  it("rejects duplicate/combined headers and a well-formed altered binding", async () => {
    const req = request(); req.headers.append("X-Piccadilly-Draft-Session-Binding", bindings.get(tokenA)!);
    expect((await checked(req)).body.code).toBe("DRAFT_SESSION_BINDING_INVALID");
    const altered = bindings.get(tokenA)!.startsWith("A") ? "B" : "A";
    const result = await checked(request({ binding: altered + bindings.get(tokenA)!.slice(1) }));
    expect(result.response.status).toBe(403); expect(result.body.code).toBe("DRAFT_SESSION_MISMATCH");
  });
  it("rejects anonymous, expired, revoked and password-change sessions without data", async () => {
    expect((await checked(request({ token: null }))).response.status).toBe(401);
    const expired = (await sessions.createSessionForUser(staff, { ttlMs: -1 })).token;
    const revoked = (await sessions.createSessionForUser(staff)).token; await sessions.revokeSessionToken(revoked);
    for (const token of [expired, revoked]) expect((await checked(request({ token, binding: bindings.get(tokenA) }))).response.status).toBe(401);
    const password = await checked(request({ token: passwordToken, binding: bindings.get(tokenA) }));
    expect(password.response.status).toBe(403); expect(JSON.stringify(password.body)).not.toContain("T09_HTTP_NC_ALLOWED");
  });
  it("preserves disabled-account revocation by the canonical validator", async () => {
    const id = randomUUID();
    await prisma.user.create({ data: { id, restaurantId: tenant, username: "t09.disabled", role: "STAFF", passwordHash: "unused-fixture" } });
    const session = await sessions.createSessionForUser(id), binding = await liveBinding(session.token);
    await prisma.user.update({ where: { id }, data: { isActive: false, disabledAt: new Date() } });
    expect((await checked(request({ token: session.token, binding }))).response.status).toBe(401);
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).not.toBeNull();
  });
  it.each(["https://attacker.example", "null", "http://localhost:4001"])("rejects untrusted Origin %s before any data read", async origin => {
    const read = vi.spyOn(previewService, "readPreview");
    expect((await checked(request({ headers: { origin } }))).response.status).toBe(403); expect(read).not.toHaveBeenCalled();
  });
  it("rejects missing Origin and ignores forged forwarded authority when trustProxy is false", async () => {
    const req = request(); req.headers.delete("origin");
    expect((await checked(req)).response.status).toBe(403);
    expect((await checked(request({ headers: { origin: "https://proxy.example", "x-forwarded-host": "proxy.example", "x-forwarded-proto": "https" } }))).response.status).toBe(403);
  });
  it.each(["text/plain", "application/x-www-form-urlencoded", "application/json; charset=iso-8859-1"])("rejects media type %s", async type => {
    const result = await checked(request({ headers: { "content-type": type } }));
    expect(result.response.status).toBe(400); expect(result.body.code).toBe("INVALID_EXPORT_REQUEST");
  });
  it.each(["{", "[]", "null", JSON.stringify({ ...payload, tenantId: tenant }), JSON.stringify({ ...payload, service: "ALL" }), JSON.stringify({ ...payload, period: { mode: "MONTH", month: "2090-11" } })])("rejects malformed and extra JSON %#", async raw => {
    const read = vi.spyOn(previewService, "readPreview");
    const result = await checked(request({ raw }));
    expect(result.response.status).toBe(400); expect(result.body.code).toBe("INVALID_EXPORT_REQUEST"); expect(read).not.toHaveBeenCalled();
  });
  it("accepts exactly 2048 bytes and rejects byte 2049 without trusting Content-Length", async () => {
    const raw = JSON.stringify(payload);
    expect((await checked(request({ raw: raw.padEnd(2048, " ") }))).response.status).toBe(200);
    for (const length of [undefined, "1", "2048"]) {
      const read = vi.spyOn(previewService, "readPreview");
      const result = await checked(request({ raw: raw.padEnd(2049, " "), headers: length ? { "content-length": length } : {} }));
      expect(result.response.status).toBe(413); expect(result.body.code).toBe("EXPORT_REQUEST_TOO_LARGE"); expect(read).not.toHaveBeenCalled();
      read.mockRestore();
    }
    expect((await checked(request({ raw: raw + "é".repeat(1025) }))).response.status).toBe(413);
  });
  it("bounds chunked streams before parsing and rejects invalid UTF-8 without echoing input", async () => {
    const req = request(), encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(" ".repeat(1024))); controller.enqueue(encoder.encode(" ".repeat(1025))); controller.close(); } });
    const streamed = new Request(endpoint, { method: "POST", headers: req.headers, body: stream, duplex: "half" } as RequestInit & { duplex: "half" });
    expect((await checked(streamed)).response.status).toBe(413);
    const invalid = new Request(endpoint, { method: "POST", headers: req.headers, body: new Uint8Array([255]).buffer });
    expect((await checked(invalid)).response.status).toBe(400);
  });
  it("returns static read failures without exception content or a download audit", async () => {
    const before = await fingerprint();
    vi.spyOn(previewService, "readPreview").mockRejectedValueOnce(new Error("T09_PRIVATE_EXCEPTION"));
    const result = await checked();
    expect(result.response.status).toBe(500); expect(result.body.code).toBe("EXPORT_PREVIEW_FAILED");
    expect(JSON.stringify(result.body)).not.toContain("T09_PRIVATE_EXCEPTION"); expect(await fingerprint()).toBe(before);
  });
  it("maps inconsistent data to static 422 and retains the same no-store boundary", async () => {
    vi.spyOn(previewService, "readPreview").mockRejectedValueOnce(new ExportApplicationError("EXPORT_DATA_INCONSISTENT", "I dati non sono coerenti."));
    const result = await checked(); expect(result.response.status).toBe(422); expect(result.body.code).toBe("EXPORT_DATA_INCONSISTENT");
  });
  it("rejects 2001 real matching rows before any file generation and performs zero writes", async () => {
    const date = "2090-11-21";
    await prisma.reservation.createMany({ data: Array.from({ length: 2001 }, () => data(randomUUID(), date)) });
    try {
      const before = await fingerprint(), pdf = vi.spyOn(exportService, "generatePdfExport"), excel = vi.spyOn(exportService, "generateExcelExport");
      const result = await checked(request({ raw: JSON.stringify({ ...payload, period: { mode: "DAY", date } }) }));
      expect(result.response.status).toBe(413); expect(result.body.code).toBe("EXPORT_TOO_LARGE");
      expect(pdf).not.toHaveBeenCalled(); expect(excel).not.toHaveBeenCalled(); expect(await fingerprint()).toBe(before);
    } finally { await prisma.reservation.deleteMany({ where: { restaurantId: tenant, localDate: new Date(date + "T00:00:00Z") } }); }
  });
  it("keeps real legacy PDF/Excel headerless contracts, NC, binary responses and download audit", async () => {
    for (const [route, body, magic] of [
      [legacyPdf, { date: day }, "%PDF-"], [legacyExcel, { mode: "DAY", date: day }, "PK"],
    ] as const) {
      const headers = { host: "localhost:4000", origin, "content-type": "application/json", cookie: "piccadilly_session=" + tokenA };
      const result = await route(new Request(origin + "/api/staff/exports/" + (magic === "PK" ? "excel" : "pdf"), { method: "POST", headers, body: JSON.stringify(body) }));
      expect(result.status).toBe(200); expect(result.headers.get("content-disposition")).toContain("attachment");
      expect(Buffer.from(await result.arrayBuffer()).subarray(0, magic.length).toString()).toBe(magic);
    }
    expect(await prisma.auditEvent.count({ where: { restaurantId: tenant, category: "EXPORT", outcome: "SUCCESS" } })).toBe(2);
    const range = await legacyExcel(new Request(origin + "/api/staff/exports/excel", {
      method: "POST", headers: { host: "localhost:4000", origin, "content-type": "application/json", cookie: "piccadilly_session=" + tokenA },
      body: JSON.stringify({ mode: "RANGE", from: "2090-01-01", to: "2090-02-01" }),
    }));
    expect(range.status).toBe(422); expect((await range.json()).code).toBe("EXPORT_RANGE_TOO_LARGE");
    expect(await prisma.auditEvent.count({ where: { restaurantId: tenant, category: "EXPORT", outcome: "FAILURE" } })).toBe(1);
  });
});

