import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { isIPv4 } from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createLinuxAuthority, createLinuxLineReader, linuxExact, reconcileLinuxProcesses } from "./m13-p1-worker-linux-entry.mjs";
import { Client } from "pg";
import { EXPECTED_STAGING_MIGRATION_NAMES, inspectMigrationLedger } from "./staging-worker-startup.mjs";

export const WORKER_LIMITS = Object.freeze({ role: 600_000, guard: 15_000, query: 5_000, join: 5_000, stop: 10_000, cohort: 60_000, lease: 120_000 });
export class WorkerRunError extends Error {
  constructor(code) { super(code); this.name = "WorkerRunError"; this.code = code; }
}
export const requireWorker = (value, code) => { if (!value) throw new WorkerRunError(code); };
const hash = value => createHash("sha256").update(value).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const uuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/u.test(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const scenarios = ["concurrent", "row-lock", "retry", "crash"];
const string = value => typeof value === "string" && value.length > 0 && value.length <= 1024;
const integer = value => Number.isSafeInteger(value) && value > 0;
function validData(type, d) {
  if (!object(d)) return false;
  switch (type) {
    case "HELLO": return exact(d, ["pid", "node", "execPath"]) && integer(d.pid) && string(d.node) && string(d.execPath);
    case "INIT": case "READY": return exact(d, ["identity"]) && object(d.identity);
    case "START": case "STOP": return exact(d, []);
    case "INTERRUPT": return exact(d, []);
    case "FIXTURE": case "CONFIGURED": return exact(d, ["scenario"]) && scenarios.includes(d.scenario);
    case "CONFIGURE": return exact(d, ["scenario", "ids"]) && scenarios.includes(d.scenario) && Array.isArray(d.ids) && d.ids.length > 0 && d.ids.length <= 12 && d.ids.every(uuid);
    case "FIXTURE_DONE": return exact(d, ["scenario", "restaurantId", "ids", "channels"]) && scenarios.includes(d.scenario) && uuid(d.restaurantId) && Array.isArray(d.ids) && d.ids.length > 0 && d.ids.length <= 12 && d.ids.every(uuid) && new Set(d.ids).size === d.ids.length && Array.isArray(d.channels) && d.channels.length === d.ids.length && d.channels.every(v => ["WHATSAPP", "EMAIL"].includes(v));
    case "REQUEST":
      if (!integer(d.id) || !["batch", "claim", "claimed", "receipt"].includes(d.point)) return false;
      if (d.point === "claimed") return exact(d, ["id", "point", "rows"]) && Array.isArray(d.rows) && d.rows.length <= 5 && d.rows.every(r => exact(r, ["id", "lease"]) && uuid(r.id) && /^[a-f0-9]{64}$/u.test(r.lease));
      if (d.point === "receipt") return exact(d, ["id", "point", "outboxId"]) && uuid(d.outboxId);
      return exact(d, ["id", "point"]);
    case "REPLY": return exact(d, ["id"]) && integer(d.id);
    case "STOPPED": return exact(d, ["exitCode", "databaseClosed", "aborted"]) && d.exitCode === 0 && d.databaseClosed === true && d.aborted === true;
    case "ERROR": return exact(d, ["code"]) && d.code === "P1C_CONSUMER_FAILED";
    case "EVENT":
      if (d.event === "abort-observed") return exact(d, ["event"]);
      if (d.event === "recovered") return exact(d, ["event", "count"]) && integer(d.count) && d.count <= 100;
      if (["attempt-started", "provider-start"].includes(d.event)) return exact(d, ["event", "id"]) && uuid(d.id);
      if (d.event === "finalized") return exact(d, ["event", "id", "outcome"]) && uuid(d.id) && ["SUCCEEDED", "PENDING", "DEAD", "CANCELLED", "STALE"].includes(d.outcome);
      if (d.event === "runtime-failure") return exact(d, ["event", "code"]) && /^[A-Z_]{3,64}$/u.test(d.code);
      if (d.event === "receipt-observed") return exact(d, ["event", "id", "reference", "payloadHash", "deduplicated"]) && uuid(d.id) && /^sim-(wa|email)-[a-f0-9]{48}$/u.test(d.reference) && /^[a-f0-9]{64}$/u.test(d.payloadHash) && typeof d.deduplicated === "boolean";
      return false;
    default: return false;
  }
}
export function createWorkerPeer(correlation, send) {
  let sent = 0, received = 0;
  for (const key of ["runId", "generation", "nonce"]) requireWorker(uuid(correlation[key]), "P1C_CORRELATION_INVALID");
  requireWorker(["A", "B"].includes(correlation.slot), "P1C_SLOT_INVALID");
  const context = { v: 1, runId: correlation.runId, generation: correlation.generation, slot: correlation.slot, nonce: correlation.nonce };
  return {
    send(type, data = {}) {
      requireWorker(validData(type, data), "P1C_PACKET_REJECTED");
      send({ ...context, seq: ++sent, type, data });
    },
    receive(value) {
      requireWorker(exact(value, ["v", "runId", "generation", "slot", "nonce", "seq", "type", "data"]), "P1C_PACKET_REJECTED");
      requireWorker(Object.entries(context).every(([k, v]) => value[k] === v) && value.seq === received + 1 && validData(value.type, value.data), "P1C_PACKET_REJECTED");
      received++; return value;
    },
  };
}
export { validData as validateWorkerData };
function ipv4(value) {
  requireWorker(typeof value === "string", "P1C_IDENTITY_MISMATCH");
  const match = /^(\d+\.\d+\.\d+\.\d+)(?:\/32)?$/u.exec(value);
  requireWorker(match && isIPv4(match[1]), "P1C_IDENTITY_MISMATCH"); return match[1];
}
export function assertWorkerIdentity(expected, actual) {
  const keys = ["database", "role", "version", "dataDirectory", "systemIdentifier", "postmasterStart", "serverAddress", "clientAddress", "serverPort"];
  requireWorker(exact(expected, keys) && exact(actual, keys), "P1C_IDENTITY_MISMATCH");
  requireWorker(keys.every(k => ["serverAddress", "clientAddress"].includes(k) ? ipv4(expected[k]) === ipv4(actual[k]) : expected[k] === actual[k]), "P1C_IDENTITY_MISMATCH");
}
export function serialWorkerGuard({ ownershipGuard, environment, generation, signal, onAbort = error => { void error; }, now = () => performance.now() }) {
  let tail = Promise.resolve();
  const guard = async phase => {
    const deadline = now() + WORKER_LIMITS.guard;
    const assert = () => { requireWorker(!signal.aborted, "P1C_ABORTED"); requireWorker(now() < deadline, "P1C_GUARD_TIMEOUT"); };
    let timer;
    const work = tail.then(async () => {
      assert(); const result = await ownershipGuard({ phase, environment, signal }); assert();
      requireWorker(result?.valid === true && result.status === "PASS_VERIFIED" && result.generation === generation, "P1C_OWNERSHIP_NOT_VERIFIED");
      return result;
    });
    tail = work.catch(() => {});
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(signal.reason ?? new WorkerRunError("P1C_ABORTED")); signal.addEventListener("abort", rejectAbort, { once: true }); if (signal.aborted) rejectAbort(); });
    const expired = new Promise((_, reject) => { timer = setTimeout(() => {
      const error = new WorkerRunError("P1C_GUARD_TIMEOUT"); onAbort(error); reject(error);
    }, WORKER_LIMITS.guard); });
    try { return await Promise.race([work, expired, aborted]); }
    catch (error) { onAbort(error); throw error; }
    finally { clearTimeout(timer); signal.removeEventListener("abort", rejectAbort); }
  };
  guard.drain = async () => {
    let timer;
    try { await Promise.race([tail, new Promise((_, reject) => { timer = setTimeout(() => reject(new WorkerRunError("P1C_GUARD_JOIN_UNKNOWN")), WORKER_LIMITS.join); })]); }
    finally { clearTimeout(timer); }
  };
  return guard;
}
export async function joinWorker(child, milliseconds = Number(WORKER_LIMITS.join)) {
  requireWorker(milliseconds > 0 && milliseconds <= WORKER_LIMITS.join, "P1C_JOIN_BUDGET");
  if (child.joined) return;
  let timer;
  try {
    await Promise.race([child.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new WorkerRunError("P1C_JOIN_UNKNOWN")), milliseconds); })]);
    requireWorker(child.joined, "P1C_JOIN_UNKNOWN");
  } finally { clearTimeout(timer); }
}

// The role owns termination; the harness delegates to this same capability.
// Only handles returned by this run's spawn sites can enter this registry.
export function createWorkerShutdown({ runId, generation, record = value => { void value; }, afterJoin = async control => { void control; }, now = () => performance.now(), onFailure = error => { void error; } }) {
  requireWorker(uuid(runId) && uuid(generation), "P1C_CORRELATION_INVALID");
  const entries = new Map(); let all, allScope, closing = false, evidenceFailure, groupControl, groupSettled = false;
  const code = error => /^[A-Z][A-Z0-9_]{2,79}$/u.test(error?.code ?? "") ? error.code : "P1C_SHUTDOWN_FAILED";
  const safeError = error => { const result = new WorkerRunError(code(error)); if (error?.joinFailure) result.joinFailure = code({ code: error.joinFailure }); return result; };
  const log = (entry, event, fields = {}) => {
    try { record({ kind: "worker-shutdown", event, runCorrelationId: runId, generation, clockDomain: "WORKER_SHUTDOWN", monotonicMs: now(),
      processId: entry?.pid ?? null, processRole: entry?.role ?? "GROUP", requestId: entry?.requestId ?? null, ...fields }); }
    catch { if (!evidenceFailure) { evidenceFailure = new WorkerRunError("P1C_SHUTDOWN_EVIDENCE_FAILED"); onFailure(evidenceFailure); } }
  };
  const ownControl = supplied => {
    const controller = new AbortController(), links = new Map(); let deadline = now() + WORKER_LIMITS.stop, timer, disposed = false;
    const expire = () => controller.abort(new WorkerRunError("P1C_SHUTDOWN_TIMEOUT"));
    const arm = () => { clearTimeout(timer); if (deadline <= now()) expire(); else timer = setTimeout(expire, Math.max(1, deadline - now())); };
    const adopt = parent => {
      if (!parent || disposed) return;
      requireWorker(typeof parent.effectiveTimeout === "function" && parent.signal, "P1C_SHUTDOWN_CONTROL_INVALID");
      const remaining = parent.effectiveTimeout(); requireWorker(Number.isFinite(remaining), "P1C_SHUTDOWN_CONTROL_INVALID");
      deadline = Math.min(deadline, now() + Math.max(0, remaining));
      if (!links.has(parent.signal)) {
        const abort = () => controller.abort(safeError(parent.signal.reason)); links.set(parent.signal, abort);
        parent.signal.addEventListener("abort", abort, { once: true }); if (parent.signal.aborted) abort();
      }
      arm();
    };
    const control = { signal: controller.signal, effectiveTimeout: () => Math.max(0, deadline - now()),
      beforeSpawn() { if (now() >= deadline) expire(); if (controller.signal.aborted) throw controller.signal.reason; } };
    arm(); adopt(supplied);
    return { control, adopt, dispose() { disposed = true; clearTimeout(timer); for (const [signal, abort] of links) signal.removeEventListener("abort", abort); } };
  };
  const wait = (promise, control, maximumMs = null) => new Promise((resolveWait, rejectWait) => {
    let settled = false, timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); control.signal.removeEventListener("abort", abort); if (error) rejectWait(error); else resolveWait(value); };
    const abort = () => finish(control.signal.reason ?? new WorkerRunError("P1C_SHUTDOWN_TIMEOUT"));
    if (maximumMs !== null) timer = setTimeout(() => finish(new WorkerRunError("P1C_SHUTDOWN_JOIN_UNKNOWN")), Math.max(1, Math.min(maximumMs, control.effectiveTimeout())));
    control.signal.addEventListener("abort", abort, { once: true });
    if (control.signal.aborted) abort();
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
  const track = (child, { role, graceful, spawnStartedAt, spawnReturnedAt, reconciliationControl } = {}) => {
    requireWorker(!groupSettled, "P1C_LATE_PROCESS_REGISTRATION");
    requireWorker(child && integer(child.pid) && typeof child.once === "function" && ["CONSUMER_A", "CONSUMER_B", "PROCESS_PROBE"].includes(role), "P1C_OWNED_HANDLE_REQUIRED");
    if (reconciliationControl) { requireWorker(closing && role === "PROCESS_PROBE" && reconciliationControl === groupControl, "P1C_SHUTDOWN_CONTROL_INVALID"); reconciliationControl.beforeSpawn(); }
    if (entries.has(child)) return entries.get(child);
    let resolveClose;
    const entry = { child, pid: child.pid, role, graceful, spawnStartedAt, spawnReturnedAt, requestId: null, stop: null,
      closeObserved: false, exitObserved: typeof child.exitCode === "number" || typeof child.signalCode === "string", forceIssued: false,
      close: new Promise(done => { resolveClose = done; }), failure: null };
    entries.set(child, entry);
    child.once("exit", () => { entry.exitObserved = true; log(entry, "exit-observed"); });
    child.once("close", () => { entry.closeObserved = true; resolveClose(); log(entry, "close-observed", { identityMatches: child.pid === entry.pid }); });
    log(entry, "registered", { parentProcessId: process.pid, spawnStartedAt: Number.isFinite(spawnStartedAt) ? spawnStartedAt : null, spawnReturnedAt: Number.isFinite(spawnReturnedAt) ? spawnReturnedAt : null });
    if (reconciliationControl) {
      const abort = () => { stopOne(child, { force: true, control: reconciliationControl }).catch(() => {}); };
      reconciliationControl.signal.addEventListener("abort", abort, { once: true });
      child.once("close", () => reconciliationControl.signal.removeEventListener("abort", abort));
      if (reconciliationControl.signal.aborted) abort();
    } else if (closing) stopOne(child, { control: groupControl }).catch(() => {});
    return entry;
  };
  /**
   * @param {object} child
   * @param {{ force?: boolean, control?: { signal: AbortSignal, effectiveTimeout: () => number, beforeSpawn: () => void } }} [options]
   */
  const stopOne = (child, options = {}) => {
    const { force = false, control: supplied } = options;
    const entry = entries.get(child);
    if (!entry || child.pid !== entry.pid) return Promise.reject(new WorkerRunError("P1C_UNOWNED_STOP_FORBIDDEN"));
    if (entry.stop) { entry.scope.adopt(supplied); return entry.stop; }
    entry.requestId = randomUUID();
    const scope = ownControl(supplied), control = scope.control; entry.scope = scope;
    entry.stop = Promise.resolve().then(async () => {
      let failure;
      const forceOwnedHandle = () => {
        if (entry.forceIssued || entry.closeObserved || entry.exitObserved) return;
        if (child.pid !== entry.pid) { failure ??= new WorkerRunError("P1C_UNOWNED_STOP_FORBIDDEN"); return; }
        entry.forceIssued = true; log(entry, "owned-handle-stop", { method: "CHILD_PROCESS_HANDLE", subtreeTermination: false });
        try { requireWorker(typeof child.kill === "function" && child.kill("SIGKILL") === true, "P1C_OWNED_HANDLE_STOP_FAILED"); }
        catch { failure ??= new WorkerRunError("P1C_OWNED_HANDLE_STOP_FAILED"); }
      };
      const cancelled = () => { failure ??= safeError(control.signal.reason); forceOwnedHandle(); };
      control.signal.addEventListener("abort", cancelled, { once: true });
      if (control.signal.aborted) cancelled();
      try {
        control.beforeSpawn(); log(entry, "stop-start", { force, alreadyExited: entry.exitObserved, alreadyClosed: entry.closeObserved });
        if (!entry.closeObserved && !entry.exitObserved && !force && entry.graceful) {
          log(entry, "graceful-stop-request");
          try { await wait(Promise.resolve(entry.graceful()), control); }
          catch { failure ??= new WorkerRunError("P1C_GRACEFUL_STOP_REQUEST_FAILED"); log(entry, "graceful-request-failed", { failure: failure.code }); }
          let timer;
          try { await wait(Promise.race([entry.close, new Promise(done => { timer = setTimeout(done, Math.max(1, Math.min(WORKER_LIMITS.join, control.effectiveTimeout() / 2))); })]), control); }
          finally { clearTimeout(timer); }
        }
        if (!entry.closeObserved && !entry.exitObserved) forceOwnedHandle();
        await wait(entry.close, control, WORKER_LIMITS.join); control.beforeSpawn();
        requireWorker(entry.closeObserved && child.pid === entry.pid, "P1C_SHUTDOWN_JOIN_UNKNOWN");
        if (failure) throw failure;
        if (evidenceFailure) throw evidenceFailure;
        log(entry, "joined"); if (evidenceFailure) throw evidenceFailure;
        return { pid: entry.pid, closeObserved: true, requestId: entry.requestId };
      } catch (error) {
        if (failure && failure !== error) { failure.joinFailure = code(error); error = failure; }
        entry.failure = code(error); log(entry, "stop-failed", { failure: entry.failure, closeObserved: entry.closeObserved }); throw safeError(error);
      } finally { control.signal.removeEventListener("abort", cancelled); scope.dispose(); }
    });
    return entry.stop;
  };
  const stopAll = supplied => {
    if (all) { allScope.adopt(supplied); return all; }
    closing = true; const scope = ownControl(supplied), control = scope.control;
    allScope = scope;
    groupControl = control;
    all = Promise.resolve().then(async () => {
      log(null, "group-stop-start", { effectiveTimeoutMs: control.effectiveTimeout(), deadlineMonotonicMs: now() + control.effectiveTimeout() });
      let primary; const visited = new Set();
      while (true) {
        const batch = [...entries.keys()].filter(child => !visited.has(child)); if (!batch.length) break;
        batch.forEach(child => visited.add(child));
        const results = await Promise.allSettled(batch.map(child => stopOne(child, { control })));
        for (const result of results) if (result.status === "rejected") primary ??= result.reason;
        if (control.signal.aborted) break;
      }
      try { control.beforeSpawn(); await wait(afterJoin(control), control); control.beforeSpawn(); }
      catch (error) { log(null, "reconciliation-failed", { failure: code(error) }); if (primary) primary.reconciliationFailure = code(error); else primary = safeError(error); }
      if ([...entries.values()].some(entry => !entry.closeObserved || entry.child.pid !== entry.pid)) primary ??= new WorkerRunError("P1C_SHUTDOWN_JOIN_UNKNOWN");
      primary ??= evidenceFailure;
      if (primary) throw primary;
      log(null, "group-joined"); if (evidenceFailure) throw evidenceFailure;
      return { joined: true, processes: entries.size };
    }).finally(() => { groupSettled = true; scope.dispose(); });
    return all;
  };
  return Object.freeze({ track, stopOne, stopAll, get closing() { return closing; }, records: () => [...entries.values()].map(entry => ({ pid: entry.pid, role: entry.role, requestId: entry.requestId, exitObserved: entry.exitObserved, closeObserved: entry.closeObserved, forceIssued: entry.forceIssued, failure: entry.failure })) });
}
export function reconcileWorkerClaims(active, slot, rows, { recovery = false, crashedJoined = false, leaseExpired = false } = {}) {
  requireWorker(rows.length <= 5 && new Set(rows.map(r => r.id)).size === rows.length, "P1C_CLAIM_DUPLICATE");
  for (const row of rows) {
    const prior = active.get(row.id);
    requireWorker(!prior || (recovery && prior.slot === "A" && slot === "B" && crashedJoined && leaseExpired && prior.lease !== row.lease), "P1C_CLAIM_DUPLICATE");
    active.set(row.id, { slot, lease: row.lease });
  }
}
function observedProcess(value, allowedHelpers) {
  const birth = typeof value?.birth === "string" && Number.isFinite(Date.parse(value.birth)) ? new Date(value.birth).toISOString() : null;
  const path = typeof value?.path === "string" && value.path ? resolve(value.path).toLowerCase() : null;
  return { pid: integer(value?.pid) ? value.pid : null, parentPid: Number.isInteger(value?.parent) && value.parent >= 0 ? value.parent : null,
    creationTime: birth, creationTimeAvailable: birth !== null, creationValueSha256: typeof value?.birth === "string" ? hash(value.birth) : null,
    executable: { category: path === resolve(process.execPath).toLowerCase() ? "QUALIFIED_NODE" : path && allowedHelpers.has(path) ? "FIXED_ALLOWED_HELPER" : path ? "OTHER" : "UNAVAILABLE", pathSha256: path ? hash(path) : null } };
}

export function reconcileWorkerTree(roots, snapshot, tracked = new Map(), allowedHelpers = new Set(), context = {}) {
  const phase = ["STARTUP", "PRE_INTERRUPT", "FINAL", "SHUTDOWN"].includes(context.phase) ? context.phase : "UNSPECIFIED";
  const observationId = randomUUID();
  const emit = (status, predicate, node, expected = null, error = null) => {
    const observation = { kind: "process-tree-observation", observationId, snapshotId: uuid(context.snapshotId) ? context.snapshotId : null,
      runCorrelationId: uuid(context.runId) ? context.runId : null, generation: uuid(context.generation) ? context.generation : null,
      observationPhase: phase, observationTimestamp: new Date().toISOString(), clockDomain: "WORKER_RUNTIME",
      snapshotStartedMonotonicMs: Number.isFinite(context.startedMs) ? context.startedMs : null, snapshotEndedMonotonicMs: Number.isFinite(context.endedMs) ? context.endedMs : null,
      status, failedPredicate: status === "REJECTED" ? predicate : null, rejectionReasonCode: status === "REJECTED" ? predicate : null,
      processRole: roots.some(root => root.pid === node?.pid) ? "KNOWN_OWNED_ROOT" : "OBSERVED_DESCENDANT",
      process: observedProcess(node, allowedHelpers), expected: expected ? observedProcess(expected, allowedHelpers) : null,
      allowedHelperPathSha256: [...allowedHelpers].map(path => hash(path)).sort(), expectedHelperArtifactSha256: /^[a-f0-9]{64}$/u.test(context.helperDigest ?? "") ? context.helperDigest : null };
    try { context.record?.(observation); }
    catch {
      if (error) error.secondaryDiagnosticFailure = "P1C_TREE_EVIDENCE_FAILED";
      else throw new WorkerRunError("P1C_TREE_EVIDENCE_FAILED");
    }
    if (error) { error.observationId = observationId; error.processObservation = observation; }
  };
  const check = (pass, code, predicate, node, expected = null) => {
    if (pass) return;
    const error = new WorkerRunError(code); emit("REJECTED", predicate, node, expected, error); throw error;
  };
  context.control?.beforeSpawn();
  check(Array.isArray(snapshot) && new Set(snapshot.map(p => p?.pid)).size === snapshot.length, "P1C_PROCESS_INVENTORY_INVALID", "INVENTORY_SHAPE_OR_DUPLICATE_PID", null);
  for (const [pid, old] of tracked) {
    const current = snapshot.find(p => p.pid === pid);
    check(!current || (current.birth === old.birth && current.path === old.path), "P1C_PROCESS_REPLACED", "TRACKED_INSTANCE_CHANGED", current, old);
    if (!current) emit("PREVIOUS_INSTANCE_ABSENT", null, old);
  }
  for (const root of roots) {
    const current = snapshot.find(p => p.pid === root.pid);
    if (!root.joined) check(current && typeof current.path === "string" && resolve(current.path).toLowerCase() === resolve(process.execPath).toLowerCase(), "P1C_PROCESS_IDENTITY_MISMATCH", "ROOT_MISSING_OR_EXECUTABLE_MISMATCH", current ?? { pid: root.pid });
    if (current && !root.joined) {
      if (root.birth) check(root.birth === current.birth, "P1C_PROCESS_REPLACED", "ROOT_CREATION_TIME_CHANGED", current, { pid: root.pid, parent: root.parentPid, birth: root.birth, path: process.execPath });
      check(Number.isFinite(Date.parse(current.birth)), "P1C_PROCESS_IDENTITY_MISMATCH", "ROOT_CREATION_TIME_UNVERIFIABLE", current);
      check(root.parentPid === undefined || current.parent === root.parentPid, "P1C_PROCESS_IDENTITY_MISMATCH", "ROOT_PARENT_MISMATCH", current, { pid: root.pid, parent: root.parentPid, path: process.execPath });
      if (root.spawnStartedAt !== undefined) check(Date.parse(current.birth) >= root.spawnStartedAt - 1000 && Date.parse(current.birth) <= root.spawnReturnedAt + 1000, "P1C_PROCESS_REPLACED", "ROOT_OUTSIDE_SPAWN_WINDOW", current);
      emit("KNOWN_OWNED_PROCESS", null, current);
      root.birth ??= current.birth; tracked.set(current.pid, current);
    } else if (root.joined) emit("ALREADY_EXITED_PROCESS", null, current ?? { pid: root.pid, parent: root.parentPid, birth: root.birth });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of snapshot) if (!tracked.has(p.pid) && tracked.has(p.parent)) {
      check(typeof p.birth === "string" && p.birth.length > 10, "P1C_UNKNOWN_DESCENDANT", "DESCENDANT_CREATION_TIME_MISSING", p);
      check(typeof p.path === "string", "P1C_UNKNOWN_DESCENDANT", "DESCENDANT_EXECUTABLE_UNAVAILABLE", p);
      check(allowedHelpers.has(resolve(p.path).toLowerCase()), "P1C_UNKNOWN_DESCENDANT", "DESCENDANT_EXECUTABLE_NOT_ALLOWED", p);
      const parent = snapshot.find(current => current.pid === p.parent), prior = tracked.get(p.parent);
      check(parent, "P1C_UNKNOWN_DESCENDANT", "DESCENDANT_PARENT_NOT_OBSERVED", p, prior);
      check(parent.birth === prior.birth && parent.path === prior.path, "P1C_UNKNOWN_DESCENDANT", "DESCENDANT_PARENT_INSTANCE_CHANGED", p, prior);
      check(Number.isFinite(Date.parse(p.birth)), "P1C_UNKNOWN_DESCENDANT", "DESCENDANT_CREATION_TIME_UNPARSABLE", p, parent);
      check(Date.parse(p.birth) >= Date.parse(parent.birth), "P1C_UNKNOWN_DESCENDANT", "DESCENDANT_PREDATES_PARENT", p, parent);
      emit("KNOWN_OWNED_DESCENDANT", null, p, parent);
      tracked.set(p.pid, p); changed = true;
    }
  }
  for (const [pid, old] of tracked) {
    const current = snapshot.find(p => p.pid === pid);
    check(!current || (current.birth === old.birth && current.path === old.path), "P1C_PROCESS_REPLACED", "TRACKED_INSTANCE_CHANGED", current, old);
  }
  return tracked;
}

// Fixed read-only command: no caller-supplied script, command or provider.
export const PROCESS_PROBE_SCRIPT = "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';$WarningPreference='Stop';$r=@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;birth=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{''};path=$_.ExecutablePath} });ConvertTo-Json -InputObject $r -Depth 3 -Compress";
export function workerProbeInvocation(environment, evidenceDirectory) {
  requireWorker(typeof environment.SystemRoot === "string" && isAbsolute(environment.SystemRoot) && isAbsolute(evidenceDirectory), "P1C_PROBE_ENVIRONMENT_INVALID");
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "PATH"]) {
    if (typeof environment[key] === "string") env[key] = environment[key];
  }
  const home = join(environment.SystemRoot, "System32/WindowsPowerShell/v1.0");
  env.PSModulePath = join(home, "Modules");
  env.PSModuleAnalysisCachePath = join(evidenceDirectory, "powershell-module-analysis.cache");
  for (const key of ["SystemRoot", "PATH", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]) requireWorker(typeof env[key] === "string" && env[key].length > 0, "P1C_PROBE_ENVIRONMENT_INVALID");
  return { executable: join(home, "powershell.exe"), args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PROCESS_PROBE_SCRIPT, "utf16le").toString("base64")], environment: env };
}
export async function runWorkerProcessProbe({ environment, evidenceDirectory, signal, onChild, timeoutMs = 5000, joinMs = 5000, stopOwned = null, record = value => { void value; } }, adapters = {}) {
  requireWorker(!signal.aborted, "P1C_PROCESS_PROBE_ABORTED");
  requireWorker(timeoutMs > 0 && timeoutMs <= WORKER_LIMITS.query && joinMs > 0 && joinMs <= WORKER_LIMITS.join && typeof onChild === "function", "P1C_PROBE_CONTROL_INVALID");
  const invocation = workerProbeInvocation(environment, evidenceDirectory);
  const started = performance.now(), bornAfter = Date.now(), deadline = started + timeoutMs;
  if (!adapters.executableHash) { const info = await lstat(invocation.executable); requireWorker(info.isFile() && !info.isSymbolicLink(), "P1C_PROBE_EXECUTABLE_INVALID"); }
  const executableHash = adapters.executableHash ?? hash(await readFile(invocation.executable, { signal }));
  requireWorker(!signal.aborted && performance.now() < deadline, "P1C_PROCESS_PROBE_TIMEOUT");
  const receipt = { kind: "process-probe", id: randomUUID(), startedAt: new Date(bornAfter).toISOString(), executableSha256: executableHash, scriptSha256: hash(PROCESS_PROBE_SCRIPT), environmentKeys: Object.keys(invocation.environment), pid: null, closeObserved: false, exitCode: null, stdoutBytes: 0, stderrBytes: 0, primaryFailure: null, abortFailure: null, joinFailure: null };
  return new Promise((resolveProbe, rejectProbe) => {
    let child, primary, settled = false, stopping = false, timer, joinTimer;
    const output = [], stderrHash = createHash("sha256");
    const emit = () => { try { record({ ...receipt }); } catch { receipt.diagnosticFailure = "P1C_PROBE_RECEIPT_FAILED"; primary ??= new WorkerRunError("P1C_PROBE_RECEIPT_FAILED"); } };
    const finish = () => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(joinTimer); signal.removeEventListener("abort", abort);
      receipt.elapsedMs = performance.now() - started;
      receipt.activeElapsedMs = receipt.abortRequestedMs ?? receipt.elapsedMs;
      receipt.abortJoinElapsedMs = receipt.abortRequestedMs === undefined ? 0 : receipt.elapsedMs - receipt.abortRequestedMs;
      receipt.stderrSha256 = stderrHash.digest("hex");
      let rows;
      if (!primary && receipt.elapsedMs >= timeoutMs) primary = new WorkerRunError("P1C_PROCESS_PROBE_TIMEOUT");
      if (!primary && receipt.exitCode !== 0) primary = new WorkerRunError("P1C_PROCESS_PROBE_EXIT_FAILED");
      if (!primary && receipt.stderrBytes !== 0) primary = new WorkerRunError("P1C_PROCESS_PROBE_STDERR");
      if (!primary) {
        try {
          rows = JSON.parse(Buffer.concat(output).toString("utf8").replace(/^\uFEFF/u, ""));
          requireWorker(Array.isArray(rows) && rows.length > 0 && rows.length <= 65536 && new Set(rows.map(p => p.pid)).size === rows.length, "P1C_PROCESS_INVENTORY_INVALID");
          requireWorker(rows.every(p => exact(p, ["pid", "parent", "birth", "path"]) && Number.isInteger(p.pid) && p.pid >= 0 && Number.isInteger(p.parent) && p.parent >= 0 && typeof p.birth === "string" && (p.path === null || typeof p.path === "string")), "P1C_PROCESS_INVENTORY_INVALID");
          const own = rows.find(p => p.pid === receipt.pid);
          requireWorker(own && own.parent === process.pid && typeof own.path === "string" && resolve(own.path).toLowerCase() === resolve(invocation.executable).toLowerCase()
            && Number.isFinite(Date.parse(own.birth)) && Date.parse(own.birth) >= bornAfter - 1000 && Date.parse(own.birth) <= Date.now() + 1000, "P1C_PROBE_IDENTITY_NOT_VERIFIED");
          receipt.identity = { pid: own.pid, parent: own.parent, birth: own.birth };
          receipt.rows = rows.length;
        } catch (error) { primary = error instanceof WorkerRunError ? error : new WorkerRunError("P1C_PROCESS_INVENTORY_INVALID"); }
      }
      receipt.primaryFailure = primary?.code ?? null; emit();
      if (primary) { primary.probe = { ...receipt }; if (receipt.joinFailure) primary.joinFailure = receipt.joinFailure; rejectProbe(primary); } else resolveProbe(rows);
    };
    const stop = error => {
      primary ??= error; if (stopping || settled) return;
      stopping = true; receipt.abortRequestedMs = performance.now() - started;
      joinTimer = setTimeout(() => { receipt.joinFailure = "P1C_PROBE_JOIN_UNKNOWN"; finish(); }, joinMs);
      if (child && integer(receipt.pid) && child.pid === receipt.pid) {
        try {
          if (stopOwned) Promise.resolve(stopOwned(child)).catch(() => { receipt.abortFailure = "P1C_PROBE_STOP_FAILED"; });
          else child.kill();
        } catch { receipt.abortFailure = "P1C_PROBE_STOP_FAILED"; }
      } else receipt.abortFailure = "P1C_PROBE_IDENTITY_UNKNOWN";
    };
    const abort = () => stop(new WorkerRunError("P1C_PROCESS_PROBE_ABORTED"));
    try {
      child = (adapters.spawn ?? spawn)(invocation.executable, invocation.args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: invocation.environment });
      receipt.pid = child.pid ?? null;
      child.once("close", code => { receipt.closeObserved = true; receipt.exitCode = code; finish(); });
      child.on("error", () => stop(new WorkerRunError("P1C_PROCESS_PROBE_SPAWN_FAILED")));
      child.stdout.on("data", b => {
        if (settled) return;
        receipt.stdoutBytes += b.length;
        if (receipt.stdoutBytes > 2 * 1024 * 1024) stop(new WorkerRunError("P1C_PROCESS_PROBE_OVERFLOW"));
        else output.push(Buffer.from(b));
      });
      child.stderr.on("data", b => { if (settled) return; receipt.stderrBytes += b.length; stderrHash.update(b); if (receipt.stderrBytes > 1024 * 1024) stop(new WorkerRunError("P1C_PROCESS_PROBE_OVERFLOW")); });
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => stop(new WorkerRunError("P1C_PROCESS_PROBE_TIMEOUT")), Math.max(1, deadline - performance.now()));
      onChild(child); // Listeners already exist if registration triggers abort/close.
      requireWorker(integer(receipt.pid), "P1C_PROBE_IDENTITY_UNKNOWN");
      if (signal.aborted) abort();
    } catch (error) {
      stop(error instanceof WorkerRunError ? error : new WorkerRunError("P1C_PROCESS_PROBE_SPAWN_FAILED"));
      if (!child) { clearTimeout(joinTimer); finish(); }
    }
  });
}

export async function runWorkerRuntime(options, adapters = {}) {
  const { environment, generation, runId, expectedIdentity, onChild, evidenceDirectory, record = () => {}, onAbort = () => {} } = options;
  requireWorker(options.requireOwnership === true && typeof options.ownershipGuard === "function" && typeof onChild === "function" && typeof onAbort === "function", "P1C_OWNERSHIP_REQUIRED");
  requireWorker(uuid(runId) && uuid(generation) && options.timeoutMs > 0 && options.timeoutMs <= WORKER_LIMITS.role, "P1C_ROLE_BUDGET");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const linux = options.linuxGroup;
  requireWorker(!linux || linuxGroups.has(linux), "LINUX_GROUP_CAPABILITY_REQUIRED");
  const now = adapters.now ?? (() => performance.now()), started = now(), controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  const receipt = { runId, generation, workers: [], events: [], scenarios: {}, processQuiescence: "NOT_RUN", sqlQuiescence: "DELEGATED_TO_P1_A" };
  const emit = value => { const e = { ...value, sequence: receipt.events.length + 1, monotonicMs: now() - started, clockDomain: "WORKER_RUNTIME", runCorrelationId: runId, generation }; receipt.events.push(e); record(e); };
  let primary, monitor, locker, phase = "park", lockGate = false, firstClaimsReleased = false, expectedCrash = false, crashExpiry = Infinity;
  const states = [], allowed = new Set(), batch = new Map(), beforeClaim = new Map(), held = new Map(), active = new Map(), tracked = new Map();
  const created = new Set(), claims = [], fixtureResults = [], receiptEvents = [], clients = new Set(), helperPaths = new Set();
  const helperFile = join(root, "node_modules/@esbuild/win32-x64/esbuild.exe"); let helperDigest, lastObservation;
  const treeObservations = []; let treeQualified = false;
  const abort = error => {
    primary ??= error instanceof Error && /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.code ?? "") ? error : new WorkerRunError("P1C_RUNTIME_FAILED");
    if (!controller.signal.aborted) {
      controller.abort(primary);
      try { onAbort(primary); } catch { primary.secondaryDiagnosticFailure = "P1C_ABORT_NOTIFICATION_FAILED"; }
      shutdown.stopAll().catch(failure => { receipt.shutdownFailure = failure.code ?? "P1C_SHUTDOWN_FAILED"; });
    }
  };
  const shutdown = linux ?? createWorkerShutdown({ runId, generation, record: emit, now, onFailure: abort, afterJoin: reconcileAfterShutdown });
  options.onShutdownReady?.(shutdown.stopAll);
  const assert = () => { if (signal.aborted) throw primary ?? new WorkerRunError("P1C_ABORTED"); requireWorker(!shutdown.closing, "P1C_DISPATCH_AFTER_SHUTDOWN"); requireWorker(now() - started < options.timeoutMs, "P1C_ROLE_TIMEOUT"); };
  const timer = setTimeout(() => abort(new WorkerRunError("P1C_ROLE_TIMEOUT")), options.timeoutMs);
  const abortListener = () => { if (!primary) abort(new WorkerRunError(linux && /^[A-Z][A-Z0-9_]{2,79}$/u.test(signal.reason?.code ?? "") ? signal.reason.code : "P1C_ABORTED")); };
  signal.addEventListener("abort", abortListener, { once: true });
  const guard = serialWorkerGuard({ ownershipGuard: options.ownershipGuard, environment, generation, signal, onAbort: abort, now });
  const reply = (state, request) => { assert(); state.peer.send("REPLY", { id: request.id }); };
  const wait = async (predicate, ms, code) => {
    const deadline = Math.min(started + options.timeoutMs, now() + ms);
    while (true) { assert(); const value = await predicate(); assert(); if (value) return value;
      requireWorker(now() < deadline, code);
      await new Promise(resolveWait => setTimeout(resolveWait, Math.min(50, Math.max(1, deadline - now()))));
    }
  };
  async function snapshot(control = null) {
    if (linux) return linux.snapshot();
    if (control) control.beforeSpawn(); else assert();
    const observation = { snapshotId: randomUUID(), startedMs: now() - started, endedMs: null };
    const remaining = control ? control.effectiveTimeout() : Math.min(10_000, started + options.timeoutMs - now());
    requireWorker(remaining >= 2, "P1C_PROCESS_PROBE_TIMEOUT");
    let rows;
    if (adapters.snapshot) rows = await adapters.snapshot();
    else {
      requireWorker(process.platform === "win32", "P1C_PLATFORM_NOT_QUALIFIED");
      rows = await runWorkerProcessProbe({ environment, evidenceDirectory, signal: control?.signal ?? signal,
        timeoutMs: Math.min(5000, Math.floor(remaining / 2)), joinMs: Math.min(5000, Math.floor(remaining / 2)),
        onChild: child => { shutdown.track(child, { role: "PROCESS_PROBE", reconciliationControl: control }); onChild(child, { shutdown: shutdown.stopAll, processRole: "P1C_PROCESS_PROBE" }); },
        stopOwned: child => shutdown.stopOne(child, { force: true, control }), record: emit });
    }
    if (control) control.beforeSpawn(); else assert();
    observation.endedMs = now() - started; lastObservation = observation; return rows;
  }
  function classifyTree(rows, phase, control = null) {
    if (linux) { const result = linux.classify(rows); treeQualified = true; emit({ event: "linux-process-census", phase, slots: result.map(value => ({ slot: value.slot, count: value.rows.length })) }); return result; }
    const result = reconcileWorkerTree(states, rows, tracked, helperPaths, { ...lastObservation, phase, control, runId, generation, helperDigest,
      record: observation => { requireWorker(treeObservations.length < 512, "P1C_TREE_EVIDENCE_LIMIT"); treeObservations.push(observation); emit(observation); } });
    if (phase === "STARTUP") treeQualified = true;
    return result;
  }
  async function reconcileAfterShutdown(control) {
    if (linux) { await linux.reconcileJoined(); receipt.ownedProcessAbsence = "APPLICATION_CHILD_ABSENCE_VERIFIED_SUPERVISORS_RETAINED"; return; }
    if (!states.length) return;
    requireWorker(states.every(state => state.joined), "P1C_SHUTDOWN_JOIN_UNKNOWN");
    const rows = await snapshot(control); classifyTree(rows, "SHUTDOWN", control);
    requireWorker(treeQualified, "P1C_TREE_NEVER_QUALIFIED");
    requireWorker(!treeObservations.some(observation => observation.status === "REJECTED"), "P1C_TREE_RECONCILIATION_UNVERIFIED");
    requireWorker([...tracked.values()].every(p => !rows.some(current => current.pid === p.pid && current.birth === p.birth)), "P1C_RESIDUAL_PROCESS");
    control.beforeSpawn(); requireWorker(hash(await readFile(helperFile, { signal: control.signal })) === helperDigest, "P1C_HELPER_CHANGED"); control.beforeSpawn();
    receipt.ownedProcessAbsence = "PASS_VERIFIED";
  }
  async function stopTree(state) {
    if (state.joined) return;
    if (linux) { await linux.interrupt(state.child, () => state.peer.send("INTERRUPT")); await joinWorker(state); return; }
    requireWorker(integer(state.pid), "P1C_PROCESS_IDENTITY_UNKNOWN");
    await shutdown.stopOne(state.child, { force: true });
    await joinWorker(state);
  }
  const openClient = async readonly => {
    assert();
    const client = adapters.client ? adapters.client() : new Client({ connectionString: environment.DATABASE_URL, application_name: "m13-p1c-monitor-" + runId.slice(0, 8), connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
    clients.add(client);
    client.on("error", () => abort(new WorkerRunError("P1C_SQL_CLIENT_FAILED")));
    await client.connect();
    if (readonly) await client.query("SET default_transaction_read_only=on");
    return client;
  };
  const closeClient = async client => {
    let timeout;
    try {
      await Promise.race([client.end(), new Promise((_, reject) => { timeout = setTimeout(() => { client.connection?.stream?.destroy(); reject(new WorkerRunError("P1C_SQL_JOIN_UNKNOWN")); }, 5000); })]);
      clients.delete(client);
    } finally { clearTimeout(timeout); }
  };
  const sql = async (text, values = []) => { assert(); const result = await monitor.query(text, values); assert(); requireWorker(Array.isArray(result.rows) && result.rowCount === result.rows.length, "P1C_SQL_INCOMPLETE"); return result.rows; };
  const rowsFor = ids => sql(`SELECT o.id,o.status,o.channel,o.attempt_count,o.claimed_at,o.lease_expires_at,o.available_at,o.terminal_failure_code,
    r.provider_reference,r.payload_hash,r.provider_kind,
    COALESCE((SELECT json_agg(json_build_object('number',a.attempt_number,'outcome',a.outcome,'failure',a.failure_code,'deduplicated',a.deduplicated,'startedAt',a.started_at,'completedAt',a.completed_at) ORDER BY a.attempt_number) FROM notification_attempts a WHERE a.outbox_id=o.id),'[]') AS attempts,
    (SELECT count(*)::int FROM notification_simulation_receipts x WHERE x.outbox_id=o.id) AS receipts
    FROM notification_outbox o LEFT JOIN notification_simulation_receipts r ON r.outbox_id=o.id WHERE o.id=ANY($1::uuid[]) ORDER BY o.id`, [ids]);
  async function releaseBatch(state, request) {
    try { await guard("worker:batch:" + state.slot); assert(); if (phase === "park" || !allowed.has(state.slot)) { batch.set(state.slot, request); return; } reply(state, request); }
    catch (error) { abort(error); }
  }
  function releasePending() {
    for (const state of states) {
      const request = batch.get(state.slot);
      if (request && allowed.has(state.slot) && phase !== "park") { batch.delete(state.slot); void releaseBatch(state, request); }
    }
  }
  const setPhase = (value, slots = ["A", "B"]) => { phase = value; allowed.clear(); slots.forEach(s => allowed.add(s)); emit({ event: "phase", phase }); releasePending(); };
  async function handle(state, packet) {
    const d = packet.data;
    // These correlated acknowledgements reconcile an already-owned shutdown;
    // they never grant work or restore the lease after abort.
    if (packet.type === "STOPPED") { requireWorker(state.stopping && !state.stopped, "P1C_CHILD_STATE"); state.stopped = true; emit({ event: "consumer-stopped", slot: state.slot, databaseClosed: true }); return; }
    if (packet.type === "EVENT" && d.event === "abort-observed") { requireWorker(state.stopping && !state.aborted, "P1C_UNEXPECTED_ABORT"); state.aborted = true; emit({ event: "abort-observed", slot: state.slot }); return; }
    assert();
    if (packet.type === "HELLO") {
      requireWorker(!state.hello && (linux ? linux.hello(state.slot, d) : d.pid === state.pid && d.node === process.versions.node && resolve(d.execPath).toLowerCase() === resolve(process.execPath).toLowerCase()), "P1C_CHILD_IDENTITY_MISMATCH");
      state.hello = true; return;
    }
    if (packet.type === "READY") { requireWorker(state.hello && !state.ready, "P1C_CHILD_STATE"); assertWorkerIdentity(linux ? linux.target(state.slot).identity : expectedIdentity, d.identity); state.ready = true; emit({ event: "consumer-ready", slot: state.slot, pid: state.pid }); return; }
    if (packet.type === "ERROR") throw new WorkerRunError("P1C_CONSUMER_FAILED");
    if (packet.type === "FIXTURE_DONE") { requireWorker(state.slot === "A" && state.fixtureExpected === d.scenario, "P1C_FIXTURE_STATE"); state.fixtureExpected = null; fixtureResults.push(d); d.ids.forEach(id => { requireWorker(!created.has(id), "P1C_DUPLICATE_FIXTURE"); created.add(id); }); return; }
    if (packet.type === "CONFIGURED") { requireWorker(state.configExpected === d.scenario, "P1C_CHILD_STATE"); state.configured = d.scenario; state.configExpected = null; return; }
    if (packet.type === "EVENT") {
      if (d.event === "runtime-failure") throw new WorkerRunError("P1C_WORKER_RUNTIME_FAILURE");
      requireWorker(!state.aborted || d.event === "abort-observed", "P1C_DISPATCH_AFTER_ABORT");
      if (d.event === "finalized") active.delete(d.id);
      if (d.event === "receipt-observed") receiptEvents.push({ slot: state.slot, ...d });
      emit({ slot: state.slot, ...d }); return;
    }
    requireWorker(packet.type === "REQUEST" && state.ready && !state.stopping && d.id > state.lastRequest, "P1C_CHILD_STATE");
    state.lastRequest = d.id;
    if (d.point === "batch") {
      requireWorker(!batch.has(state.slot), "P1C_DUPLICATE_REQUEST");
      if (phase === "park" || !allowed.has(state.slot)) batch.set(state.slot, d);
      else await releaseBatch(state, d);
      return;
    }
    if (d.point === "claim") { if (lockGate) beforeClaim.set(state.slot, d); else reply(state, d); return; }
    if (d.point === "receipt") { requireWorker(phase === "crash" && state.slot === "A" && created.has(d.outboxId), "P1C_CRASH_BARRIER_INVALID"); state.receiptBarrier = d; emit({ event: "receipt-barrier", slot: state.slot, id: d.outboxId }); return; }
    reconcileWorkerClaims(active, state.slot, d.rows, { recovery: phase === "crash", crashedJoined: states[0].joined && expectedCrash, leaseExpired: Date.now() >= crashExpiry });
    d.rows.forEach(row => { requireWorker(created.has(row.id), "P1C_UNOWNED_JOB"); claims.push({ slot: state.slot, ...row, monotonicMs: now() - started }); });
    emit({ event: "claim", slot: state.slot, count: d.rows.length, rows: d.rows });
    if (phase === "concurrent" && !firstClaimsReleased && d.rows.length) {
      held.set(state.slot, d);
      if (held.size === 2) { firstClaimsReleased = true; for (const s of states) reply(s, held.get(s.slot)); held.clear(); }
    } else reply(state, d);
  }
  async function launch(slot) {
    if (linux) return launchLinux(slot);
    await guard("worker:start:" + slot); assert();
    const cwd = await mkdtemp(join(evidenceDirectory, "consumer-" + slot + "-"));
    assert();
    const nonce = randomUUID(), childEnv = {};
    for (const key of ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "PATH"]) if (environment[key]) childEnv[key] = environment[key];
    Object.assign(childEnv, { DATABASE_URL: environment.DATABASE_URL, APP_ENV: "development", NODE_ENV: "test", P1C_RUN_ID: runId, P1C_GENERATION: generation, P1C_SLOT: slot, P1C_NONCE: nonce,
      PGAPPNAME: "m13-p1c-" + runId.replaceAll("-", "").slice(0, 12) + "-" + slot, TSX_TSCONFIG_PATH: join(root, "tsconfig.json") });
    const preload = import.meta.resolve("tsx"), entry = join(root, "scripts/m13-p1-worker-consumer.ts");
    for (const file of [fileURLToPath(preload), entry, childEnv.TSX_TSCONFIG_PATH]) {
      const info = await lstat(file); assert();
      requireWorker(info.isFile(), "P1C_ARTIFACT_NOT_REGULAR");
      const linkInfo = await lstat(file); assert();
      requireWorker(!linkInfo.isSymbolicLink(), "P1C_ARTIFACT_NOT_REGULAR");
    }
    const spawnStartedAt = Date.now();
    assert(); // No await may separate current authority from the actual spawn.
    const child = (adapters.spawn ?? spawn)(process.execPath, ["--conditions=react-server", "--import", preload, entry], { cwd, env: childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const state = { child, slot, pid: child.pid, parentPid: process.pid, spawnStartedAt, spawnReturnedAt: Date.now(), ready: false, hello: false, joined: false, stopping: false, stopped: false, aborted: false, lastRequest: 0, appname: childEnv.PGAPPNAME };
    states.push(state);
    state.closed = new Promise(resolveClose => child.once("close", (code, sig) => {
      state.joined = true; state.exitCode = code; state.exitSignal = sig;
      emit({ event: "consumer-close", slot, pid: state.pid, code, signal: sig });
      if (!state.stopping && !(slot === "A" && expectedCrash)) abort(new WorkerRunError("P1C_UNEXPECTED_CHILD_EXIT"));
      resolveClose();
    }));
    state.peer = createWorkerPeer({ runId, generation, slot, nonce }, value => { requireWorker(child.connected, "P1C_IPC_DISCONNECTED"); child.send(value, error => { if (error && !state.stopping) abort(new WorkerRunError("P1C_IPC_SEND_FAILED")); }); });
    child.on("message", value => { try { const packet = state.peer.receive(value); void handle(state, packet).catch(abort); } catch (error) { abort(error); } });
    child.on("error", () => abort(new WorkerRunError("P1C_SPAWN_FAILED")));
    child.on("disconnect", () => { if (!state.stopping && !(slot === "A" && expectedCrash)) abort(new WorkerRunError("P1C_IPC_DISCONNECTED")); });
    for (const pipe of [child.stdout, child.stderr]) pipe.on("data", () => abort(new WorkerRunError("P1C_UNEXPECTED_PROCESS_OUTPUT")));
    shutdown.track(child, { role: "CONSUMER_" + slot, spawnStartedAt, spawnReturnedAt: state.spawnReturnedAt,
      graceful: () => { state.stopping = true; if (child.connected) state.peer.send("STOP"); else requireWorker(state.joined, "P1C_IPC_DISCONNECTED"); } });
    onChild(child, { shutdown: shutdown.stopAll, processRole: "P1C_CONSUMER_" + slot });
    requireWorker(integer(child.pid), "P1C_SPAWN_FAILED");
    assert();
    await wait(() => state.hello, 15_000, "P1C_HELLO_TIMEOUT");
    state.peer.send("INIT", { identity: expectedIdentity });
    await wait(() => state.ready, 15_000, "P1C_READY_TIMEOUT");
    receipt.workers.push({ slot, pid: state.pid, appname: state.appname, runtime: process.versions.node });
    return state;
  }
  async function launchLinux(slot) {
    await guard("worker:start:" + slot); assert();
    const target = linux.target(slot), nonce = randomUUID(), url = new URL(environment.DATABASE_URL);
    url.hostname = target.serverAddress; url.port = "5432";
    const childEnvironment = { DATABASE_URL: url.href, APP_ENV: "development", NODE_ENV: "test",
      PGAPPNAME: "m13-p1c-" + runId.replaceAll("-", "").slice(0, 12) + "-" + slot };
    assert();
    const child = await linux.launch(slot, { nonce, environment: childEnvironment, target });
    const state = { child, slot, pid: child.pid, parentPid: null, spawnStartedAt: null, spawnReturnedAt: null, ready: false, hello: false, joined: false, stopping: false, stopped: false, aborted: false, lastRequest: 0, appname: childEnvironment.PGAPPNAME };
    states.push(state);
    state.closed = new Promise(done => child.once("close", code => {
      state.joined = true; state.exitCode = code; state.exitSignal = null;
      emit({ event: "consumer-close", slot, pid: state.pid, code, signal: null, platform: "LINUX_CONTAINER" });
      if (!state.stopping && !(slot === "A" && expectedCrash)) abort(new WorkerRunError("P1C_UNEXPECTED_CHILD_EXIT")); done();
    }));
    state.peer = createWorkerPeer({ runId, generation, slot, nonce }, value => child.send(value));
    child.on("message", value => { try { const packet = state.peer.receive(value); void handle(state, packet).catch(abort); } catch (error) { abort(error); } });
    shutdown.track(child, { graceful: () => { state.stopping = true; if (child.connected) state.peer.send("STOP"); } });
    onChild(child, { processRole: "LINUX_CONSUMER_" + slot });
    child.activate(); assert();
    await wait(() => state.hello, 15000, "P1C_HELLO_TIMEOUT");
    state.peer.send("INIT", { identity: target.identity });
    await wait(() => state.ready, 15000, "P1C_READY_TIMEOUT");
    receipt.workers.push({ slot, pid: state.pid, containerId: target.containerId, appname: state.appname, runtime: "24.14.1", platform: "LINUX_CONTAINER" }); return state;
  }
  async function fixture(scenario) {
    setPhase("park");
    if (states[0].started) await wait(() => states.filter(s => !s.joined).every(s => batch.has(s.slot)), 60_000, "P1C_BATCH_DRAIN_TIMEOUT");
    await guard("worker:fixture");
    const a = states[0]; a.fixtureExpected = scenario; a.peer.send("FIXTURE", { scenario });
    const result = await wait(() => fixtureResults.find(f => f.scenario === scenario), 15_000, "P1C_FIXTURE_TIMEOUT");
    for (const s of states) { s.configured = null; s.configExpected = scenario; s.peer.send("CONFIGURE", { scenario, ids: result.ids }); }
    await wait(() => states.every(s => s.configured === scenario), 5000, "P1C_CONFIGURATION_TIMEOUT");
    emit({ event: "fixture", scenario, count: result.ids.length, ids: result.ids }); return result.ids;
  }
  async function terminal(ids, milliseconds = 60_000) {
    return wait(async () => { const rows = await rowsFor(ids); return rows.length === ids.length && rows.every(r => ["SUCCEEDED", "DEAD"].includes(r.status)) ? rows : null; }, milliseconds, "P1C_DELIVERY_TIMEOUT");
  }
  async function lockClaims(ids, rowOnly) {
    await guard("worker:locking");
    locker = await openClient(false);
    await locker.query("BEGIN");
    let lockTimer, primaryLock;
    try {
      if (rowOnly) await locker.query("SELECT id FROM notification_outbox WHERE id=$1::uuid FOR UPDATE", [ids[0]]);
      else await locker.query("LOCK TABLE notification_outbox IN ACCESS EXCLUSIVE MODE");
      lockTimer = setTimeout(() => abort(new WorkerRunError("P1C_LOCK_TIMEOUT")), 5000);
      lockGate = false; for (const s of states) { const req = beforeClaim.get(s.slot); requireWorker(req, "P1C_LOCK_BARRIER_MISSING"); reply(s, req); } beforeClaim.clear();
      if (rowOnly) {
        await wait(async () => { const rows = await rowsFor(ids.slice(1)); return rows.every(r => r.status === "SUCCEEDED"); }, 4500, "P1C_ROW_SKIP_TIMEOUT");
        const [row] = await rowsFor([ids[0]]); requireWorker(row.status === "PENDING" && row.attempt_count === 0 && row.receipts === 0, "P1C_ROW_LOCK_BYPASSED");
        emit({ event: "row-lock-proof", lockedLegUnchanged: true, otherLegsCompleted: ids.length - 1 });
      } else {
        const rows = await wait(async () => {
          const rows = await sql("SELECT a.pid,a.application_name,a.state,a.wait_event_type FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.datname=current_database() AND a.usename=current_user AND a.application_name=ANY($1::text[]) AND l.relation='notification_outbox'::regclass AND NOT l.granted AND a.wait_event_type='Lock'", [states.map(s => s.appname)]);
          return new Set(rows.map(r => r.application_name)).size === 2 ? rows : null;
        }, 4500, "P1C_CONCURRENT_LOCK_NOT_OBSERVED");
        emit({ event: "concurrent-lock-proof", backendPids: [...new Set(rows.map(r => r.pid))], consumers: 2 }); receipt.scenarios.C04 = "PASS_VERIFIED";
      }
    } catch (error) { primaryLock = error; throw error; }
    finally {
      clearTimeout(lockTimer);
      try { await locker.query("ROLLBACK"); }
      catch { if (!primaryLock) throw new WorkerRunError("P1C_LOCK_ROLLBACK_FAILED"); receipt.lockCleanupFailure = "P1C_LOCK_ROLLBACK_FAILED"; }
      finally {
        try { await closeClient(locker); }
        catch (error) { if (!primaryLock) throw error; receipt.lockCleanupFailure = "P1C_SQL_JOIN_UNKNOWN"; }
        finally { locker = null; }
      }
    }
  }

  try {
    for (const name of await readdir(root)) requireWorker(!name.startsWith(".env") || name === ".env.example", "P1C_LOCAL_ENV_REJECTED");
    await mkdir(evidenceDirectory, { recursive: true });
    await guard("worker:assert"); monitor = await openClient(true);
    const ledger = await sql("SELECT migration_name,finished_at,rolled_back_at,logs FROM _prisma_migrations");
    requireWorker(inspectMigrationLedger(ledger, EXPECTED_STAGING_MIGRATION_NAMES).ready, "P1C_MIGRATION_LEDGER_INVALID");
    const [initial] = await sql("SELECT (SELECT count(*)::int FROM notification_outbox) AS outbox,(SELECT count(*)::int FROM notification_attempts) AS attempts,(SELECT count(*)::int FROM notification_simulation_receipts) AS receipts");
    requireWorker(initial.outbox === 0 && initial.attempts === 0 && initial.receipts === 0, "P1C_DATABASE_NOT_EMPTY");
    if (!linux) {
      const helperInfo = await lstat(helperFile); requireWorker(helperInfo.isFile() && !helperInfo.isSymbolicLink(), "P1C_HELPER_NOT_REGULAR");
      helperDigest = hash(await readFile(helperFile)); helperPaths.add(resolve(helperFile).toLowerCase());
      emit({ event: "loader-identity", helperSha256: helperDigest, loaderSha256: hash(await readFile(fileURLToPath(import.meta.resolve("tsx")))), tsconfigSha256: hash(await readFile(join(root, "tsconfig.json"))) });
    }
    await launch("A"); await launch("B");
    classifyTree(await snapshot(), "STARTUP");
    const ids = await fixture("concurrent");
    for (const s of states) { s.started = true; s.peer.send("START"); }
    lockGate = true; setPhase("concurrent");
    await wait(() => beforeClaim.size === 2, 60_000, "P1C_CLAIM_BARRIER_TIMEOUT");
    await lockClaims(ids, false);
    const completed = await terminal(ids);
    requireWorker(firstClaimsReleased && new Set(claims.filter(c => ids.includes(c.id)).map(c => c.slot)).size === 2, "P1C_CONCURRENCY_NOT_PROVEN");
    requireWorker(completed.every(r => r.status === "SUCCEEDED" && r.attempt_count === 1 && r.receipts === 1), "P1C_DUPLICATE_DELIVERY");
    receipt.scenarios.C01 = receipt.scenarios.C02 = "PASS_VERIFIED";
    const lockedIds = await fixture("row-lock"); lockGate = true; setPhase("row-lock");
    await wait(() => beforeClaim.size === 2, 60_000, "P1C_CLAIM_BARRIER_TIMEOUT");
    await lockClaims(lockedIds, true); await terminal(lockedIds);

    const retryIds = await fixture("retry"); setPhase("retry", ["A"]);
    const firstRetry = await wait(async () => {
      const rows = await rowsFor(retryIds); return rows.some(r => r.status === "PENDING" && r.attempt_count === 1) && rows.some(r => r.status === "DEAD") ? rows : null;
    }, 60_000, "P1C_RETRY_NOT_OBSERVED");
    const transient = firstRetry.find(r => r.status === "PENDING"), permanent = firstRetry.find(r => r.status === "DEAD");
    requireWorker(new Date(transient.available_at).getTime() - new Date(transient.attempts[0].completedAt).getTime() === 60_000 && permanent.attempt_count === 1 && permanent.receipts === 0, "P1C_RETRY_POLICY_CHANGED");
    setPhase("park"); await wait(() => batch.has("A"), 60_000, "P1C_BATCH_DRAIN_TIMEOUT");
    setPhase("retry", ["B"]);
    const retried = await terminal(retryIds, 90_000);
    const success = retried.find(r => r.id === transient.id);
    requireWorker(success.status === "SUCCEEDED" && success.attempt_count === 2 && success.receipts === 1 && success.attempts[1].deduplicated === true
      && new Date(success.attempts[1].startedAt).getTime() >= new Date(transient.available_at).getTime(), "P1C_RETRY_POLICY_CHANGED");
    emit({ event: "retry-proof", delayMs: 60_000, attempts: 2, receiptCount: 1, permanentAttempts: 1 }); receipt.scenarios.C07 = "PASS_VERIFIED";

    const crashIds = await fixture("crash"); setPhase("crash", ["A"]);
    await wait(() => states[0].receiptBarrier, 60_000, "P1C_RECEIPT_BARRIER_TIMEOUT");
    const [beforeCrash] = await rowsFor(crashIds);
    requireWorker(beforeCrash.status === "CLAIMED" && beforeCrash.receipts === 1 && beforeCrash.attempts.length === 1 && beforeCrash.attempts[0].outcome === null, "P1C_CRASH_PRECONDITION");
    crashExpiry = new Date(beforeCrash.lease_expires_at).getTime();
    requireWorker(crashExpiry - new Date(beforeCrash.claimed_at).getTime() === 120_000, "P1C_LEASE_POLICY_CHANGED");
    classifyTree(await snapshot(), "PRE_INTERRUPT");
    expectedCrash = true; emit({ event: "intentional-crash-armed", slot: "A", pid: states[0].pid });
    await stopTree(states[0]); setPhase("crash", ["B"]); await guard("worker:recovery");
    const recovered = await terminal(crashIds, 150_000), replay = recovered[0];
    requireWorker(replay.status === "SUCCEEDED" && replay.attempt_count === 2 && replay.receipts === 1 && replay.provider_reference === beforeCrash.provider_reference
      && replay.attempts[0].outcome === "ABANDONED" && replay.attempts[0].failure === "WORKER_INTERRUPTED" && replay.attempts[1].outcome === "SUCCESS" && replay.attempts[1].deduplicated === true
      && new Date(replay.attempts[1].startedAt).getTime() >= crashExpiry, "P1C_LEASE_REPLAY_FAILED");
    receipt.scenarios.C05 = receipt.scenarios.C06 = "PASS_VERIFIED";
    emit({ event: "lease-replay-proof", leaseMs: 120_000, attempts: 2, receipts: 1, outcomes: ["ABANDONED", "SUCCESS"], deduplicated: true });
    setPhase("park"); await wait(() => batch.has("B"), 60_000, "P1C_BATCH_DRAIN_TIMEOUT");
    await guard("worker:assert");
    const finalRows = await rowsFor([...created]);
    requireWorker(finalRows.length === created.size && finalRows.every(r => r.status === "DEAD" ? r.receipts === 0 : r.status === "SUCCEEDED" && r.receipts === 1
      && ["SIMULATED_WHATSAPP", "SIMULATED_EMAIL"].includes(r.provider_kind)
      && receiptEvents.some(e => e.id === r.id && e.reference === r.provider_reference && e.payloadHash === r.payload_hash)), "P1C_RECEIPT_INTEGRITY");
    const [totals] = await sql("SELECT (SELECT count(*)::int FROM notification_outbox) AS outbox,(SELECT count(*)::int FROM notification_attempts) AS attempts,(SELECT count(*)::int FROM notification_simulation_receipts) AS receipts");
    requireWorker(totals.outbox === created.size && totals.attempts === finalRows.reduce((n,r) => n+r.attempt_count,0) && totals.receipts === finalRows.filter(r => r.status === "SUCCEEDED").length, "P1C_UNEXPECTED_DATABASE_ROWS");
    receipt.scenarios.C03 = "PASS_VERIFIED"; receipt.persistedResults = finalRows;
    await shutdown.stopAll();
    if (linux) { await linux.reconcileJoined(); receipt.ownedProcessAbsence = "APPLICATION_CHILD_ABSENCE_VERIFIED_SUPERVISORS_RETAINED"; }
    if (signal.aborted) throw primary ?? new WorkerRunError("P1C_ABORTED");
    requireWorker(now() - started < options.timeoutMs, "P1C_ROLE_TIMEOUT");
    for (const s of states.filter(s => !(s.slot === "A" && expectedCrash))) requireWorker(s.stopped && s.aborted && s.exitCode === 0, "P1C_GRACEFUL_SHUTDOWN_FAILED");
    receipt.scenarios.C08 = receipt.scenarios.C09 = receipt.scenarios.C10 = "PASS_VERIFIED"; receipt.processQuiescence = "PASS_VERIFIED";
    if (linux) { receipt.scenarios.C10 = "NOT_VERIFIABLE"; receipt.processQuiescence = "APPLICATION_JOIN_VERIFIED_OS_RELEASE_PENDING"; }
    emit({ event: "owned-process-quiescence", rootsJoined: 2, residuals: 0 });
  } catch (error) { abort(error); }
  finally {
    clearTimeout(timer); signal.removeEventListener("abort", abortListener);
    try { await guard.drain(); } catch { primary ??= new WorkerRunError("P1C_GUARD_JOIN_UNKNOWN"); receipt.joinFailure = "P1C_GUARD_JOIN_UNKNOWN"; }
    try { await shutdown.stopAll(); }
    catch (error) { primary ??= error; receipt.shutdownFailure = error.code ?? "P1C_SHUTDOWN_FAILED"; receipt.reconciliationFailure = error.reconciliationFailure ?? null; }
    for (const client of clients) { try { await closeClient(client); } catch { primary ??= new WorkerRunError("P1C_SQL_JOIN_UNKNOWN"); receipt.sqlJoinFailure = "P1C_SQL_JOIN_UNKNOWN"; } }
    receipt.elapsedMs = now() - started;
    receipt.primaryFailure = primary?.code ?? null;
    receipt.processes = states.map(s => ({ slot: s.slot, pid: s.pid, parentPid: s.parentPid, birth: s.birth ?? null, spawnStartedAt: s.spawnStartedAt, spawnReturnedAt: s.spawnReturnedAt, joined: s.joined, stopped: s.stopped, aborted: s.aborted, exitCode: s.exitCode ?? null, intentionalCrash: s.slot === "A" && expectedCrash }));
    receipt.processTree = [...tracked.values()].map(p => ({ pid: p.pid, parent: p.parent, birth: p.birth, executablePathSha256: hash(p.path) }));
    receipt.treeObservations = treeObservations; receipt.shutdownProcesses = shutdown.records();
    if (primary) receipt.processQuiescence = states.every(s => s.joined) ? "ROOTS_JOINED_HELPERS_NOT_VERIFIED" : "NOT_VERIFIED";
    try { await writeFile(join(evidenceDirectory, "worker-runtime.json"), JSON.stringify(receipt, null, 2) + "\n"); }
    catch { if (primary) primary.secondaryDiagnosticFailure = "P1C_RECEIPT_WRITE_FAILED"; else primary = new WorkerRunError("P1C_RECEIPT_WRITE_FAILED"); }
  }
  if (primary) {
    if (receipt.shutdownFailure) primary.shutdownFailure = receipt.shutdownFailure;
    if (receipt.reconciliationFailure) primary.reconciliationFailure = receipt.reconciliationFailure;
    throw primary;
  }
  return { exitCode: 0, reason: null, executable: process.execPath, workerReceipt: receipt };
}

const linuxGroups = new WeakSet();
// The remote child is deliberately not registered as a host ChildProcess.
// Only an authenticated supervisor JOIN receipt can close this logical handle.
export function createLinuxWorkerGroup({ engine, workers, image, runId, generation, controllerNamespaces, timeoutMs = 600000, onFailure = error => { void error; } }) {
  requireWorker(workers?.length === 2 && workers.map(value => value.slot).sort().join() === "A,B" && workers.every(value => value.dnsProof)
    && image?.profile && timeoutMs > 0 && timeoutMs <= 600000, "LINUX_GROUP_CONFIGURATION");
  requireWorker(controllerNamespaces && ["pidns", "netns", "mntns"].every(key => typeof controllerNamespaces[key] === "string" && /^[a-z]+:\[[0-9]+\]$/u.test(controllerNamespaces[key]))
    && uuid(controllerNamespaces.bootId), "LINUX_CONTROLLER_NAMESPACE_REQUIRED");
  let closing = false, settled = false, stopPromise, primary, initialized = false;
  const states = new Map(), handles = new WeakSet();
  const fail = error => { primary ??= error; for (const state of states.values()) state.authority.fence(); closing = true; onFailure(error); };
  const wait = async (predicate, milliseconds, cleanup = false) => {
    const deadline = performance.now() + milliseconds;
    while (!predicate()) {
      if (!cleanup && primary) throw primary;
      requireWorker(performance.now() < deadline, "LINUX_PEER_TIMEOUT");
      await new Promise(done => setTimeout(done, 10));
    }
  };
  const initialize = async () => { for (const worker of workers) {
    requireWorker(!closing, "P1C_ABORTED");
    const state = { ...worker, received: 0, pending: [], identified: null, registration: null, joined: false, released: false, child: null, helperInstances: new Map(), transport: null };
    states.set(worker.slot, state);
    state.authority = createLinuxAuthority({ runId, generation, slot: worker.slot, attempt: worker.attempt, durationMs: timeoutMs, send: packet => state.transport.write(packet) });
    const receive = packet => {
      requireWorker(linuxExact(packet, ["v", "runId", "generation", "slot", "attempt", "seq", "type", "data"]) && packet.v === 1
        && packet.runId === runId && packet.generation === generation && packet.slot === state.slot && packet.attempt === state.attempt && packet.seq === ++state.received, "LINUX_SUPERVISOR_PACKET_INVALID");
      const data = packet.data;
      if (packet.type === "FAILURE") {
        requireWorker(linuxExact(data, data.observation ? ["code", "observation"] : ["code"]), "LINUX_FAILURE_PACKET_INVALID");
        if (data.observation) {
          requireWorker(linuxExact(data.observation, ["processId", "parentProcessId", "startTicks", "executableCategory", "executableSha256", "observationPhase", "failedPredicate", "rejectionReasonCode", "clockDomain"]), "LINUX_FAILURE_PACKET_INVALID");
          const observed = data.observation;
          requireWorker((observed.processId === null || Number.isSafeInteger(observed.processId) && observed.processId > 0)
            && (observed.parentProcessId === null || Number.isSafeInteger(observed.parentProcessId) && observed.parentProcessId >= 0)
            && (observed.startTicks === null || /^\d{1,24}$/u.test(observed.startTicks)) && observed.executableCategory === "UNVERIFIED_OR_UNAUTHORIZED"
            && (observed.executableSha256 === null || /^[a-f0-9]{64}$/u.test(observed.executableSha256)) && ["LIVE", "STARTUP", "SHUTDOWN", "OBSERVATION"].includes(observed.observationPhase)
            && ["PROCESS_INSTANCE_IDENTITY_MISMATCH", "NAMESPACE_OR_PROCESS_STATE_MISMATCH", "PARENT_INSTANCE_MISMATCH", "HELPER_WITHOUT_LIVE_OWNER", "DESCENDANT_EXECUTABLE_NOT_ALLOWED", "DESCENDANT_ARGUMENTS_NOT_ALLOWED", "HELPER_PROCESS_INSTANCE_CHANGED"].includes(observed.failedPredicate)
            && observed.rejectionReasonCode === data.code && observed.clockDomain === "LINUX_BOOT_START_TICKS", "LINUX_FAILURE_PACKET_INVALID");
          state.failureObservation = data.observation;
        }
        throw new WorkerRunError(/^[A-Z][A-Z0-9_]{2,79}$/u.test(data?.code ?? "") ? data.code : "LINUX_SUPERVISOR_FAILED");
      }
      if (packet.type === "IDENTIFIED") {
        requireWorker(!state.identified && data.profileSha256 === hash(JSON.stringify(image.profile)), "LINUX_PROFILE_IDENTITY_MISMATCH");
        requireWorker(data.init.executable === image.profile.init.path && data.init.executableSha256 === image.profile.init.sha256
          && data.supervisor.executable === image.profile.node.path && data.supervisor.executableSha256 === image.profile.node.sha256, "LINUX_ROOT_IDENTITY_MISMATCH");
        if (state.dnsProof) requireWorker(data.dnsObservation?.proofSha256 === hash(JSON.stringify(state.dnsProof)) && data.dnsObservation.upstream === "127.0.0.1"
          && data.dnsObservation.netNamespace === data.supervisor.netns && data.dnsObservation.clientAddress === state.address, "LINUX_DNS_BINDING_MISMATCH");
        requireWorker(data.supervisor.bootId === state.dnsProof.bootId && [...states.values()].filter(other => other !== state && other.identified).every(other =>
          ["pidns", "netns", "mntns"].every(key => other.identified.supervisor[key] !== data.supervisor[key])), "LINUX_WORKER_NAMESPACE_SHARED");
        requireWorker(["pidns", "netns", "mntns"].every(key => controllerNamespaces[key] !== data.supervisor[key])
          && controllerNamespaces.bootId === data.supervisor.bootId, "LINUX_HOST_NAMESPACE_SHARED");
        reconcileLinuxProcesses(data.rows, { init: data.init, supervisor: data.supervisor, helpers: state.helperInstances, helper: image.profile.helper }); state.identified = data; return;
      }
      if (packet.type === "CHILD_REGISTERED") {
        requireWorker(state.child && !state.registration && data.consumer?.executable === image.profile.node.path && data.consumer.executableSha256 === image.profile.node.sha256
          && data.consumer.parent === state.identified.supervisor.pid && data.consumer.pidns === state.identified.supervisor.pidns, "LINUX_CHILD_IDENTITY_MISMATCH");
        const late = state.joined; state.registration = data.consumer; state.child.pid = data.consumer.pid;
        if (late) { state.joined = false; state.authority.reconcile("STOP"); throw new WorkerRunError("LINUX_LATE_SPAWN_AFTER_DORMANT"); }
        if (closing && !state.stopRequested) { state.stopRequested = true; state.authority.reconcile("STOP"); } return;
      }
      if (packet.type === "CHILD_PACKET") {
        requireWorker(state.child && !state.joined, "LINUX_UNOWNED_CHILD_PACKET");
        if (state.child.active) state.child.emit("message", data); else { requireWorker(state.pending.length < 64, "LINUX_PACKET_QUEUE_LIMIT"); state.pending.push(data); } return;
      }
      if (packet.type === "CHILD_JOINED") {
        requireWorker(state.registration && !state.joined && data.pid === state.registration.pid && data.exitObserved === true && data.closeObserved === true
          && data.helperAbsence === true && (data.exitCode === 86 ? state.crashArmed : data.exitCode === 0 && data.databaseClosed === true), "LINUX_CHILD_JOIN_UNVERIFIED");
        reconcileLinuxProcesses(data.rows, { ...state.identified, helpers: state.helperInstances, helper: image.profile.helper });
        requireWorker(data.rows.length === 2, "LINUX_HELPER_RECONCILIATION_FAILED");
        state.joined = true; state.child.connected = false; state.child.exitCode = data.exitCode;
        state.child.emit("exit", data.exitCode, null); state.child.emit("close", data.exitCode, null); return;
      }
      if (packet.type === "SNAPSHOT") {
        requireWorker(state.snapshotPending, "LINUX_UNSOLICITED_SNAPSHOT");
        reconcileLinuxProcesses(data.rows, { init: state.identified.init, supervisor: state.identified.supervisor,
          consumer: state.joined ? null : state.registration, helpers: state.helperInstances, helper: image.profile.helper });
        state.rows = data.rows; state.snapshotPending = false; return;
      }
      if (packet.type === "DORMANT_JOINED") { requireWorker(!state.registration && closing, "LINUX_DORMANT_JOIN_INVALID"); state.joined = true; return; }
      if (packet.type === "RELEASED") { requireWorker(state.joined && closing, "LINUX_RELEASE_UNVERIFIED"); state.released = true; return; }
      throw new WorkerRunError("LINUX_SUPERVISOR_PACKET_INVALID");
    };
    const reader = createLinuxLineReader(packet => { try { receive(packet); } catch (error) { fail(error); } }, fail);
    state.transport = await engine.attach(state.id, bytes => reader.push(bytes), fail);
    state.authority.commit("IDENTIFY", { dnsProof: state.dnsProof });
    await wait(() => state.identified, 5000);
  } initialized = true; };
  const snapshot = async () => {
    const result = [];
    for (const state of states.values()) {
      if (state.snapshotPending) await wait(() => !state.snapshotPending, 5000, closing);
      state.snapshotPending = true; state.authority.reconcile("STATUS");
      await wait(() => !state.snapshotPending, 5000, closing);
      result.push({ slot: state.slot, rows: state.rows });
    }
    return result;
  };
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || settled || !initialized) return;
    heartbeatBusy = true; snapshot().catch(fail).finally(() => { heartbeatBusy = false; });
  }, 5000);
  const group = {
    ready() { return group.initialization; },
    async launch(slot, { nonce, environment, target }) {
      await group.ready();
      const state = states.get(slot); requireWorker(!closing && !settled && state && !state.child, "P1C_LATE_PROCESS_REGISTRATION");
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: null, connected: true, exitCode: null, slot,
      send(packet, callback = null) {
        try {
          if (packet.type === "STOP") { state.authority.fence(); state.authority.reconcile("PACKET", packet); }
          else { requireWorker(!closing, "P1C_DISPATCH_AFTER_SHUTDOWN"); state.authority.commit("PACKET", packet); }
          callback?.(null);
        } catch (error) { callback?.(error); throw error; }
      } });
      child.kill = () => false;
      child.activate = () => { child.active = true; for (const packet of state.pending.splice(0)) child.emit("message", packet); };
      handles.add(child); state.child = child;
      // The attempt/handle are registered BEFORE committing START. They remain
      // reconciled even when START returns after the controller's abort fence.
      state.authority.commit("START", { nonce, environment, target });
      await wait(() => state.registration || state.joined, 15000); requireWorker(state.registration, "P1C_ABORTED");
      return child;
    },
    assertHandle(child) { requireWorker(handles.has(child), "LINUX_UNOWNED_HANDLE"); },
    target(slot) { return states.get(slot).target; },
    hello(slot, data) { const state = states.get(slot); return data.pid === state.registration.pid && data.node === "24.14.1" && data.execPath === image.profile.node.path; },
    snapshot,
    classify(rows) { requireWorker(rows.length === 2 && rows.every(row => states.has(row.slot)), "LINUX_CENSUS_INCOMPLETE"); return rows; },
    async reconcileJoined() {
      requireWorker([...states.values()].every(state => state.joined), "LINUX_PROCESS_JOIN_UNVERIFIED");
      const rows = await snapshot(); requireWorker(rows.every(row => row.rows.length === 2), "LINUX_HELPER_RECONCILIATION_FAILED");
    },
    track(child, options) { group.assertHandle(child); const state = states.get(child.slot); requireWorker(!settled, "P1C_LATE_PROCESS_REGISTRATION"); state.graceful = options.graceful; },
    stopOne(child) {
      group.assertHandle(child); const state = states.get(child.slot);
      state.stopPromise ??= (async () => {
        state.authority.fence(); if (!state.joined && !state.stopRequested) { state.stopRequested = true; if (state.graceful) await state.graceful(); else state.authority.reconcile("STOP"); }
        await wait(() => state.joined, 5000, true); requireWorker(!primary, primary?.code ?? "LINUX_JOIN_UNVERIFIED");
      })(); return state.stopPromise;
    },
    interrupt(child, send) { group.assertHandle(child); const state = states.get(child.slot); requireWorker(!closing && child.slot === "A" && !state.crashArmed, "LINUX_CRASH_NOT_ARMED"); state.crashArmed = true; send(); return wait(() => state.joined, 5000); },
    stopAll() {
      if (stopPromise) return stopPromise;
      closing = true; for (const state of states.values()) state.authority.fence();
      stopPromise = (async () => {
        const result = await Promise.allSettled([...states.values()].map(async state => {
          if (state.child) return group.stopOne(state.child);
          state.stopRequested = true; state.authority.reconcile("STOP"); await wait(() => state.joined, 5000, true);
        }));
        const failure = result.find(row => row.status === "rejected"); if (failure) throw failure.reason;
        await group.reconcileJoined(); if (primary) throw primary;
        return { joined: true, processes: 2 };
      })(); return stopPromise;
    },
    async release() {
      await group.stopAll();
      for (const state of states.values()) { state.transport.expectClose?.(); state.authority.reconcile("RELEASE"); await wait(() => state.released, 5000, true); await state.transport.close(); }
      settled = true; clearInterval(heartbeat);
    },
    get closing() { return closing; },
    records: () => [...states.values()].map(state => ({ slot: state.slot, containerId: state.id, process: state.registration, joined: state.joined, released: state.released, primaryFailure: primary?.code ?? null, failureObservation: state.failureObservation ?? null, operations: state.authority.records() })),
    dispose() { clearInterval(heartbeat); closing = true; for (const state of states.values()) { state.authority.fence(); state.transport?.abort?.(); } },
  };
  linuxGroups.add(group); group.initialization = initialize().catch(error => { fail(error); throw error; }); group.initialization.catch(() => {}); return group;
}

