import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createContext, Script } from "node:vm";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import * as draftState from "./staff-draft-state";
import type { StaffDraftController } from "@/app/_components/staff/staff-draft-host";
import { authorizeStaffDrafts, beginStaffDraftAttempt, createStaffDraftState, discardStaffDraft, draftHasUnsavedChanges,
  initializeStaffDraft, invalidateStaffDrafts, matchesStaffDraftAttempt, quarantineStaffDrafts, reviewStaffDraftBaseline,
  settleStaffDraftAttempt, staffDraftKey, updateStaffDraft, type StaffDraftKind } from "./staff-draft-state";

const identity = { actorId: "fake-actor", tenantId: "fake-tenant", sessionBinding: "fake-session", role: "STAFF" as const };

// Execute the actual client controller, without mounting React or creating a
// server singleton. Browser/API I/O is simulated here; real HTTP is covered E2E.
async function controllerFixture(kind: StaffDraftKind) {
  const source = readFileSync(new URL("../../../app/_components/staff/staff-draft-host.tsx", import.meta.url), "utf8");
  const controllerSource = source.slice(source.indexOf("export interface VolatileAgendaState"), source.indexOf("\nexport type StaffDraftController"));
  const compiled = transpileModule(controllerSource + "\nglobalThis.factory = createStaffDraftController;", { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS } }).outputText;
  const owner = { actorId: randomUUID(), tenantId: randomUUID(), sessionBinding: "A".repeat(43), role: "STAFF" as const };
  let proofs = 0, mutations = 0;
  const mutationHeaders: Headers[] = [];
  let mutationResponse = async () => Response.json({ version: 2 });
  let proofResponse: (challenge: string) => Promise<Response> = async challenge => Response.json({ ...owner, challenge });
  const id = randomUUID();
  const context = createContext({ ...draftState, exports: {}, createClientIdempotencyKey: randomUUID,
    window: { location: { pathname: "/dashboard", search: "" } }, document: { activeElement: null, querySelector: () => null }, HTMLElement: class {},
    requestAnimationFrame: (callback: () => void) => callback(), flushSync: (callback: () => void) => callback(),
    fetch: async (url: string, init: RequestInit = {}) => {
      if (url === "/api/auth/draft-context") { ++proofs; return proofResponse(JSON.parse(String(init.body)).challenge as string); }
      if (!init.method || init.method === "GET") return Response.json(kind === "NI"
        ? { reservation: { id, version: 1, status: "CONFIRMED" }, privateNotes: null, privateNotesPresent: false, legacyAssignment: null }
        : { reservation: { id, version: 1, status: "CONFIRMED", customer: { firstName: "Fake", lastName: "Test", phone: "+390000000000" }, localDate: "2099-12-18", arrivalTime: "19:00", serviceType: "DINNER" } });
      ++mutations; mutationHeaders.push(new Headers(init.headers)); return mutationResponse();
    },
  });
  new Script(compiled).runInContext(context);
  const controller = (context.factory as () => StaffDraftController)();
  await controller.verifySession();
  controller.initialize({ kind, resourceId: id, instanceId: randomUUID(), route: "/dashboard", originPath: "/dashboard", values: { note: "old" }, baseVersion: kind === "PHONE" ? null : 1 });
  const key = draftState.staffDraftKey(owner, kind, id);
  controller.patchDraft(key, { note: "ARTIFICIAL_DRAFT" }); controller.activateDraft("editor", key);
  const submit = () => controller.mutate({ key, url: "/api/staff/reservations/" + id, method: kind === "PHONE" ? "POST" : kind === "EDIT" ? "PATCH" : "PUT", payload: '{"note":"ARTIFICIAL_DRAFT"}', idempotencyKey: kind === "PHONE" ? "fixed-key" : undefined,
    validate: () => ({ resourceId: id, version: 2, text: "confirmed" }) });
  return { controller, key, owner, submit, mutationHeaders, setMutation: (next: typeof mutationResponse) => { mutationResponse = next; }, setProof: (next: typeof proofResponse) => { proofResponse = next; }, counts: () => ({ proofs, mutations }) };
}

describe("F01-TOCTOU original binding dispatch and server rejection fencing", () => {
  for (const kind of ["PHONE", "EDIT", "NI"] as const) {
    it(kind + " always sends the frozen owner's canonical binding after delayed proof", async () => {
      const f = await controllerFixture(kind); let release: () => void = () => undefined;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      f.setProof(async challenge => { const proof = { ...f.owner, challenge }; await waiting; return Response.json(proof); });
      const pending = f.submit(); release(); expect((await pending).confirmed).toBe(true);
      expect(f.mutationHeaders).toHaveLength(1);
      expect(f.mutationHeaders[0].get("X-Piccadilly-Draft-Session-Binding") === f.owner.sessionBinding).toBe(true);
    });
    it.each(["", "invalid", "B".repeat(43)])(kind + " CLIENT_NO_DISPATCH with missing/noncanonical owner constraint %#", async value => {
      const f = await controllerFixture(kind);
      f.controller.getSnapshot().drafts.identity!.sessionBinding = value;
      expect((await f.submit()).confirmed).toBe(false); expect(f.counts().mutations).toBe(0);
      expect(f.controller.sessionVisible()).toBe(false);
    });
    it.each([400, 403])(kind + " never falls back to legacy after server binding rejection %s", async status => {
      const f = await controllerFixture(kind);
      f.setMutation(async () => Response.json({ code: status === 400 ? "DRAFT_SESSION_BINDING_INVALID" : "DRAFT_SESSION_MISMATCH" }, { status }));
      expect((await f.submit()).confirmed).toBe(false); await f.submit();
      expect(f.counts().mutations).toBe(1); expect(f.controller.sessionVisible()).toBe(false);
      expect(f.controller.getSnapshot().notice).toContain("server ha rifiutato");
      expect(f.controller.getSnapshot().notice).not.toContain("Nessun invio");
    });
    it(kind + " late mismatch cannot erase a new instance or attribute an ACK", async () => {
      const f = await controllerFixture(kind); let release: () => void = () => undefined, reached: () => void = () => undefined;
      const waiting = new Promise<void>(resolve => { release = resolve; }), dispatched = new Promise<void>(resolve => { reached = resolve; });
      f.setMutation(async () => { reached(); await waiting; return Response.json({ code: "DRAFT_SESSION_MISMATCH" }, { status: 403 }); });
      const record = f.controller.getSnapshot().drafts.records[f.key], pending = f.submit(); await dispatched;
      f.controller.destroyDocumentState(); await f.controller.verifySession();
      f.controller.initialize({ kind, resourceId: record.resourceId, instanceId: "new-instance", route: "/dashboard", originPath: "/dashboard", values: { note: "REPLACEMENT_ONLY" }, baseVersion: record.baseVersion });
      release(); expect((await pending).confirmed).toBe(false);
      expect(f.controller.getSnapshot().drafts.records[f.key].values.note).toBe("REPLACEMENT_ONLY");
      expect(f.controller.getSnapshot().detachedReceipt).toBeNull(); expect(f.controller.sessionVisible()).toBe(true);
    });
  }
});

describe("F01/F02 actual controller pre-dispatch session barrier", () => {
  for (const kind of ["PHONE", "EDIT", "NI"] as const) {
    it.each(["sessionBinding", "actorId", "tenantId", "role"] as const)(kind + " refuses changed %s without any browser event", async field => {
      const f = await controllerFixture(kind);
      f.setProof(async challenge => Response.json({ ...f.owner, [field]: field === "sessionBinding" ? "B".repeat(43) : field === "role" ? "ADMIN" : randomUUID(), challenge }));
      expect((await f.submit()).confirmed).toBe(false);
      expect(f.counts()).toEqual({ proofs: 2, mutations: 0 });
      expect(f.controller.getSnapshot().drafts.records[f.key]).toBeUndefined();
    });
    it.each([401, 403, 500, "network", "malformed", "wrong-challenge"] as const)(kind + " fails closed for proof %s", async failure => {
      const f = await controllerFixture(kind), before = f.controller.getSnapshot().drafts.records[f.key];
      f.setProof(async challenge => {
        if (failure === "network") throw Error("artificial offline");
        return failure === "malformed" ? Response.json({ challenge }) : failure === "wrong-challenge" ? Response.json({ ...f.owner, challenge: randomUUID() }) : Response.json({}, { status: failure });
      });
      expect((await f.submit()).confirmed).toBe(false); expect(f.counts().mutations).toBe(0);
      const record = f.controller.getSnapshot().drafts.records[f.key];
      if (failure === 401 || failure === 403) expect(record).toBeUndefined();
      else { expect(record.values).toEqual(before.values); expect(record.baseVersion).toBe(before.baseVersion); expect(record.phase).toBe("ERROR"); expect(f.controller.sessionVisible()).toBe(false); }
    });
    it(kind + " locks synchronously, takes a fresh proof and never dispatches twice", async () => {
      const f = await controllerFixture(kind); let release: () => void = () => undefined;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      f.setProof(async challenge => { await waiting; return Response.json({ ...f.owner, challenge }); });
      const first = f.submit(); expect(f.controller.getSnapshot().drafts.records[f.key].phase).toBe("PENDING");
      f.controller.patchDraft(f.key, { note: "MUST_NOT_REPLACE" });
      expect(f.controller.getSnapshot().drafts.records[f.key].values.note).toBe("ARTIFICIAL_DRAFT");
      await f.submit(); expect(f.counts().mutations).toBe(0); release();
      expect((await first).confirmed).toBe(true); expect(f.counts()).toEqual({ proofs: 2, mutations: 1 });
    });
    it(kind + " ignores delayed old proof after a later generation authorizes", async () => {
      const f = await controllerFixture(kind); let release: () => void = () => undefined;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      f.setProof(async challenge => { await waiting; return Response.json({ ...f.owner, challenge }); });
      const old = f.submit(); f.controller.quarantine();
      f.setProof(async challenge => Response.json({ ...f.owner, sessionBinding: "B".repeat(43), challenge }));
      await f.controller.verifySession(); release(); await old;
      expect(f.counts().mutations).toBe(0); expect(f.controller.getSnapshot().drafts.identity?.sessionBinding).toBe("B".repeat(43));
      expect(f.controller.getSnapshot().drafts.records).toEqual({});
    });
    it(kind + " includes retained drafts in the logout guard and STAY preserves them", async () => {
      const f = await controllerFixture(kind); f.controller.releaseDraft("editor");
      f.controller.requestLogout(); expect(f.controller.getSnapshot().guard?.keys).toEqual([f.key]);
      expect(f.controller.getSnapshot().guard?.purpose).toBe("LOGOUT");
      f.controller.resolveExit("STAY"); expect(f.controller.getSnapshot().drafts.records[f.key].values.note).toBe("ARTIFICIAL_DRAFT");
      expect(f.counts().mutations).toBe(0);
    });
    it(kind + " old proof cannot dispatch or erase a replacement instance with the same logical key", async () => {
      const f = await controllerFixture(kind); let release: () => void = () => undefined;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      f.setProof(async challenge => { await waiting; return Response.json({ ...f.owner, challenge }); });
      const oldRecord = f.controller.getSnapshot().drafts.records[f.key], old = f.submit();
      f.controller.destroyDocumentState(); f.setProof(async challenge => Response.json({ ...f.owner, challenge })); await f.controller.verifySession();
      f.controller.initialize({ kind, resourceId: oldRecord.resourceId, instanceId: "replacement-instance", route: "/dashboard", originPath: "/dashboard", values: { note: "REPLACEMENT_ONLY" }, baseVersion: oldRecord.baseVersion });
      release(); await old; expect(f.counts().mutations).toBe(0);
      expect(f.controller.getSnapshot().drafts.records[f.key].values.note).toBe("REPLACEMENT_ONLY");
    });
    it(kind + " temporary proof failure preserves data and only a new explicitly authorized attempt can send", async () => {
      const f = await controllerFixture(kind); f.setProof(async () => { throw Error("offline"); });
      await f.submit(); expect(f.counts().mutations).toBe(0);
      f.setProof(async challenge => Response.json({ ...f.owner, challenge })); await f.controller.verifySession();
      const current = f.controller.getSnapshot().drafts.records[f.key]; expect(current.values.note).toBe("ARTIFICIAL_DRAFT");
      if (kind === "PHONE") expect(current.retryIdentity?.key).toBe("fixed-key");
      f.controller.review(f.key, { version: 1, serverValues: { note: "old" }, selectedFields: ["note"] });
      expect((await f.submit()).confirmed).toBe(true); expect(f.counts()).toEqual({ proofs: 4, mutations: 1 });
    });
  }
});
function fixture(kind: StaffDraftKind = "NI", resourceId = "fake-reservation") {
  const initial = authorizeStaffDrafts(createStaffDraftState(), identity);
  const key = staffDraftKey(identity, kind, resourceId);
  const state = initializeStaffDraft(initial, { kind, resourceId, instanceId: "instance-1", route: "/dashboard", originPath: "/dashboard", values: { notes: "", checkbox: false, partySize: "2" }, baseVersion: kind === "PHONE" ? null : 1 });
  return { state, key };
}
describe("Staff draft ownership, pending snapshot and session fencing", () => {
  it("invalidates records and attempts after a live role change", () => {
    const { state, key } = fixture();
    const pending = beginStaffDraftAttempt(state, key, { id: "old", payload: "frozen" });
    const changed = authorizeStaffDrafts(pending, { ...identity, role: "ADMIN" });
    expect(changed.records).toEqual({});
    expect(matchesStaffDraftAttempt(changed, key, pending.records[key].attempt!)).toBe(false);
  });
  it("does not create or render a draft without authorization", () => {
    const { state, key } = fixture();
    expect(updateStaffDraft(quarantineStaffDrafts(state), key, { notes: "forbidden" }).records[key].values.notes).toBe("");
    expect(initializeStaffDraft(createStaffDraftState(), state.records[key]).records).toEqual({});
  });
  it.each(["PHONE", "EDIT", "NI"] as const)("retains %s values across a display lease invalidation", kind => {
    const { state, key } = fixture(kind), dirty = updateStaffDraft(state, key, { notes: "ARTIFICIAL_😀", checkbox: true, partySize: "7" });
    const restored = authorizeStaffDrafts(quarantineStaffDrafts(dirty), identity);
    expect(restored.records[key]).toEqual(dirty.records[key]);
    expect(draftHasUnsavedChanges(restored.records[key])).toBe(true);
    expect(restored.authEpoch).toBe(dirty.authEpoch);
    expect(restored.leaseEpoch).toBeGreaterThan(dirty.leaseEpoch);
  });
  it.each(["actorId", "tenantId", "sessionBinding"] as const)("clears every private record when %s changes", field => {
    const { state } = fixture();
    const next = authorizeStaffDrafts(state, { ...identity, [field]: "different" });
    expect(next.records).toEqual({}); expect(next.authEpoch).toBeGreaterThan(state.authEpoch);
  });
  it("captures all fields before pending and rejects both edits and a second submit synchronously", () => {
    const { state, key } = fixture("PHONE");
    const dirty = updateStaffDraft(state, key, { notes: "A", checkbox: true, partySize: "5" });
    const pending = beginStaffDraftAttempt(dirty, key, { id: "attempt-A", payload: "complete-payload", idempotencyKey: "phone-key" });
    expect(updateStaffDraft(pending, key, { notes: "B" })).toBe(pending);
    expect(beginStaffDraftAttempt(pending, key, { id: "attempt-B", payload: "other" })).toBe(pending);
    expect(discardStaffDraft(pending, key)).toBe(pending);
    expect(pending.records[key].attempt?.values).toEqual(dirty.records[key].values);
    expect(pending.records[key].retryIdentity).toEqual({ signature: "complete-payload", key: "phone-key" });
    expect(Object.isFrozen(pending.records[key].attempt)).toBe(true);
  });
  it.each(["ERROR", "DIRTY_CONFLICT"] as const)("preserves the complete form and PHONE retry identity on %s", kind => {
    const { state, key } = fixture("PHONE"), pending = beginStaffDraftAttempt(state, key, { id: "a", payload: "same", idempotencyKey: "same-key" });
    const next = settleStaffDraftAttempt(pending, key, pending.records[key].attempt!, { kind, error: "static error" });
    expect(next.records[key].values).toEqual(state.records[key].values);
    expect(next.records[key].baseVersion).toBeNull();
    expect(next.records[key].retryIdentity?.key).toBe("same-key");
  });
  it("invalidates a confirmed attempt without resetting the acknowledged PHONE values", () => {
    const { state, key } = fixture("PHONE"), dirty = updateStaffDraft(state, key, { notes: "confirmed values" });
    const pending = beginStaffDraftAttempt(dirty, key, { id: "a", payload: "payload", idempotencyKey: "key" });
    const next = settleStaffDraftAttempt(pending, key, pending.records[key].attempt!, { kind: "CONFIRMED", version: 1, receipt: { resourceId: "actual-created-id", originPath: "/dashboard", text: "Confermato" } });
    expect(next.records[key].values.notes).toBe("confirmed values");
    expect(next.records[key].retryIdentity).toBeNull(); expect(next.records[key].attempt).toBeNull();
    expect(draftHasUnsavedChanges(next.records[key])).toBe(false);
    expect(settleStaffDraftAttempt(next, key, pending.records[key].attempt!, { kind: "ERROR", error: "late" })).toBe(next);
  });
  it("an old ACK or error cannot change a recreated instance with the same key", () => {
    const { state, key } = fixture(), pending = beginStaffDraftAttempt(state, key, { id: "a", payload: "A" }), stamp = pending.records[key].attempt!;
    const denied = invalidateStaffDrafts(pending), reauthorized = authorizeStaffDrafts(denied, identity);
    const recreated = initializeStaffDraft(reauthorized, { ...state.records[key], instanceId: "instance-2", values: { notes: "B" } });
    expect(matchesStaffDraftAttempt(recreated, key, stamp)).toBe(false);
    expect(settleStaffDraftAttempt(recreated, key, stamp, { kind: "ERROR", error: "late" })).toBe(recreated);
    expect(recreated.records[key].values.notes).toBe("B");
  });
  it("fences mismatched resource, attempt, version and identity epoch", () => {
    const { state, key } = fixture(), pending = beginStaffDraftAttempt(state, key, { id: "a", payload: "A" }), stamp = pending.records[key].attempt!;
    for (const changed of [{ ...stamp, resourceId: "other" }, { ...stamp, id: "old" }, { ...stamp, baseVersion: 2 }, { ...stamp, authEpoch: 99 }, { ...stamp, instanceId: "old-instance" }]) {
      expect(matchesStaffDraftAttempt(pending, key, changed)).toBe(false);
    }
    expect(matchesStaffDraftAttempt(quarantineStaffDrafts(pending), key, stamp)).toBe(false);
    expect(matchesStaffDraftAttempt(authorizeStaffDrafts(quarantineStaffDrafts(pending), identity), key, stamp)).toBe(true);
  });
  it("discards only the selected kind and reservation, preserving other dirty records", () => {
    const { state, key } = fixture();
    let many = initializeStaffDraft(state, { ...state.records[key], kind: "EDIT", instanceId: "edit", values: { notes: "NC" } });
    many = initializeStaffDraft(many, { ...state.records[key], resourceId: "another", instanceId: "another", values: { notes: "other NI" } });
    const next = discardStaffDraft(many, key);
    expect(Object.keys(next.records)).toHaveLength(2);
    expect(Object.values(next.records).map(r => r.values.notes).sort()).toEqual(["NC", "other NI"]);
  });
  it("server re-read does not overwrite input and explicit reapply preserves unselected concurrent changes", () => {
    const { state, key } = fixture("EDIT"), dirty = updateStaffDraft(state, key, { notes: "my NC", checkbox: true, partySize: "7" });
    expect(dirty.records[key].baseVersion).toBe(1);
    const next = reviewStaffDraftBaseline(dirty, key, { version: 2, serverValues: { notes: "other NC", checkbox: false, partySize: "9" }, selectedFields: ["notes"] });
    expect(next.records[key].values).toEqual({ notes: "my NC", checkbox: false, partySize: "9" });
    expect(next.records[key].baseVersion).toBe(2);
  });
});
