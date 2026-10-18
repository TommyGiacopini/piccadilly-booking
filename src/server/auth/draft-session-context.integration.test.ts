import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/draft-context/route";
import { POST as PHONE } from "@/app/api/staff/reservations/route";
import { PATCH as EDIT } from "@/app/api/staff/reservations/[id]/route";
import { PUT as NI } from "@/app/api/staff/reservations/[id]/private-notes/route";
import * as staffService from "@/modules/reservations/application/staff-reservation-service";
import * as notesService from "@/modules/reservations/application/reservation-private-notes-service";
import * as sessionService from "@/server/auth/session";
import { UserRole } from "@/generated/prisma/client";
import { readDraftSessionContext, DRAFT_SESSION_BINDING_HEADER } from "@/server/auth/draft-session-context";
import { createSessionForUser, revokeSessionToken } from "@/server/auth/session";
import { parseSessionToken } from "@/server/auth/session-token";
import { prisma } from "@/server/db/prisma";

const restaurantId = randomUUID(), otherRestaurantId = randomUUID();
const staffId = randomUUID(), adminId = randomUUID(), otherId = randomUUID(), passwordId = randomUUID(), disabledId = randomUUID();
const origin = "http://localhost:4000";
let staffToken = "", adminToken = "", otherToken = "";
function request(token?: string, body: string = JSON.stringify({ challenge: randomUUID() }), headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/auth/draft-context`, { method: "POST", headers: {
    host: "localhost:4000", origin, "content-type": "application/json",
    ...(token ? { cookie: `irrelevant=x; piccadilly_session=${token}; other=y` } : {}), ...headers,
  }, body });
}
async function result(req: Request) {
  const response = await POST(req);
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  return { status: response.status, body: await response.json() };
}

describe.sequential("T06-B real draft-context HTTP and PostgreSQL session isolation", () => {
  beforeAll(async () => {
    process.env.APP_ENV = "development";
    process.env.AUTH_TRUST_PROXY = "false";
    await prisma.restaurant.create({ data: { id: restaurantId, name: "Artificial CB06 auth", timezone: "Europe/Rome", users: { create: [
      { id: staffId, username: "cb06.staff", role: UserRole.STAFF, passwordHash: "unused-fixture-hash" },
      { id: adminId, username: "cb06.admin", role: UserRole.ADMIN, passwordHash: "unused-fixture-hash" },
      { id: passwordId, username: "cb06.password", role: UserRole.STAFF, passwordHash: "unused-fixture-hash", mustChangePassword: true },
      { id: disabledId, username: "cb06.disabled", role: UserRole.STAFF, passwordHash: "unused-fixture-hash", isActive: false, disabledAt: new Date() },
    ] } } });
    await prisma.restaurant.create({ data: { id: otherRestaurantId, name: "Artificial CB06 other tenant", timezone: "Europe/Rome", users: { create: {
      id: otherId, username: "cb06.other", role: UserRole.STAFF, passwordHash: "unused-fixture-hash",
    } } } });
    staffToken = (await createSessionForUser(staffId)).token;
    adminToken = (await createSessionForUser(adminId)).token;
    otherToken = (await createSessionForUser(otherId)).token;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.user.deleteMany({ where: { restaurantId: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.restaurant.deleteMany({ where: { id: { in: [restaurantId, otherRestaurantId] } } });
    await prisma.$disconnect();
  });
  it("returns only a correlated positive projection and exact domain-separated HMAC", async () => {
    const challenge = randomUUID();
    const response = await result(request(staffToken, JSON.stringify({ challenge })));
    const token = parseSessionToken(staffToken)!;
    const expected = createHmac("sha256", token.secret).update(JSON.stringify(["CB06/session/v1", token.id, staffId, restaurantId]), "utf8").digest("base64url");
    expect(response).toEqual({ status: 200, body: { challenge, actorId: staffId, tenantId: restaurantId, sessionBinding: expected, role: "STAFF" } });
    const serialized = JSON.stringify(response.body);
    for (const secret of [staffToken, token.id, token.secret, "passwordHash", "customer", "privateNotes", "notes"]) expect(serialized).not.toContain(secret);
  });
  it("treats a valid client UUIDv8 challenge only as correlation, never as a credential", async () => {
    const challenge = "00000000-0000-8000-8000-000000000001";
    expect((await result(request(staffToken, JSON.stringify({ challenge })))).body.challenge).toBe(challenge);
    expect((await result(request(undefined, JSON.stringify({ challenge })))).status).toBe(401);
  });
  it("validates the identical extracted cookie once and produces a stable binding", async () => {
    const first = await readDraftSessionContext(request(staffToken));
    const second = await readDraftSessionContext(request(staffToken));
    expect(first).toEqual(second);
    expect(first.status).toBe("OK");
  });
  it("distinguishes two sessions of the same actor and tenant", async () => {
    const secondToken = (await createSessionForUser(staffId)).token;
    const a = await result(request(staffToken)), b = await result(request(secondToken));
    expect(a.body.actorId).toBe(b.body.actorId);
    expect(a.body.tenantId).toBe(b.body.tenantId);
    expect(a.body.sessionBinding).not.toBe(b.body.sessionBinding);
  });
  it("derives tenant and current ADMIN role server-side", async () => {
    expect((await result(request(adminToken))).body).toMatchObject({ actorId: adminId, tenantId: restaurantId, role: "ADMIN" });
    expect((await result(request(otherToken))).body).toMatchObject({ actorId: otherId, tenantId: otherRestaurantId, role: "STAFF" });
  });
  it.each([undefined, "invalid", `${randomUUID()}.${"x".repeat(43)}`])("rejects absent or invalid authentication without details", async token => {
    expect(await result(request(token))).toEqual({ status: 401, body: { error: "UNAUTHENTICATED" } });
  });
  it("rejects revoked and expired sessions", async () => {
    const revoked = await createSessionForUser(staffId), expired = await createSessionForUser(staffId, { ttlMs: -1 });
    await revokeSessionToken(revoked.token);
    for (const token of [revoked.token, expired.token]) expect(await result(request(token))).toEqual({ status: 401, body: { error: "UNAUTHENTICATED" } });
  });
  it("preserves the password-change guard and no-store errors", async () => {
    const token = (await createSessionForUser(passwordId)).token;
    expect(await result(request(token))).toEqual({ status: 403, body: { error: "PASSWORD_CHANGE_REQUIRED" } });
  });
  it("preserves canonical revocation of every disabled user's session", async () => {
    const first = await createSessionForUser(disabledId), second = await createSessionForUser(disabledId);
    expect((await result(request(first.token))).status).toBe(401);
    const sessions = await prisma.session.findMany({ where: { id: { in: [first.id, second.id] } } });
    expect(sessions).toHaveLength(2);
    expect(sessions.every(session => session.revokedAt !== null)).toBe(true);
  });
  it.each(["https://attacker.example", "null", "", "http://localhost:4001"])("rejects an untrusted Origin", async value => {
    expect(await result(request(staffToken, undefined, { origin: value }))).toEqual({ status: 403, body: { error: "FORBIDDEN" } });
  });
  it("rejects a missing Origin", async () => {
    const req = request(staffToken); req.headers.delete("origin");
    expect((await result(req)).status).toBe(403);
  });
  it.each(["text/plain", "application/x-www-form-urlencoded", ""])("rejects a non-JSON media type", async type => {
    expect(await result(request(staffToken, undefined, { "content-type": type }))).toEqual({ status: 400, body: { error: "BAD_REQUEST" } });
  });
  it.each(["", "{", "null", "[]", '{}', '{"challenge":"wrong"}', JSON.stringify({ challenge: randomUUID(), tenantId: otherRestaurantId }), JSON.stringify({ challenge: randomUUID(), notes: "ARTIFICIAL_PRIVATE_MARKER" })])("rejects invalid or extra attributes with a static body", async body => {
    expect(await result(request(staffToken, body))).toEqual({ status: 400, body: { error: "BAD_REQUEST" } });
  });
  it("bounds actual stream bytes without trusting Content-Length", async () => {
    for (const length of [undefined, "1", "1024"]) {
      const req = request(staffToken, " ".repeat(1025), length ? { "content-length": length } : {});
      expect(await result(req)).toEqual({ status: 413, body: { error: "PAYLOAD_TOO_LARGE" } });
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(" ".repeat(900))); controller.enqueue(encoder.encode("é".repeat(100))); controller.close(); } });
    const init = { method: "POST", headers: request(staffToken).headers, body: stream, duplex: "half" };
    expect(await result(new Request(`${origin}/api/auth/draft-context`, init))).toEqual({ status: 413, body: { error: "PAYLOAD_TOO_LARGE" } });
  });
  it("accepts exactly 1024 bytes and rejects malformed UTF-8", async () => {
    const body = JSON.stringify({ challenge: randomUUID() });
    expect((await result(request(staffToken, body.padEnd(1024, " ")))).status).toBe(200);
    const req = new Request(`${origin}/api/auth/draft-context`, { method: "POST", headers: request(staffToken).headers, body: new Uint8Array([0xff]) });
    expect(await result(req)).toEqual({ status: 400, body: { error: "BAD_REQUEST" } });
  });
  it("returns static 500 without logging raw credentials or diagnostics", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const query = vi.spyOn(prisma.session, "findUnique").mockRejectedValueOnce(new Error("ARTIFICIAL_SECRET_DIAGNOSTIC"));
    try {
      expect(await result(request(staffToken))).toEqual({ status: 500, body: { error: "INTERNAL_ERROR" } });
      expect(logger).not.toHaveBeenCalled();
    } finally { query.mockRestore(); logger.mockRestore(); }
  });

  async function fingerprint() {
    return prisma.$transaction(async tx => {
      const tables = await tx.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
      const hashes = [];
      for (const { tablename } of tables) {
        if (!/^[a-z_][a-z0-9_]*$/u.test(tablename)) throw Error("Unexpected fixture table");
        hashes.push(await tx.$queryRawUnsafe('SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,\'[]\')) AS fingerprint FROM "' + tablename + '" t'));
      }
      return createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
    }, { isolationLevel: "RepeatableRead" });
  }
  const resourceId = randomUUID();
  const boundaries = [
    { kind: "PHONE", method: "POST", invoke: (req: Request) => PHONE(req), spy: () => vi.spyOn(staffService, "createPhoneReservation") },
    { kind: "EDIT", method: "PATCH", invoke: (req: Request) => EDIT(req, { params: Promise.resolve({ id: resourceId }) }), spy: () => vi.spyOn(staffService, "updateStaffReservation") },
    { kind: "NI", method: "PUT", invoke: (req: Request) => NI(req, { params: Promise.resolve({ id: resourceId }) }), spy: () => vi.spyOn(notesService, "putReservationPrivateNotes") },
  ];
  async function binding(token: string) {
    const proof = await result(request(token)); expect(proof.status).toBe(200);
    return proof.body.sessionBinding as string;
  }
  function mutation(token: string, method: string, value?: string) {
    const headers = request(token, "{}").headers;
    if (value !== undefined) headers.set(DRAFT_SESSION_BINDING_HEADER, value);
    return new Request(`${origin}/api/staff/reservations/${resourceId}`, { method, headers, body: "{}" });
  }
  for (const boundary of boundaries) {
    it.each(["same-actor-new-session", "other-actor", "other-tenant"])(boundary.kind + " SERVER_REJECTED_BEFORE_WRITER for delayed proof A / cookie %s", async variant => {
      const ownerBinding = await binding(staffToken);
      const tokenB = variant === "same-actor-new-session" ? (await createSessionForUser(staffId)).token : variant === "other-actor" ? adminToken : otherToken;
      expect((await binding(tokenB)) === ownerBinding).toBe(false);
      const before = await fingerprint(), spy = boundary.spy(), logger = vi.spyOn(console, "error");
      try {
        const response = await boundary.invoke(mutation(tokenB, boundary.method, ownerBinding));
        expect(response.status).toBe(403); expect(await response.json()).toEqual({ code: "DRAFT_SESSION_MISMATCH" });
        expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
        expect(spy).not.toHaveBeenCalled(); expect(logger).not.toHaveBeenCalled(); expect(await fingerprint()).toBe(before);
      } finally { spy.mockRestore(); logger.mockRestore(); }
    });
    it.each(["", "A", "A".repeat(42), "A".repeat(44), "A".repeat(43) + "=", "A".repeat(42) + "+", "A".repeat(42) + "/", "A".repeat(42) + "B", "A".repeat(20) + " " + "A".repeat(22), "A".repeat(43) + "," + "A".repeat(43), "A".repeat(4096)])(boundary.kind + " rejects noncanonical header %# before writer", async value => {
      const spy = boundary.spy();
      try {
        const response = await boundary.invoke(mutation(staffToken, boundary.method, value));
        expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "DRAFT_SESSION_BINDING_INVALID" }); expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });
    it(boundary.kind + " rejects duplicate/coalesced header values", async () => {
      const req = mutation(staffToken, boundary.method, await binding(staffToken));
      req.headers.append(DRAFT_SESSION_BINDING_HEADER, await binding(staffToken)); const spy = boundary.spy();
      try { const response = await boundary.invoke(req); expect(response.status).toBe(400); expect(await response.json()).toEqual({ code: "DRAFT_SESSION_BINDING_INVALID" }); expect(spy).not.toHaveBeenCalled(); }
      finally { spy.mockRestore(); }
    });
    it.each(["STAFF", "ADMIN"])(boundary.kind + " authenticates once, uses the same %s actor and binding", async role => {
      const token = role === "STAFF" ? staffToken : adminToken, expected = await binding(token);
      const req = mutation(token, boundary.method, expected), headerRead = vi.spyOn(req.headers, "get"), auth = vi.spyOn(sessionService, "validateSessionToken"), query = vi.spyOn(prisma.session, "findUnique"), spy = boundary.spy();
      try {
        // Empty business payload deliberately reaches canonical validation. This
        // proves the boundary allowed the request, not a successful DB mutation.
        await boundary.invoke(req); expect(spy).toHaveBeenCalledTimes(1);
        expect(headerRead.mock.calls.filter(([key]) => key.toLowerCase() === "cookie")).toHaveLength(1);
        expect(auth).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0].actor).toMatchObject({ id: role === "STAFF" ? staffId : adminId, restaurantId });
      } finally { spy.mockRestore(); headerRead.mockRestore(); auth.mockRestore(); query.mockRestore(); }
    });
    it(boundary.kind + " keeps headerless LEGACY_COMPATIBLE_MUTATION at canonical validation", async () => {
      const spy = boundary.spy();
      try { await boundary.invoke(mutation(staffToken, boundary.method)); expect(spy).toHaveBeenCalledTimes(1); }
      finally { spy.mockRestore(); }
    });
    it.each(["revoked", "expired", "password", "disabled"])(boundary.kind + " preserves canonical session guard %s", async condition => {
      const ownerBinding = await binding(staffToken);
      const created = await createSessionForUser(condition === "password" ? passwordId : condition === "disabled" ? disabledId : staffId, condition === "expired" ? { ttlMs: -1 } : {});
      if (condition === "revoked") await revokeSessionToken(created.token);
      const spy = boundary.spy();
      try {
        const response = await boundary.invoke(mutation(created.token, boundary.method, ownerBinding));
        expect(response.status).toBe(condition === "password" ? 403 : 401); expect(spy).not.toHaveBeenCalled();
        if (condition === "disabled") expect((await prisma.session.findUniqueOrThrow({ where: { id: created.id } })).revokedAt !== null).toBe(true);
      } finally { spy.mockRestore(); }
    });
    it(boundary.kind + " preserves Origin/trustProxy guard and fails closed on auth diagnostics", async () => {
      const valid = await binding(staffToken), spy = boundary.spy(), logger = vi.spyOn(console, "error");
      try {
        const req = mutation(staffToken, boundary.method, valid); req.headers.set("origin", "https://attacker.example"); req.headers.set("x-forwarded-host", "attacker.example");
        expect((await boundary.invoke(req)).status).toBe(403); expect(spy).not.toHaveBeenCalled();
        const query = vi.spyOn(prisma.session, "findUnique").mockRejectedValueOnce(Error("ARTIFICIAL_SECRET_DIAGNOSTIC"));
        try { const response = await boundary.invoke(mutation(staffToken, boundary.method, valid)); expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "Internal error" }); expect(spy).not.toHaveBeenCalled(); expect(logger).not.toHaveBeenCalled(); }
        finally { query.mockRestore(); }
      } finally { spy.mockRestore(); logger.mockRestore(); }
    });
  }
});
