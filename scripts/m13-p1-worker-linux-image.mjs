import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { get as httpsGet } from "node:https";
import { spawn } from "node:child_process";
import * as nativeFs from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createReadStream, createWriteStream, readFileSync, lstatSync, appendFileSync, mkdirSync, writeFileSync, constants as fsConstants } from "node:fs";
import { performance } from "node:perf_hooks";
import { gunzipSync, gzipSync } from "node:zlib";
import { linuxAssert, linuxExact, LinuxSafetyError, linuxBounded, readLinuxProcess, parseLinuxStat } from "./m13-p1-worker-linux-entry.mjs";

export const LINUX_NODE_ARCHIVE_SHA256 = "84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be";
export const LINUX_PROFILE = Object.freeze({ admissionMiB: 3840, hardLimitsMiB: 2816, reserveMiB: 1024, workerMemory: 512 * 1024 ** 2, workerTmpfs: 64 * 1024 ** 2 });
const digest = data => createHash("sha256").update(data).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const image = value => typeof value === "string" && /^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/u.test(value);
const qualifiedLinuxImages = new WeakSet(), qualifiedLinuxEngines = new WeakSet(), workloadAdmissions = new WeakSet();
export const isQualifiedLinuxImage = value => qualifiedLinuxImages.has(value);
export const isQualifiedLinuxEngine = value => qualifiedLinuxEngines.has(value);
export const isLinuxWorkloadAdmission = value => workloadAdmissions.has(value);
const toolProcesses = new Set(), artifactTransfers = new Set();
const preparationScope = new AsyncLocalStorage();
const fileOperation = name => (...args) => {
  const authority = preparationScope.getStore();
  return authority ? authority.run(["readFile", "lstat", "stat", "statfs", "realpath", "readdir"].includes(name) ? "READ" : "FS", name.toLowerCase(), () => nativeFs[name](...args)) : nativeFs[name](...args);
};
const [lstat, readFile, writeFile, mkdir, mkdtemp, cp, readdir, realpath, statfs, stat, open] = ["lstat", "readFile", "writeFile", "mkdir", "mkdtemp", "cp", "readdir", "realpath", "statfs", "stat", "open"].map(fileOperation);
export const withPreparationAuthority = (authority, work) => preparationScope.run(authority, work);

export const ADMISSION_PHASE_SECONDS = Object.freeze({ preparation: 600, bootstrap: 30, writers: 180, workerGuard: 15, worker: 600, teardown: 70, finalization: 30, retention: 120 });
export const EVIDENCE_POLICY = Object.freeze({ days: 14, compressedBytes: 50 * 1024 ** 2, rawBytes: 64 * 1024 ** 2, rows: 20000 });
// Preserve canonical technical codes (including SQL/OS failures), never messages.
const codeOf = error => evCode(error?.code) ? error.code : "LINUX_ADMISSION_FAILED";
// /proc/uptime has the same monotonic domain before and after execve.
export const linuxAdmissionNow = () => process.platform === "linux" ? Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000 : performance.now();

// Scan raw JSON before JSON.parse: decoded object keys, including escape aliases,
// must be unique. No dependency, reviver, eval or permissive YAML interpretation.
export function parseLinuxJson(bytes, maximum = 512 * 1024) {
  linuxAssert(Buffer.byteLength(bytes) <= maximum, "LINUX_JSON_LIMIT");
  linuxAssert(!Buffer.from(bytes).subarray(0, 3).equals(Buffer.from([239, 187, 191])), "LINUX_JSON_AMBIGUOUS");
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new LinuxSafetyError("LINUX_JSON_INVALID"); }
  let at = 0, nodes = 0;
  const space = () => { while (/[\x20\t\r\n]/u.test(text[at] ?? "!") && at < text.length) at++; };
  const string = () => {
    const start = at++; linuxAssert(text[start] === '"', "LINUX_JSON_INVALID");
    while (at < text.length) {
      const character = text[at++];
      if (character === '"') { try { return JSON.parse(text.slice(start, at)); } catch { break; } }
      if (character === "\\") at++;
    }
    throw new LinuxSafetyError("LINUX_JSON_INVALID");
  };
  const value = depth => {
    space(); linuxAssert(depth <= 32 && ++nodes <= 100000, "LINUX_JSON_LIMIT");
    if (text[at] === "{") {
      at++; space(); const keys = new Set(); if (text[at] === "}") { at++; return; }
      while (at < text.length) {
        space(); const keyStart = at, key = string();
        linuxAssert(!text.slice(keyStart, at).includes("\\") && !keys.has(key) && !["__proto__", "constructor", "prototype"].includes(key), "LINUX_JSON_AMBIGUOUS"); keys.add(key);
        space(); linuxAssert(text[at++] === ":", "LINUX_JSON_INVALID"); value(depth + 1); space();
        const end = text[at++]; if (end === "}") return; linuxAssert(end === ",", "LINUX_JSON_INVALID");
      }
    } else if (text[at] === "[") {
      at++; space(); if (text[at] === "]") { at++; return; }
      while (at < text.length) { value(depth + 1); space(); const end = text[at++]; if (end === "]") return; linuxAssert(end === ",", "LINUX_JSON_INVALID"); }
    } else if (text[at] === '"') { string(); return; }
    else { const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(at)); if (token) {
      if (!/^(?:null|true|false)$/u.test(token[0])) { const number = Number(token[0]); linuxAssert(Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number)) && !Object.is(number, -0), "LINUX_JSON_AMBIGUOUS"); }
      at += token[0].length; return;
    } }
    throw new LinuxSafetyError("LINUX_JSON_INVALID");
  };
  value(0); space(); linuxAssert(at === text.length, "LINUX_JSON_INVALID");
  try { return JSON.parse(text); } catch { throw new LinuxSafetyError("LINUX_JSON_INVALID"); }
}

export function linuxJobSchedule(started, now = linuxAdmissionNow) {
  linuxAssert(Number.isFinite(started) && started > 0 && started <= now(), "LINUX_JOB_CLOCK_INVALID");
  let elapsed = 0; const ends = {};
  for (const [name, seconds] of Object.entries(ADMISSION_PHASE_SECONDS)) { elapsed += seconds * 1000; ends[name] = started + elapsed; }
  return Object.freeze({ started, ends: Object.freeze(ends), jobDeadline: started + 1800000,
    remaining(name) { linuxAssert(Object.hasOwn(ends, name), "LINUX_JOB_PHASE_INVALID"); const result = ends[name] - now(); linuxAssert(result > 0, "LINUX_JOB_PHASE_EXPIRED"); return result; },
    admit(name) { this.remaining(name); linuxAssert(now() < this.jobDeadline - 155000, "LINUX_JOB_TAIL_UNAVAILABLE"); return ends[name]; } });
}

// One owner fences ALL preparation continuations, filesystem waits, spawns and
// Engine writes. A timeout rejects the wait AND revokes the shared authority.
export function createPreparationAuthority({ deadline, now = linuxAdmissionNow, signal, record = () => {}, attempt = randomUUID(), purpose = "PREPARATION", ownedImage = null }) {
  linuxAssert(Number.isFinite(deadline) && deadline > now(), "LINUX_PREPARATION_DEADLINE");
  linuxAssert(["PREPARATION", "EVIDENCE_FINALIZATION", "OWNED_ARTIFACT_CLEANUP"].includes(purpose)
    && (purpose !== "OWNED_ARTIFACT_CLEANUP" || /^sha256:[a-f0-9]{64}$/u.test(ownedImage)), "LINUX_PREPARATION_PURPOSE_INVALID");
  const controller = new AbortController(), operations = new Set(), tools = new Map(), channels = new Set();
  let primary = null, stopPromise, sequence = 0;
  const emit = () => record({ attempt, purpose, revoked: controller.signal.aborted, primary, deadlineMs: deadline });
  const revoke = error => { primary ??= codeOf(error); if (!controller.signal.aborted) controller.abort(new LinuxSafetyError(primary)); emit(); };
  const assert = () => {
    if (now() >= deadline) revoke(new LinuxSafetyError("LINUX_PREPARATION_DEADLINE"));
    linuxAssert(!controller.signal.aborted, primary ?? "LINUX_PREPARATION_REVOKED");
  };
  const onAbort = () => revoke(signal.reason ?? new LinuxSafetyError("P1C_ABORTED"));
  signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort();
  const wait = (promise, limit = deadline, inspectAuthority = true) => new Promise((done, reject) => {
    const end = Math.min(limit, deadline); let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); controller.signal.removeEventListener("abort", aborted); if (error) reject(error); else done(value); };
    const aborted = () => finish(new LinuxSafetyError(primary ?? "LINUX_PREPARATION_REVOKED"));
    const timer = setTimeout(() => { revoke(new LinuxSafetyError("LINUX_PREPARATION_DEADLINE")); aborted(); }, Math.max(1, end - now()));
    if (inspectAuthority) controller.signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(value => { try { if (inspectAuthority) assert(); finish(null, value); } catch (error) { finish(error); } }, error => { if (inspectAuthority) revoke(error); finish(error); });
    if (inspectAuthority && controller.signal.aborted) aborted();
  });
  const register = (kind, name) => {
    assert(); linuxAssert(["FS", "DOWNLOAD", "TOOL", "DAEMON", "READ", "WRITE"].includes(kind) && /^[a-z0-9-]{1,64}$/u.test(name), "LINUX_PREPARATION_OPERATION_INVALID");
    if (!(purpose === "PREPARATION" || ["FS", "READ", "WRITE"].includes(kind) || purpose === "OWNED_ARTIFACT_CLEANUP" && kind === "DAEMON" && name === "remove-owned-image")) {
      const error = new LinuxSafetyError("LINUX_PREPARATION_PURPOSE_FORBIDDEN"); revoke(error); throw error;
    }
    linuxAssert(operations.size < 100000, "LINUX_PREPARATION_OPERATION_LIMIT");
    const row = { id: attempt + ":" + (++sequence), kind, name, state: "REGISTERED", dispatched: false, settled: false, daemonComplete: false, transportJoined: false, failure: null };
    operations.add(row); return row;
  };
  const dispatch = (row, work) => {
    assert(); linuxAssert(operations.has(row) && row.state === "REGISTERED", "LINUX_PREPARATION_OPERATION_REUSED");
    row.dispatched = true; row.state = "DISPATCHED";
    // Deliberately synchronous: no await or promise callback between fence and dispatch.
    try { return work(); } catch (error) { row.settled = true; row.failure = codeOf(error); row.state = "FAILED"; revoke(error); throw error; }
  };
  const track = (row, promise) => {
    const observed = Promise.resolve(promise).then(value => { row.settled = true; row.state = controller.signal.aborted ? "LATE_COMPLETION" : "COMPLETED"; return value; }, error => { row.settled = true; row.state = "FAILED"; row.failure = codeOf(error); revoke(error); throw error; });
    observed.catch(() => {}); return wait(observed);
  };
  const run = (kind, name, work) => { const row = register(kind, name); return track(row, dispatch(row, () => work(row))); };
  const completeDaemon = (row, proof) => {
    linuxAssert(operations.has(row) && row.kind === "DAEMON" && row.dispatched && proof?.responseComplete === true && proof?.instanceVerified === true
      && hex(proof.responseSha256) && typeof proof.engineId === "string" && proof.engineId.length > 5, "LINUX_DAEMON_COMPLETION_NOT_VERIFIED");
    row.daemonComplete = true; row.daemonProof = { engineId: proof.engineId, responseSha256: proof.responseSha256, artifactId: proof.artifactId ?? null };
  };
  const completeTransfer = (row, joined) => { linuxAssert(operations.has(row) && row.kind === "DOWNLOAD" && typeof joined === "boolean", "LINUX_TRANSFER_PROOF_INVALID"); row.transportJoined = joined; };
  const registerChannel = controls => { assert(); linuxAssert(typeof controls.stop === "function" && typeof controls.joined === "function", "LINUX_CHANNEL_OWNERSHIP_INVALID"); channels.add({ id: randomUUID(), controls }); };
  const registerTool = (handle, identity, controls) => {
    // Registration is bookkeeping for a dispatch already committed above; it
    // must still happen if the deadline elapses immediately after spawn.
    const valid = handle && Number.isInteger(handle.pid) && handle.pid > 0 && identity.pid === handle.pid && hex(identity.executableSha256)
      && [...operations].some(row => row.kind === "TOOL" && row.id === identity.operationId && row.dispatched)
      && typeof controls.stop === "function" && typeof controls.joined === "function" && !tools.has(handle);
    if (!valid) { const error = new LinuxSafetyError("LINUX_PREPARATION_TOOL_OWNERSHIP"); revoke(error); throw error; }
    tools.set(handle, { identity, controls });
  };
  const stop = ({ deadline: cleanupDeadline = Math.min(deadline + 70000, now() + 70000) } = {}) => {
    if (stopPromise) return stopPromise;
    if (!controller.signal.aborted) revoke(new LinuxSafetyError("LINUX_PREPARATION_STOPPED"));
    stopPromise = (async () => {
      const failures = [];
      const attempts = [...tools.values(), ...channels].map(async value => {
        if (value.controls.joined()) return;
        try { await value.controls.stop(value.identity); } catch { failures.push("LINUX_PREPARATION_TOOL_STOP_FAILED"); }
      });
      // STOP is only for positively registered handles. Unknown descendants are never killed.
      let completed = false; Promise.allSettled(attempts).then(() => { completed = true; });
      while (now() < cleanupDeadline && (!completed || [...tools.values(), ...channels].some(value => !value.controls.joined()) || [...operations].some(row => row.dispatched && !row.settled))) await new Promise(done => setTimeout(done, 10));
      const incomplete = [...operations].filter(row => row.dispatched && (!row.settled || row.kind === "DAEMON" && !row.daemonComplete || row.kind === "DOWNLOAD" && !row.transportJoined));
      if (!completed || [...tools.values(), ...channels].some(value => !value.controls.joined())) failures.push("LINUX_PREPARATION_JOIN_INCOMPLETE");
      if (incomplete.length) failures.push("LINUX_PREPARATION_RECONCILIATION_INCOMPLETE");
      return { complete: failures.length === 0, failures, primary, operations: records(), residualOperations: incomplete.map(row => row.id) };
    })(); return stopPromise;
  };
  const records = () => [...operations].map(row => ({ ...row }));
  const assertEngineDispatch = (method, path) => {
    assert();
    const permitted = method === "GET" || purpose === "PREPARATION" && (method === "POST" && /^\/(?:images\/create|build)\?/u.test(path)
      || method === "DELETE" && /^\/images\/sha256:[a-f0-9]{64}$/u.test(path))
      || purpose === "OWNED_ARTIFACT_CLEANUP" && method === "DELETE" && path === "/images/" + ownedImage;
    if (!permitted) { const error = new LinuxSafetyError("LINUX_PREPARATION_RPC_FORBIDDEN"); revoke(error); throw error; }
  };
  emit();
  return Object.freeze({ assert, assertEngineDispatch, revoke, wait, register, dispatch, track, run, registerTool, registerChannel, completeDaemon, completeTransfer, stop, records, signal: controller.signal, attempt, purpose,
    channels: () => [...channels].map(value => ({ id: value.id, joined: value.controls.joined() })),
    remaining() { assert(); return deadline - now(); },
    seal() { assert(); linuxAssert(this.quiescent(), "LINUX_PREPARATION_JOIN_INCOMPLETE"); controller.abort(new LinuxSafetyError("LINUX_PREPARATION_SEALED")); emit(); },
    get deadline() { return deadline; }, get primary() { return primary; }, get revoked() { return controller.signal.aborted; },
    quiescent() { return [...operations].every(row => row.settled && (!row.dispatched || row.kind !== "DAEMON" || row.daemonComplete) && (row.kind !== "DOWNLOAD" || row.transportJoined))
      && [...tools.values(), ...channels].every(value => value.controls.joined()); },
    dispose() { signal?.removeEventListener("abort", onAbort); } });
}

// Budget rows describe incremental writes and independently retained tails. They
// are approved inputs, never measurements invented from the runner's free space.
export function assertLinuxDiskBudget(value) {
  linuxAssert(linuxExact(value, ["v", "basis", "phases"]) && value.v === 1 && ["DISCOVERY_CAP", "MEASURED_APPROVED"].includes(value.basis)
    && Array.isArray(value.phases) && value.phases.length > 0 && value.phases.length <= 16, "LINUX_DISK_BUDGET_UNKNOWN");
  const names = new Set();
  for (const phase of value.phases) {
    linuxAssert(linuxExact(phase, ["name", "allocations"]) && /^[a-z-]{1,40}$/u.test(phase.name) && !names.has(phase.name) && Array.isArray(phase.allocations)
      && phase.allocations.length > 0 && phase.allocations.length <= 8, "LINUX_DISK_BUDGET_INVALID"); names.add(phase.name);
    const categories = new Set();
    for (const row of phase.allocations) {
      linuxAssert(linuxExact(row, ["category", "incrementalBytes", "remainingBytes", "teardownBytes", "evidenceBytes", "headroomBytes", "maximumOutputBytes"])
        && ["root", "temp", "docker", "cache", "artifact", "evidence"].includes(row.category) && !categories.has(row.category), "LINUX_DISK_BUDGET_INVALID"); categories.add(row.category);
      linuxAssert(Object.entries(row).every(([key, item]) => key === "category" || Number.isSafeInteger(item) && item >= 0)
        && row.maximumOutputBytes > 0 && row.evidenceBytes > 0 && row.headroomBytes > 0 && row.teardownBytes > 0, "LINUX_DISK_BUDGET_INVALID");
    }
  }
  return value;
}

export async function admitLinuxDisk(options) {
  try { return await measureLinuxDiskAdmission(options); } catch (error) { options.authority?.revoke(error); throw error; }
}
async function measureLinuxDiskAdmission({ budget, phase, paths, authority, during = false, measure = async path => {
  const [filesystem, file] = await Promise.all([statfs(path), stat(path)]);
  return { device: String(file.dev), availableBytes: filesystem.bavail * filesystem.bsize, totalBytes: filesystem.blocks * filesystem.bsize };
} }) {
  assertLinuxDiskBudget(budget); const plan = budget.phases.find(row => row.name === phase); linuxAssert(plan, "LINUX_DISK_PHASE_UNKNOWN");
  linuxAssert(Object.keys(paths).every(category => plan.allocations.some(row => row.category === category)), "LINUX_DISK_COVERAGE_INCOMPLETE");
  const devices = new Map();
  for (const row of plan.allocations) {
    authority?.assert(); linuxAssert(typeof paths[row.category] === "string", "LINUX_DISK_PATH_MISSING");
    const measured = await (authority ? authority.run("READ", "disk-measure", () => measure(paths[row.category])) : measure(paths[row.category])); authority?.assert();
    linuxAssert(typeof measured.device === "string" && [measured.availableBytes, measured.totalBytes].every(value => Number.isSafeInteger(value) && value >= 0), "LINUX_DISK_MEASUREMENT_INCOMPLETE");
    const current = devices.get(measured.device) ?? { device: measured.device, categories: [], availableBytes: measured.availableBytes, totalBytes: measured.totalBytes, requiredBytes: 0, maximumOutputBytes: 0 };
    // One free-space observation per device; writes for distinct categories on
    // that device still consume the same capacity. Reserves are counted once.
    current.availableBytes = Math.min(current.availableBytes, measured.availableBytes); current.categories.push(row.category);
    current.requiredBytes += during ? 0 : row.incrementalBytes;
    current.remaining = Math.max(current.remaining ?? 0, row.remainingBytes); current.teardown = Math.max(current.teardown ?? 0, row.teardownBytes);
    current.evidence = Math.max(current.evidence ?? 0, row.evidenceBytes); current.headroom = Math.max(current.headroom ?? 0, row.headroomBytes);
    current.maximumOutputBytes += row.maximumOutputBytes; devices.set(measured.device, current);
  }
  const result = [...devices.values()].map(row => ({ device: row.device, categories: row.categories, availableBytes: row.availableBytes, totalBytes: row.totalBytes,
    requiredBytes: row.requiredBytes + row.remaining + row.teardown + row.evidence + row.headroom, maximumOutputBytes: row.maximumOutputBytes }));
  try { linuxAssert(result.every(row => Number.isSafeInteger(row.requiredBytes) && Number.isSafeInteger(row.maximumOutputBytes) && row.availableBytes >= row.requiredBytes), "LINUX_DISK_ADMISSION_FAILED"); }
  catch (error) { authority?.revoke(error); throw error; }
  return { phase, complete: true, filesystems: result, enforcement: "OBSERVATION_NOT_HARD_DOCKER_QUOTA" };
}

export async function runLinuxDiskPhase({ budget, phase, paths, authority, record = () => {}, measure, pollMs = 500 }, work) {
  const before = await admitLinuxDisk({ budget, phase, paths, authority, measure }); record(before);
  let pending = null, observationFailure = null;
  const sample = async () => {
    try {
      const value = await admitLinuxDisk({ budget, phase, paths, authority, measure, during: true });
      for (const row of value.filesystems) {
        const original = before.filesystems.find(item => item.device === row.device);
        linuxAssert(original && original.availableBytes - row.availableBytes <= original.maximumOutputBytes, "LINUX_DISK_PHASE_OUTPUT_LIMIT");
      }
      record(value); return value;
    } catch (error) { observationFailure ??= error; authority.revoke(error); throw error; }
  };
  const timer = setInterval(() => { if (!pending && !authority.revoked) { pending = sample(); pending.catch(() => {}).finally(() => { pending = null; }); } }, pollMs);
  let primary;
  try { const result = await authority.wait(Promise.resolve().then(() => { authority.assert(); return work(); })); await sample(); authority.assert(); return result; }
  catch (error) { primary = error; throw error; }
  finally { clearInterval(timer); if (pending) { try { await pending; } catch (error) { if (!primary) throw error; } } if (!primary && observationFailure) throw observationFailure; }
}

export function parseLinuxDaemonCompletion(bytes, kind, reference) {
  const rows = bytes.toString("utf8").split("\n").filter(line => line.trim()).map(line => parseLinuxJson(Buffer.from(line), 65536));
  linuxAssert(rows.length > 0 && rows.length <= 20000 && rows.every(row => !row.error && !row.errorDetail), "LINUX_DAEMON_OPERATION_FAILED");
  if (kind === "pull") {
    const expected = reference.split("@")[1];
    linuxAssert(/^sha256:[a-f0-9]{64}$/u.test(expected) && rows.some(row => row.status === "Digest: " + expected)
      && rows.some(row => /^Status: (?:Downloaded newer image|Image is up to date) for /u.test(row.status ?? "")), "LINUX_DAEMON_PULL_COMPLETION_MISSING");
    return { responseSha256: digest(bytes), artifactId: null };
  }
  const ids = rows.filter(row => row.aux?.ID).map(row => row.aux.ID);
  linuxAssert(kind === "build" && ids.length === 1 && /^sha256:[a-f0-9]{64}$/u.test(ids[0]), "LINUX_DAEMON_BUILD_COMPLETION_MISSING");
  return { responseSha256: digest(bytes), artifactId: ids[0] };
}

// A CLI close is never passed to completeDaemon. Completion requires the
// correlated Engine response to end, its operation receipt and a fresh image
// instance inspection. An aborted connection stays unreconciled even if an
// image happens to be visible later; no daemon-completion PASS is inferred.
export async function runLinuxPreparationDaemon({ authority, engine, kind, reference, expectedConfig, contextArchive, labels, output, maximum }) {
  linuxAssert(["pull", "build", "save"].includes(kind), "LINUX_DAEMON_OPERATION_INVALID");
  const operation = authority.register("DAEMON", kind);
  const work = async () => {
    authority.assert(); await engine.verify(); authority.assert(); let result, proof;
    const beforeDispatch = () => authority.dispatch(operation, () => undefined);
    if (kind === "pull") {
      linuxAssert(/^(?:docker\.io\/library\/node|postgres|haproxy)@sha256:[a-f0-9]{64}$/u.test(reference) && /^sha256:[a-f0-9]{64}$/u.test(expectedConfig), "LINUX_PULL_NOT_PLANNED");
      const [name, tag] = reference.split("@");
      const bytes = await engine.call("POST", "/images/create?fromImage=" + encodeURIComponent(name) + "&tag=" + encodeURIComponent(tag) + "&platform=linux%2Famd64", undefined,
        { binary: true, timeoutMs: Math.max(1, authority.remaining()), signal: authority.signal, beforeDispatch });
      authority.assert(); proof = parseLinuxDaemonCompletion(bytes, kind, reference);
      result = await engine.call("GET", "/images/" + encodeURIComponent(reference) + "/json"); authority.assert();
      linuxAssert(result.Id === expectedConfig && result.Os === "linux" && result.Architecture === "amd64"
        && result.RepoDigests?.some(value => value.endsWith("@" + tag)), "LINUX_PULL_INSTANCE_NOT_VERIFIED");
    } else if (kind === "build") {
      linuxAssert(isAbsolute(contextArchive.path) && Number.isSafeInteger(contextArchive.bytes) && contextArchive.bytes > 0 && labels?.["piccadilly.preparation"] === authority.attempt
        && hex(labels["piccadilly.source"]), "LINUX_BUILD_NOT_PLANNED");
      const bytes = await engine.call("POST", "/build?dockerfile=Dockerfile&networkmode=none&pull=0&rm=1&forcerm=1&t=" + encodeURIComponent(reference)
        + "&labels=" + encodeURIComponent(JSON.stringify(labels)), undefined, { bodyFile: contextArchive, headers: { "Content-Type": "application/x-tar" }, binary: true,
        timeoutMs: Math.max(1, authority.remaining()), signal: authority.signal, beforeDispatch });
      authority.assert(); proof = parseLinuxDaemonCompletion(bytes, kind);
      result = await engine.call("GET", "/images/" + encodeURIComponent(reference) + "/json"); authority.assert();
      linuxAssert(result.Id === proof.artifactId && result.Config.Labels?.["piccadilly.preparation"] === authority.attempt
        && result.Config.Labels?.["piccadilly.source"] === labels["piccadilly.source"], "LINUX_BUILD_INSTANCE_NOT_VERIFIED");
    } else {
      linuxAssert(/^sha256:[a-f0-9]{64}$/u.test(reference), "LINUX_SAVE_NOT_PLANNED");
      result = await engine.call("GET", "/images/" + reference + "/get", undefined, { responseFile: { path: output, maximum }, binary: true,
        timeoutMs: Math.max(1, authority.remaining()), signal: authority.signal, beforeDispatch });
      authority.assert(); linuxAssert(result.responseComplete && hex(result.sha256) && result.bytes > 0 && result.bytes <= maximum, "LINUX_SAVE_INCOMPLETE");
      proof = { responseSha256: result.sha256, artifactId: reference };
    }
    authority.completeDaemon(operation, { ...proof, artifactId: proof.artifactId ?? result.Id, engineId: engine.id, responseComplete: true, instanceVerified: true });
    return result;
  };
  return authority.track(operation, work());
}

const evNumber = value => Number.isFinite(value) && value >= 0;
const evInteger = value => Number.isSafeInteger(value) && value >= 0;
const evBool = value => typeof value === "boolean";
const evText = value => typeof value === "string" && /^[A-Za-z0-9_.:/[\] +-]{1,160}$/u.test(value) && !/(?:password|secret|token|dsn|sentinel|https?:|postgres:|@)/iu.test(value);
const evCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{2,100}$/u.test(value) && evText(value);
const evUuid = value => typeof value === "string" && /^[a-f0-9-]{36}$/u.test(value);
const evNullable = check => value => value === null || check(value);
const evArray = (check, maximum = 1024) => value => Array.isArray(value) && value.length <= maximum && value.every(check);
const evEnum = (...values) => value => values.includes(value);
const evObject = (schema, optional = []) => value => value && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).every(key => Object.hasOwn(schema, key)) && Object.entries(schema).every(([key, check]) => optional.includes(key) && !Object.hasOwn(value, key) || Object.hasOwn(value, key) && check(value[key]));
const evTime = value => typeof value === "string" && /^[0-9TZ:. +-]{10,64}$/u.test(value);
const evStatus = evEnum("PASS_VERIFIED", "FAIL", "NOT_RUN", "NOT_VERIFIABLE");
const evProcess = evObject({ pid: evInteger, parent: evInteger, startTicks: value => /^\d+$/u.test(value), state: evEnum("R", "S", "D", "I", "T", "t", "Z", "X"),
  pidns: evText, netns: evText, mntns: evText, bootId: evUuid, executableSha256: hex, commandSha256: hex, cgroupSha256: hex });
const evDiskRow = evObject({ device: value => /^\d+$/u.test(value), categories: evArray(evEnum("root", "temp", "docker", "cache", "artifact", "evidence"), 8),
  availableBytes: evInteger, totalBytes: evInteger, requiredBytes: evInteger, maximumOutputBytes: evInteger });
const evSqlIdentity = evObject({ database: value => /^piccadilly_e2e_[a-f0-9]{32}$/u.test(value), role: value => /^m13_p1_[a-f0-9]{16}$/u.test(value),
  version: value => /^18\.4(?:[ .A-Za-z0-9()-]*)$/u.test(value), dataDirectory: evEnum("/var/lib/postgresql/18/docker"), systemIdentifier: value => /^\d+$/u.test(value),
  postmasterStart: evTime, serverAddress: value => /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value), clientAddress: evNullable(value => /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)), serverPort: evEnum(5432) });
const evIdentity = evObject({ v: evEnum(1), mode: evEnum("ARTIFACT_DISCOVERY", "QUALIFIED_WORKLOAD"), repository: evEnum("TommyGiacopini/piccadilly-booking"),
  commit: evNullable(value => /^[a-f0-9]{40}$/u.test(value)), tree: evNullable(value => /^[a-f0-9]{40}$/u.test(value)), sourceFreeze: evNullable(hex), workflowSha256: evNullable(hex), manifestSha256: evNullable(hex),
  manifestUrl: evNullable(value => /^https:\/\/github\.com\/TommyGiacopini\/piccadilly-booking\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.json$/u.test(value)),
  runId: value => /^\d{1,24}$/u.test(value), runAttempt: value => /^\d{1,8}$/u.test(value), attempt: evUuid,
  runner: evObject({ os: evEnum("Linux"), arch: evEnum("X64"), imageVersion: evNullable(evText), engineId: evNullable(evText) }),
  bootstrap: evObject({ version: value => /^\d+\.\d+\.\d+$/u.test(value), sha256: hex }),
  policy: evObject({ retentionDays: evEnum(14), compressedMaxBytes: evEnum(EVIDENCE_POLICY.compressedBytes) }),
  approvalModel: evEnum("HUMAN_WORK3_CLASSIC3_REQUIRED_NOT_CRYPTOGRAPHIC_SIGNATURE") });
const evOutcome = evObject({ status: evStatus, mode: evEnum("ARTIFACT_DISCOVERY", "QUALIFIED_WORKLOAD"), primary: evNullable(evCode), secondary: evArray(evCode, 64),
  omissions: evArray(evCode, 64), scenarios: value => linuxExact(value, Array.from({ length: 10 }, (_, index) => "C" + String(index + 1).padStart(2, "0"))) && Object.values(value).every(evStatus),
  preparationComplete: evBool, daemonReconciled: evBool, processesJoined: evBool, sqlQuiescence: evStatus, teardownComplete: evBool, artifactCleanup: evStatus, nativeMeasurement: evEnum("NOT_QUALIFIED_BY_IMPLEMENTATION") });
const evidenceSchemas = Object.freeze({
  authority: evObject({ attempt: evUuid, purpose: evEnum("PREPARATION", "EVIDENCE_FINALIZATION", "OWNED_ARTIFACT_CLEANUP"), revoked: evBool, primary: evNullable(evCode), deadlineMs: evNumber }),
  phase: evObject({ name: evText, startedMs: evNumber, endedMs: evNullable(evNumber), deadlineMs: evNumber, complete: evBool }),
  operation: evObject({ id: evText, kind: evEnum("FS", "DOWNLOAD", "TOOL", "DAEMON", "READ", "WRITE"), name: evText, state: evEnum("REGISTERED", "DISPATCHED", "COMPLETED", "LATE_COMPLETION", "FAILED"),
    dispatched: evBool, settled: evBool, daemonComplete: evBool, transportJoined: evBool, failure: evNullable(evCode) }),
  channels: evObject({ rows: evArray(evObject({ id: evUuid, joined: evBool }), 128) }),
  operations: value => evObject({ rows: evArray(evidenceSchemas.operation, 256) })(value),
  rejection: evObject({ pid: evInteger, parent: evInteger, startTicks: value => /^\d+$/u.test(value), executableSha256: hex,
    failedPredicate: evEnum("TOOL_DESCENDANT_IDENTITY_OR_PARENT_NOT_ALLOWED") }),
  storage: evObject({ phase: evText, complete: evBool, filesystems: evArray(evDiskRow, 8), enforcement: evEnum("OBSERVATION_NOT_HARD_DOCKER_QUOTA") }),
  daemon: evObject({ operationId: evText, engineId: evText, responseSha256: hex, artifactId: evNullable(evText), complete: evBool }),
  tool: evObject({ operationId: evNullable(evText), pid: evNullable(evInteger), executableSha256: hex, startTicks: evNullable(value => /^\d+$/u.test(value)),
    exitObserved: evBool, closeObserved: evBool, exitCode: evNullable(value => Number.isInteger(value)), treeVerified: evBool, failure: evNullable(evCode), stopFailure: evNullable(evCode), helpers: evArray(evProcess, 32) }),
  resource: evObject({ runId: evUuid, generation: evUuid, attempt: evUuid, role: evEnum("postgres", "haproxy", "worker-A", "worker-B"), id: hex,
    imageId: value => /^sha256:[a-f0-9]{64}$/u.test(value), created: evTime, started: evNullable(evTime), pid: evInteger, running: evBool, restartCount: evInteger, oomKilled: evBool,
    networkIds: evArray(hex, 2), securitySha256: hex, user: evEnum("", "99:99", "10001:10001"), privileged: evBool, readonlyRootfs: evBool,
    memory: evInteger, memorySwap: evInteger, restartPolicy: evEnum("no"), dns: evArray(evEnum("127.0.0.1"), 1), noNewPrivileges: evBool,
    allCapabilitiesDropped: evBool, seccompSha256: evNullable(hex) }),
  process: evObject({ runId: evUuid, generation: evUuid, slot: evEnum("A", "B"), rows: evArray(evProcess, 16) }),
  sql: evObject({ runId: evUuid, generation: evUuid, monitor: evObject({ pid: evInteger, backendStart: evTime, applicationName: value => /^m13-monitor-[a-f0-9-]{36}$/u.test(value), readOnly: evBool }),
    sessions: evArray(evObject({ pid: evInteger, backendStart: evTime, state: evEnum("active", "idle", "idle in transaction", "idle in transaction (aborted)", "unknown"), transactionOpen: evBool,
      sameDatabase: evBool, sameRole: evBool, ownership: evEnum("SYNTHETIC_CLIENT_CORRELATED", "UNRECONCILED"), backendType: evEnum("client backend", "unknown") })),
    sameRoleNonClients: evArray(evObject({ type: value => /^[a-z ]{1,64}$/u.test(value), count: evInteger })), identity: evSqlIdentity, quiet: evBool, monitorClosed: evBool }),
  claim: evObject({ runId: evUuid, generation: evUuid, slot: evEnum("A", "B"), rows: evArray(evObject({ id: evUuid, lease: hex }), 5) }),
  receipt: evObject({ runId: evUuid, generation: evUuid, slot: evEnum("A", "B"), id: evUuid, referenceSha256: hex, payloadHash: hex }),
  delivery: evObject({ id: evUuid, status: evEnum("PENDING", "PROCESSING", "SUCCEEDED", "DEAD", "CANCELLED"), channel: evEnum("WHATSAPP", "EMAIL"), attemptCount: evInteger, receiptCount: evInteger,
    claimedAt: evNullable(evTime), leaseExpiresAt: evNullable(evTime), availableAt: evNullable(evTime), failure: evNullable(evCode), providerKind: evNullable(evEnum("SIMULATED_WHATSAPP", "SIMULATED_EMAIL")),
    referenceSha256: evNullable(hex), payloadHash: evNullable(hex), attempts: evArray(evObject({ number: evInteger, outcome: evText, failure: evNullable(evCode), deduplicated: evNullable(evBool), startedAt: evTime, completedAt: evNullable(evTime) }), 16) }),
  worker: evObject({ runId: evUuid, generation: evUuid, event: evEnum("consumer-close", "consumer-ready", "consumer-stopped", "abort-observed", "receipt-barrier", "lease-replay-proof", "phase", "concurrent-lock-proof", "retry-proof", "owned-process-quiescence"), slot: evNullable(evEnum("A", "B")),
    pid: evNullable(evInteger), exitCode: evNullable(value => Number.isInteger(value)), count: evNullable(evInteger), delayMs: evNullable(evInteger), backendPids: evArray(evInteger, 16),
    databaseClosed: evNullable(evBool), leaseMs: evNullable(evInteger), deduplicated: evNullable(evBool), outcomes: evArray(evEnum("ABANDONED", "SUCCESS"), 2),
    phase: evNullable(evEnum("park", "concurrent", "row-lock", "retry", "crash")), id: evNullable(evUuid) }),
  teardown: evObject({ complete: evBool, processesJoined: evBool, sqlQuiescence: evStatus, elapsedMs: evNumber, failures: evArray(evCode, 64) }),
  error: evObject({ primary: evNullable(evCode), secondary: evArray(evCode, 64), omissions: evArray(evCode, 64) }),
  approval: evObject({ manifestSha256: hex, artifactIdentitiesSha256: hex, diskBudgetSha256: hex, timeBudgetSha256: hex,
    purpose: evEnum("ARTIFACT_DISCOVERY", "QUALIFIED_WORKLOAD"), humanApprovalRequired: evEnum(true) }),
  artifacts: evObject({ nodeVersion: evEnum("24.14.1"), nodeArchiveSha256: hex, nodeSha256: hex, sourceFreeze: hex,
    baseReference: image, baseConfig: value => /^sha256:[a-f0-9]{64}$/u.test(value), initSha256: hex, tarSha256: hex, dockerSha256: hex, xzSha256: hex,
    osFiles: evArray(evObject({ pathSha256: hex, sha256: hex }), 128), seccompSha256: hex, prismaEngineCommit: value => /^[a-f0-9]{40}$/u.test(value),
    prismaGzipSha256: hex, prismaBinarySha256: hex, prismaHelpersSha256: hex }),
  image: evObject({ artifactId: value => /^sha256:[a-f0-9]{64}$/u.test(value), diffIds: evArray(value => /^sha256:[a-f0-9]{64}$/u.test(value), 128), sourceFreeze: hex,
    archiveSha256: hex, archiveBytes: evInteger, profileSha256: hex, preparationAttempt: evUuid }),
  "preparation-resources": evObject({ phase: evEnum("before-build", "after-build", "after-image-cleanup"), engineId: evText, containers: evArray(hex, 256), networks: evArray(hex, 256), volumeNameHashes: evArray(hex, 256), ownImageId: evNullable(value => /^sha256:[a-f0-9]{64}$/u.test(value)) }),
  "image-disposition": evObject({ imageId: value => /^sha256:[a-f0-9]{64}$/u.test(value), preparationAttempt: evUuid, removed: evBool }),
  release: evObject({ runId: evUuid, generation: evUuid, slot: evEnum("A", "B"), containerId: hex, joined: evBool, released: evBool, exitCode: evEnum(0) }),
  absence: evObject({ runId: evUuid, generation: evUuid, containers: evArray(hex, 128), networks: evArray(hex, 128),
    attempts: evArray(evObject({ id: evNullable(hex), attempt: evUuid, role: evEnum("backend", "frontend", "postgres", "haproxy", "worker-A", "worker-B"), owned: evBool, dispatched: evBool, removed: evBool }), 32), engineJoined: evBool }),
  lifecycle: evObject({ runId: evUuid, generation: evUuid, event: evEnum("attach-operation", "attach-event-observed", "attach-reconciled", "early-quiescence", "first-writer-fresh-guard", "application-processes-joined", "sql-live-quiescence", "resource-absence", "late-creation-reconciled", "teardown-failure"),
    role: evNullable(evText), attempt: evNullable(evUuid), resourceId: evNullable(hex), state: evNullable(evText), status: evNullable(evStatus), code: evNullable(evCode) }),
});

export function assertLinuxEvidenceRow(row) {
  linuxAssert(linuxExact(row, ["seq", "kind", "monotonicMs", "data"]) && Number.isSafeInteger(row.seq) && row.seq > 0 && evNumber(row.monotonicMs)
    && Object.hasOwn(evidenceSchemas, row.kind) && evidenceSchemas[row.kind](row.data), "LINUX_EVIDENCE_SCHEMA_REJECTED"); return row;
}
export function projectLinuxProcess(value) {
  const keys = ["pid", "parent", "startTicks", "state", "pidns", "netns", "mntns", "bootId", "executableSha256", "commandSha256", "cgroupSha256"];
  const result = Object.fromEntries(keys.map(key => [key, value[key]])); linuxAssert(evProcess(result), "LINUX_EVIDENCE_PROCESS_INVALID"); return result;
}
export function projectLinuxResource(value, { runId, generation, attempt, role }) {
  const security = value.HostConfig, options = security.SecurityOpt ?? [], seccomp = options.find(item => item.startsWith("seccomp="));
  return { runId, generation, attempt, role, id: value.Id, imageId: value.Image, created: value.Created, started: value.State.StartedAt || null, pid: value.State.Pid,
    running: value.State.Running, restartCount: value.RestartCount, oomKilled: value.State.OOMKilled, networkIds: Object.values(value.NetworkSettings.Networks).map(row => row.NetworkID).sort(),
    securitySha256: digest(JSON.stringify({ user: value.Config.User, host: { Privileged: security.Privileged, CapDrop: security.CapDrop, SecurityOpt: options, ReadonlyRootfs: security.ReadonlyRootfs,
      Dns: security.Dns, Memory: security.Memory, MemorySwap: security.MemorySwap, Tmpfs: security.Tmpfs, RestartPolicy: security.RestartPolicy } })),
    user: value.Config.User ?? "", privileged: Boolean(security.Privileged), readonlyRootfs: Boolean(security.ReadonlyRootfs), memory: security.Memory, memorySwap: security.MemorySwap,
    restartPolicy: security.RestartPolicy.Name, dns: security.Dns ?? [], noNewPrivileges: options.includes("no-new-privileges"), allCapabilitiesDropped: security.CapDrop?.includes("ALL") ?? false,
    seccompSha256: seccomp ? digest(seccomp.slice("seccomp=".length)) : null };
}
export function projectLinuxWorkerEvent(value, runId, generation) {
  const context = { runId, generation };
  if (value.event === "claim") return [{ kind: "claim", data: { ...context, slot: value.slot, rows: value.rows.map(row => ({ id: row.id, lease: row.lease })) } }];
  if (value.event === "receipt-observed") return [{ kind: "receipt", data: { ...context, slot: value.slot, id: value.id, referenceSha256: digest(value.reference), payloadHash: value.payloadHash } }];
  if (["consumer-close", "consumer-ready", "consumer-stopped", "abort-observed", "receipt-barrier", "lease-replay-proof", "phase", "concurrent-lock-proof", "retry-proof", "owned-process-quiescence"].includes(value.event)) return [{ kind: "worker", data: { ...context, event: value.event,
    slot: value.slot ?? null, pid: value.pid ?? null, exitCode: value.code ?? null, count: value.count ?? value.consumers ?? value.rootsJoined ?? value.attempts ?? null,
    delayMs: value.delayMs ?? null, backendPids: value.backendPids ?? [], databaseClosed: value.databaseClosed ?? null, leaseMs: value.leaseMs ?? null,
    deduplicated: value.deduplicated ?? null, outcomes: value.outcomes ?? [], phase: value.phase ?? null, id: value.id ?? null } }];
  return [];
}
export function createLinuxWorkloadAdmission({ plan, observed, manifestSha256, authorized, schedule, record }) {
  linuxAssert(authorized === true && plan.purpose === "QUALIFIED_WORKLOAD" && plan.diskBudget.basis === "MEASURED_APPROVED", "LINUX_WORKLOAD_NOT_AUTHORIZED");
  const proof = assertLinuxApprovalBinding(plan, observed, manifestSha256, "QUALIFIED_WORKLOAD");
  schedule.admit("bootstrap");
  const result = Object.freeze({ mode: "QUALIFIED_WORKLOAD", schedule, proof, record,
    assertPhase(name) { return schedule.admit(name); } }); workloadAdmissions.add(result); return result;
}
export function createLinuxEvidence(directory, initialIdentity, { now = linuxAdmissionNow, resume = false } = {}) {
  linuxAssert(evIdentity(initialIdentity), "LINUX_EVIDENCE_IDENTITY_INVALID");
  mkdirSync(directory, { recursive: true, mode: 0o700 }); const path = join(directory, "observations.ndjson"), identityPath = join(directory, "identity.json");
  const directoryInfo = lstatSync(directory); linuxAssert(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(), "LINUX_EVIDENCE_DIRECTORY_INVALID");
  let sequence = 0, bytes = 0, identity = initialIdentity;
  if (resume) {
    for (const file of [identityPath, path]) { const metadata = lstatSync(file); linuxAssert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, "LINUX_EVIDENCE_FILE_REJECTED"); }
    const previous = parseLinuxJson(readFileSync(identityPath)); linuxAssert(evIdentity(previous) && JSON.stringify(previous) === JSON.stringify(initialIdentity), "LINUX_EVIDENCE_RESUME_MISMATCH");
    const old = readFileSync(path); linuxAssert(old.length <= EVIDENCE_POLICY.rawBytes, "LINUX_EVIDENCE_LIMIT"); bytes = old.length;
    for (const line of old.toString("utf8").split("\n").filter(Boolean)) { const row = assertLinuxEvidenceRow(parseLinuxJson(Buffer.from(line))); linuxAssert(row.seq === ++sequence, "LINUX_EVIDENCE_SEQUENCE"); }
  } else { writeFileSync(identityPath, JSON.stringify(identity) + "\n", { flag: "wx", mode: 0o600 }); writeFileSync(path, "", { flag: "wx", mode: 0o600 }); }
  return Object.freeze({
    identity() { return identity; },
    bind(changes) {
      const next = { ...identity, ...changes };
      linuxAssert(evIdentity(next) && Object.keys(changes).every(key => ["tree", "sourceFreeze", "workflowSha256", "runner"].includes(key)), "LINUX_EVIDENCE_IDENTITY_INVALID");
      for (const key of ["tree", "sourceFreeze", "workflowSha256"]) linuxAssert(identity[key] === null || identity[key] === next[key], "LINUX_EVIDENCE_IDENTITY_CHANGED");
      identity = next; writeFileSync(identityPath, JSON.stringify(identity) + "\n", { mode: 0o600 });
    },
    record(kind, data) {
      const row = assertLinuxEvidenceRow({ seq: sequence + 1, kind, monotonicMs: now(), data }); const line = JSON.stringify(row) + "\n";
      linuxAssert(sequence < EVIDENCE_POLICY.rows && bytes + Buffer.byteLength(line) <= EVIDENCE_POLICY.rawBytes, "LINUX_EVIDENCE_LIMIT");
      appendFileSync(path, line, { mode: 0o600 }); sequence++; bytes += Buffer.byteLength(line);
    },
    outcome(value) { linuxAssert(evOutcome(value), "LINUX_EVIDENCE_OUTCOME_INVALID"); writeFileSync(join(directory, "outcome.json"), JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); },
  });
}

export function validateLinuxEvidenceMembers(entries) {
  const expected = ["identity.json", "observations.ndjson", "outcome.json"];
  linuxAssert(Array.isArray(entries) && entries.length === expected.length && new Set(entries.map(row => row.name)).size === entries.length
    && entries.every(row => expected.includes(row.name) && linuxExact(row, ["name", "bytes", "sha256"]) && evInteger(row.bytes) && hex(row.sha256)), "LINUX_EVIDENCE_MEMBER_REJECTED"); return entries;
}
function evidenceTar(entries) {
  const parts = [];
  for (const row of entries) {
    const header = Buffer.alloc(512); header.write(row.name); header.write("0000600\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(row.data.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136); header.fill(32, 148, 156); header[156] = 48;
    header.write("ustar\0", 257); header.write("00", 263); header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, row.data, Buffer.alloc((512 - row.data.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024)); return Buffer.concat(parts);
}
export async function packageLinuxEvidence(directory, destination, { maximumBytes = EVIDENCE_POLICY.compressedBytes } = {}) {
  linuxAssert(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= EVIDENCE_POLICY.compressedBytes, "LINUX_EVIDENCE_LIMIT");
  const directoryInfo = await lstat(directory); linuxAssert(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink(), "LINUX_EVIDENCE_DIRECTORY_INVALID");
  const names = await readdir(directory); linuxAssert(names.sort().join() === ["identity.json", "observations.ndjson", "outcome.json"].sort().join(), "LINUX_EVIDENCE_UNEXPECTED_FILE");
  const entries = []; let bytes = 0;
  for (const name of names) {
    const path = join(directory, name), before = await lstat(path);
    linuxAssert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size + bytes <= EVIDENCE_POLICY.rawBytes
      && await realpath(path) === join(await realpath(directory), name), "LINUX_EVIDENCE_FILE_REJECTED");
    const file = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)); let data;
    try { const opened = await file.stat(); linuxAssert(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, "LINUX_EVIDENCE_FILE_CHANGED"); data = await file.readFile();
      const after = await file.stat(); linuxAssert(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino, "LINUX_EVIDENCE_FILE_CHANGED"); }
    finally { await file.close(); }
    if (name === "identity.json") linuxAssert(evIdentity(parseLinuxJson(data)), "LINUX_EVIDENCE_IDENTITY_INVALID");
    else if (name === "outcome.json") linuxAssert(evOutcome(parseLinuxJson(data)), "LINUX_EVIDENCE_OUTCOME_INVALID");
    else { let seq = 0; for (const line of data.toString("utf8").split("\n").filter(Boolean)) { const row = assertLinuxEvidenceRow(parseLinuxJson(Buffer.from(line))); linuxAssert(row.seq === ++seq && seq <= EVIDENCE_POLICY.rows, "LINUX_EVIDENCE_SEQUENCE"); } }
    bytes += data.length; entries.push({ name, data });
  }
  const members = validateLinuxEvidenceMembers(entries.map(row => ({ name: row.name, bytes: row.data.length, sha256: digest(row.data) })));
  const manifest = Buffer.from(JSON.stringify({ v: 1, members }) + "\n");
  let archive; try { archive = gzipSync(evidenceTar([...entries, { name: "members.json", data: manifest }]), { level: 1, maxOutputLength: maximumBytes }); }
  catch { throw new LinuxSafetyError("LINUX_EVIDENCE_COMPRESSED_LIMIT"); }
  linuxAssert(archive.length <= maximumBytes, "LINUX_EVIDENCE_COMPRESSED_LIMIT");
  await writeFile(destination, archive, { flag: "wx", mode: 0o600 });
  return { path: destination, bytes: archive.length, sha256: digest(archive), manifestSha256: digest(manifest), members, retentionDays: EVIDENCE_POLICY.days };
}
export function linuxToolQuiescence() {
  return { verified: [...toolProcesses].every(row => row.joined && row.treeVerified && !row.failure && !row.stopFailure) && [...artifactTransfers].every(row => row.joined && !row.failure),
    artifactTransfers: [...artifactTransfers].map(row => ({ joined: row.joined, failure: row.failure })),
    processes: [...toolProcesses].map(row => ({ pid: row.pid, executableSha256: row.executableSha256, birth: row.birth, joined: row.joined, treeVerified: row.treeVerified, failure: row.failure, failureObservation: row.failureObservation ?? null })) };
}
export function handoffLinuxRuntime({ node, args, environment, quiescence = linuxToolQuiescence(), execute = process.execve }) {
  linuxAssert(quiescence.verified === true && typeof execute === "function" && isAbsolute(node) && Array.isArray(args)
    && args[0] === fileURLToPath(import.meta.url) && ["--qualified-job", "--discovery-job"].includes(args[1]) && Object.values(environment).every(value => typeof value === "string"), "LINUX_RUNTIME_HANDOFF_NOT_SAFE");
  // This is PREPARATION ONLY: no PostgreSQL, worker or application authority
  // exists. POSIX execve replaces the bootstrap; it is not a second controller.
  execute(node, [node, ...args], environment);
  throw new LinuxSafetyError("LINUX_RUNTIME_HANDOFF_RETURNED");
}

async function observeToolTree(child, row, closed, stopObserving, profiles = [], requiredProfiles = []) {
  const root = await readLinuxProcess(child.pid); row.birth = root.startTicks;
  linuxAssert(root.executableSha256 === row.executableSha256 && root.parent === process.pid, "LINUX_TOOL_PROCESS_IDENTITY");
  const helpers = new Map(); let drainStarted;
  while (!stopObserving()) {
    const names = (await readdir("/proc")).filter(name => /^[1-9][0-9]*$/u.test(name)); linuxAssert(names.length <= 4096, "LINUX_TOOL_CENSUS_LIMIT");
    const stats = (await Promise.all(names.map(async name => { try { return parseLinuxStat(await readFile(`/proc/${name}/stat`, "utf8")); } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; } }))).filter(Boolean);
    if (!closed()) {
      const current = stats.find(value => value.pid === root.pid);
      linuxAssert(current && current.startTicks === root.startTicks && current.parent === root.parent, "LINUX_TOOL_PROCESS_INSTANCE_CHANGED");
    }
    for (const value of stats.filter(value => value.parent === root.pid || helpers.has(value.pid) || helpers.has(value.parent))) {
      const observed = await readLinuxProcess(value.pid), old = helpers.get(value.pid);
      let valid = true; try { assertLinuxToolDescendant(observed, root, profiles, old, closed()); } catch { valid = false; }
      if (!valid) row.failureObservation ??= { processId: observed.pid, parentProcessId: observed.parent, startTicks: observed.startTicks, executableSha256: observed.executableSha256,
        failedPredicate: "TOOL_DESCENDANT_IDENTITY_OR_PARENT_NOT_ALLOWED", rejectionReasonCode: "LINUX_UNKNOWN_TOOL_DESCENDANT" };
      linuxAssert(valid, "LINUX_UNKNOWN_TOOL_DESCENDANT");
      helpers.set(observed.pid, observed);
      row.helpers = [...helpers.values()];
    }
    if (closed()) {
      const residual = [...helpers.values()].some(known => stats.some(current => current.pid === known.pid && current.startTicks === known.startTicks));
      if (!residual) {
        linuxAssert(requiredProfiles.every(profile => [...helpers.values()].some(value => value.executable === profile.path && value.executableSha256 === profile.sha256
          && value.commandSha256 === profile.commandSha256)), "LINUX_REQUIRED_TOOL_HELPER_NOT_OBSERVED");
        row.treeVerified = true; return;
      }
      drainStarted ??= performance.now(); linuxAssert(performance.now() - drainStarted < 5000, "LINUX_TOOL_HELPER_JOIN_FAILED");
    }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new LinuxSafetyError("LINUX_TOOL_JOIN_FAILED");
}
export function assertLinuxArtifactPlan(value, bytes, approvalSha256) {
  linuxAssert(hex(approvalSha256) && digest(bytes) === approvalSha256, "LINUX_ARTIFACT_APPROVAL_MISSING");
  linuxAssert(JSON.stringify(value) === JSON.stringify(parseLinuxJson(bytes)), "LINUX_ARTIFACT_PLAN_INVALID");
  const fields = ["v", "platform", "nodeVersion", "nodeArchiveSha256", "nodeSha256", "sourceFreeze", "baseReference", "baseConfig", "init", "tools", "osFiles", "workerSeccomp", "prisma", "diskAdmissionMiB"];
  linuxAssert(linuxExact(value, value?.v === 2 ? [...fields, "purpose", "binding", "preparation", "diskBudget", "timeBudget"] : fields)
    && [1, 2].includes(value.v) && value.platform === "linux/amd64" && value.nodeVersion === "24.14.1" && value.nodeArchiveSha256 === LINUX_NODE_ARCHIVE_SHA256
    && hex(value.nodeSha256) && hex(value.sourceFreeze) && image(value.baseReference) && /^sha256:[a-f0-9]{64}$/u.test(value.baseConfig)
    && linuxExact(value.init, ["path", "sha256"]) && value.init.path === "/sbin/docker-init" && hex(value.init.sha256)
    && linuxExact(value.tools, ["tar", "docker"]) && Object.values(value.tools).every(hex)
    && Number.isSafeInteger(value.diskAdmissionMiB) && value.diskAdmissionMiB > 0, "LINUX_ARTIFACT_PLAN_INVALID");
  linuxAssert(value.osFiles && Object.keys(value.osFiles).length >= 2 && Object.keys(value.osFiles).length <= 128
    && Object.entries(value.osFiles).every(([path, hash]) => /^\/(?:usr\/)?lib\//u.test(path) && !path.includes("..") && hex(hash)), "LINUX_OS_CLOSURE_UNQUALIFIED");
  linuxAssert(value.workerSeccomp?.defaultAction === "SCMP_ACT_ERRNO" && Array.isArray(value.workerSeccomp.syscalls) && value.workerSeccomp.syscalls.length > 0
    && value.workerSeccomp.architectures?.join() === "SCMP_ARCH_X86_64" && Buffer.byteLength(JSON.stringify(value.workerSeccomp)) < 65536, "LINUX_SECCOMP_UNQUALIFIED");
  linuxAssert(linuxExact(value.prisma, ["engineCommit", "gzipSha256", "binarySha256", "helpers"]) && /^[a-f0-9]{40}$/u.test(value.prisma.engineCommit)
    && hex(value.prisma.gzipSha256) && hex(value.prisma.binarySha256) && linuxExact(value.prisma.helpers, ["generate", "migrate"]), "LINUX_PRISMA_ARTIFACT_UNQUALIFIED");
  for (const profiles of Object.values(value.prisma.helpers)) {
    linuxAssert(Array.isArray(profiles) && profiles.length <= 3, "LINUX_PRISMA_HELPER_PROFILE_INVALID");
    for (const helper of profiles) {
      linuxAssert((helper.kind === "SCHEMA_ENGINE" && linuxExact(helper, ["kind", "args"]) || helper.kind === "NODE_GENERATOR" && linuxExact(helper, ["kind", "args", "entry", "entrySha256"])
        && /^node_modules\/(?:prisma|@prisma\/(?:client|engines))\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js)$/u.test(helper.entry) && !helper.entry.includes("..") && hex(helper.entrySha256))
        && Array.isArray(helper.args) && helper.args.length <= 32 && helper.args.every(arg => typeof arg === "string" && arg.length <= 512 && !arg.includes("\0") && !arg.includes("://"))
        && (helper.kind !== "NODE_GENERATOR" || helper.args[0] === "$ENTRY"), "LINUX_PRISMA_HELPER_PROFILE_INVALID");
    }
  }
  if (value.v === 2) {
    // V1 is still recognized as the historical 14-field contract. Runtime
    // admission requires this explicit V2; new fields are never hidden in V1.
    linuxAssert(["ARTIFACT_DISCOVERY", "QUALIFIED_WORKLOAD"].includes(value.purpose), "LINUX_PLAN_PURPOSE_INVALID");
    const binding = value.binding;
    linuxAssert(linuxExact(binding, ["repository", "commit", "tree", "workflowSha256", "runnerProfile", "bootstrapIdentity", "provenance"])
      && binding.repository === "TommyGiacopini/piccadilly-booking" && /^[a-f0-9]{40}$/u.test(binding.commit) && /^[a-f0-9]{40}$/u.test(binding.tree)
      && hex(binding.workflowSha256) && linuxExact(binding.runnerProfile, ["os", "arch", "image", "imageVersion", "engineVersion"])
      && binding.runnerProfile.os === "Linux" && binding.runnerProfile.arch === "X64" && binding.runnerProfile.image === "ubuntu-24.04"
      && /^[A-Za-z0-9._-]{1,100}$/u.test(binding.runnerProfile.imageVersion) && /^[0-9.]{3,40}$/u.test(binding.runnerProfile.engineVersion)
      && linuxExact(binding.bootstrapIdentity, ["version", "sha256"]) && /^\d+\.\d+\.\d+$/u.test(binding.bootstrapIdentity.version) && hex(binding.bootstrapIdentity.sha256)
      && linuxExact(binding.provenance, ["nodeReleaseProofSha256", "baseImageProofSha256", "prismaReleaseProofSha256"]) && Object.values(binding.provenance).every(hex), "LINUX_APPROVAL_BINDING_INVALID");
    const preparation = value.preparation;
    linuxAssert(linuxExact(preparation, ["xz", "contextMaximumBytes", "imageArchiveMaximumBytes"]) && linuxExact(preparation.xz, ["path", "sha256", "argv0", "args"])
      && preparation.xz.path === "/usr/bin/xz" && hex(preparation.xz.sha256) && ["xz", "/usr/bin/xz"].includes(preparation.xz.argv0)
      && Array.isArray(preparation.xz.args) && preparation.xz.args.length > 0 && preparation.xz.args.length <= 8
      && preparation.xz.args.every(arg => typeof arg === "string" && /^--?[A-Za-z0-9=-]{1,40}$/u.test(arg))
      && [preparation.contextMaximumBytes, preparation.imageArchiveMaximumBytes].every(item => Number.isSafeInteger(item) && item > 0), "LINUX_XZ_PROFILE_INCOMPLETE");
    assertLinuxDiskBudget(value.diskBudget);
    linuxAssert(value.purpose !== "QUALIFIED_WORKLOAD" || value.diskBudget.basis === "MEASURED_APPROVED", "LINUX_WORKLOAD_DISK_NOT_APPROVED");
    linuxAssert(linuxExact(value.timeBudget, Object.keys(ADMISSION_PHASE_SECONDS)) && Object.entries(ADMISSION_PHASE_SECONDS).every(([key, seconds]) => value.timeBudget[key] === seconds), "LINUX_TIME_BUDGET_INVALID");
  }
  return value;
}

export function assertLinuxApprovalBinding(plan, observed, manifestSha256, mode) {
  linuxAssert(plan.v === 2 && hex(manifestSha256) && plan.purpose === mode && ["ARTIFACT_DISCOVERY", "QUALIFIED_WORKLOAD"].includes(mode), "LINUX_MODE_AUTHORITY_MISMATCH");
  const binding = plan.binding;
  linuxAssert(observed.repository === binding.repository && observed.commit === binding.commit && observed.tree === binding.tree
    && observed.sourceFreeze === plan.sourceFreeze && observed.workflowSha256 === binding.workflowSha256
    && Object.entries(binding.runnerProfile).every(([key, value]) => observed.runnerProfile?.[key] === value)
    && Object.entries(binding.bootstrapIdentity).every(([key, value]) => observed.bootstrapIdentity?.[key] === value), "LINUX_APPROVAL_BINDING_MISMATCH");
  return { ...observed, manifestSha256, purpose: mode, artifactIdentitiesSha256: digest(JSON.stringify({ node: plan.nodeSha256, base: plan.baseReference, config: plan.baseConfig,
    init: plan.init, tools: plan.tools, os: plan.osFiles, seccomp: plan.workerSeccomp, prisma: plan.prisma, preparation: plan.preparation })),
    diskBudgetSha256: digest(JSON.stringify(plan.diskBudget)), timeBudgetSha256: digest(JSON.stringify(plan.timeBudget)), approvalModel: "HUMAN_WORK3_CLASSIC3_REQUIRED_NOT_CRYPTOGRAPHIC_SIGNATURE" };
}

export function assertLinuxToolDescendant(observed, root, profiles, previous, rootClosed) {
  const valid = profiles.some(helper => observed.executable === helper.path && observed.executableSha256 === helper.sha256 && observed.commandSha256 === helper.commandSha256)
    && observed.pidns === root.pidns && observed.netns === root.netns && observed.mntns === root.mntns && observed.bootId === root.bootId && !["Z", "X"].includes(observed.state)
    && (!previous ? !rootClosed && observed.parent === root.pid : previous.startTicks === observed.startTicks && [root.pid, 1].includes(observed.parent));
  linuxAssert(valid, "LINUX_UNKNOWN_TOOL_DESCENDANT"); return observed;
}

async function prismaHelpers(plan, role, root, node, config) {
  const profiles = [];
  for (const helper of plan.prisma.helpers[role]) {
    const path = helper.kind === "SCHEMA_ENGINE" ? join(root, "node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x") : node;
    const entryPath = helper.kind === "NODE_GENERATOR" ? join(root, helper.entry) : null;
    if (entryPath) linuxAssert((await lstat(entryPath)).isFile() && !(await lstat(entryPath)).isSymbolicLink() && await realpath(entryPath) === resolve(entryPath)
      && digest(await readFile(entryPath)) === helper.entrySha256, "LINUX_PRISMA_GENERATOR_CHANGED");
    const args = helper.args.map(arg => arg.replaceAll("$ROOT", root).replaceAll("$ENTRY", entryPath ?? "").replaceAll("$CONFIG", config));
    const sha256 = helper.kind === "SCHEMA_ENGINE" ? plan.prisma.binarySha256 : plan.nodeSha256;
    linuxAssert(digest(await readFile(path)) === sha256, "LINUX_PRISMA_EXECUTABLE_CHANGED");
    profiles.push({ path, sha256, commandSha256: digest(Buffer.from([path, ...args].join("\0") + "\0")), entryPath, entrySha256: helper.entrySha256 ?? null });
  }
  return profiles;
}

export function decodeDockerFrames(onStdout, onStderr, failure) {
  let buffer = Buffer.alloc(0), failed = false;
  return {
    push(bytes) {
      if (failed) return;
      try {
        buffer = Buffer.concat([buffer, bytes]); linuxAssert(buffer.length <= 131072, "LINUX_DOCKER_FRAME_LIMIT");
        while (buffer.length >= 8) {
          const size = buffer.readUInt32BE(4), stream = buffer[0];
          linuxAssert([1, 2].includes(stream) && buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 0 && size <= 65536, "LINUX_DOCKER_FRAME_INVALID");
          if (buffer.length < size + 8) break;
          const payload = buffer.subarray(8, 8 + size); buffer = buffer.subarray(8 + size);
          (stream === 1 ? onStdout : onStderr)(payload);
        }
      } catch (error) { failed = true; failure(error); }
    },
    end() { if (buffer.length) failure(new LinuxSafetyError("LINUX_DOCKER_FRAME_TRUNCATED")); },
  };
}

// The Engine adapter has one literal local socket. Neither DOCKER_HOST nor a
// context/environment override can redirect requests to a remote daemon.
export async function createLinuxEngine({ socket = "/var/run/docker.sock", synthetic = false, request = httpRequest, inspectSocket = lstat } = {}) {
  linuxAssert(synthetic || process.platform === "linux" && process.arch === "x64", "LINUX_CONTROLLER_PLATFORM");
  linuxAssert(socket === "/var/run/docker.sock", "LINUX_REMOTE_ENGINE_FORBIDDEN");
  const original = await inspectSocket(socket);
  linuxAssert(original.isSocket() && original.uid === 0 && !original.isSymbolicLink(), "LINUX_ENGINE_SOCKET_IDENTITY");
  let engineId; const requests = new Set();
  const requestOwners = new WeakSet();
  const registerRequestOwner = authority => {
    if (!authority || requestOwners.has(authority)) return;
    authority.registerChannel({ joined: () => [...requests].filter(row => row.owner === authority).every(row => ["JOINED", "NOT_DISPATCHED"].includes(row.state)),
      stop() { for (const row of requests) if (row.owner === authority && row.state === "ACTIVE") row.abort?.(); } }); requestOwners.add(authority);
  };
  const check = async () => {
    const current = await inspectSocket(socket);
    linuxAssert(current.isSocket() && current.dev === original.dev && current.ino === original.ino && current.uid === original.uid, "LINUX_ENGINE_SOCKET_CHANGED");
  };
  const call = async (method, path, body, { timeoutMs = 15000, signal, binary = false, headers = {}, beforeDispatch = () => {}, bodyFile, responseFile } = {}) => {
    const authority = preparationScope.getStore(); authority?.assert(); signal ??= authority?.signal;
    linuxAssert(["GET", "POST", "PUT", "DELETE"].includes(method) && path.startsWith("/") && !path.includes("\n"), "LINUX_ENGINE_REQUEST_INVALID");
    await check();
    registerRequestOwner(authority); const row = { method, state: "NOT_DISPATCHED", owner: authority }; requests.add(row);
    const payload = bodyFile ? null : body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    linuxAssert(!bodyFile || isAbsolute(bodyFile.path) && Number.isSafeInteger(bodyFile.bytes) && bodyFile.bytes > 0, "LINUX_ENGINE_BODY_INVALID");
    linuxAssert(!responseFile || isAbsolute(responseFile.path) && Number.isSafeInteger(responseFile.maximum) && responseFile.maximum > 0, "LINUX_ENGINE_OUTPUT_INVALID");
    return new Promise((done, reject) => {
      let finished = false, response, input, output, bytes = 0; const chunks = [], responseHash = createHash("sha256");
      const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); if (error) reject(error); else done(value); };
      beforeDispatch(); authority?.assertEngineDispatch(method, path); linuxAssert(!signal?.aborted, "P1C_ABORTED");
      const req = request({ socketPath: socket, path: "/v1.47" + path, method, headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}), ...(bodyFile ? { "Content-Length": bodyFile.bytes } : {}), ...headers } });
      row.state = "ACTIVE";
      const abort = () => { req.destroy(); response?.destroy(); input?.destroy(); output?.destroy(); finish(new LinuxSafetyError(signal?.aborted ? "P1C_ABORTED" : "LINUX_ENGINE_TIMEOUT")); };
      row.abort = abort;
      const timer = setTimeout(abort, Math.max(1, Math.min(timeoutMs, bodyFile || responseFile || binary ? 600000 : 30000)));
      signal?.addEventListener("abort", abort, { once: true });
      req.once("close", () => { row.state = "JOINED"; });
      req.once("error", () => finish(new LinuxSafetyError("LINUX_ENGINE_REQUEST_FAILED")));
      req.once("response", res => {
        response = res;
        if (responseFile && res.statusCode >= 200 && res.statusCode < 300) {
          output = createWriteStream(responseFile.path, { flags: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), mode: 0o600 });
          output.once("error", () => { abort(); }); output.on("drain", () => res.resume());
        }
        res.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > (responseFile?.maximum ?? 4 * 1024 ** 2)) { abort(); return; }
          if (output) { responseHash.update(chunk); if (!output.write(chunk)) res.pause(); } else chunks.push(chunk);
        });
        res.once("error", () => finish(new LinuxSafetyError("LINUX_ENGINE_RESPONSE_FAILED")));
        res.once("end", () => {
          try {
            linuxAssert(res.statusCode >= 200 && res.statusCode < 300, "LINUX_ENGINE_HTTP_" + res.statusCode);
            if (output) { output.once("close", () => finish(null, { responseComplete: true, bytes, sha256: responseHash.digest("hex") })); output.end(); return; }
            const data = Buffer.concat(chunks); finish(null, binary ? data : data.length ? parseLinuxJson(data, 4 * 1024 ** 2) : null);
          } catch (error) { finish(error instanceof LinuxSafetyError ? error : new LinuxSafetyError("LINUX_ENGINE_RESPONSE_INVALID")); }
        });
      });
      if (signal?.aborted) abort();
      else if (bodyFile) { input = createReadStream(bodyFile.path, { flags: fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0), highWaterMark: 65536 }); input.once("error", abort); input.pipe(req); }
      else req.end(payload);
    });
  };
  const verify = async () => {
    await check(); const info = await call("GET", "/info");
    linuxAssert(info.OSType === "linux" && ["x86_64", "amd64"].includes(info.Architecture) && typeof info.ID === "string" && info.ID.length > 5, "LINUX_ENGINE_IDENTITY");
    engineId ??= info.ID; linuxAssert(info.ID === engineId, "LINUX_ENGINE_CHANGED"); return info;
  };
  await verify();
  const engine = Object.freeze({ call, verify, get id() { return engineId; }, socketIdentity: { device: original.dev, inode: original.ino, uid: original.uid },
    joined: () => [...requests].every(row => ["JOINED", "NOT_DISPATCHED"].includes(row.state)),
    abortRequests() { for (const row of requests) if (row.state === "ACTIVE") row.abort?.(); },
    async watch(runId, receive, failure, { beforeDispatch = () => {} } = {}) {
      linuxAssert(/^[a-f0-9-]{36}$/u.test(runId), "LINUX_EVENT_CONTEXT_INVALID"); await check();
      return new Promise((done, reject) => {
        const filters = encodeURIComponent(JSON.stringify({ label: ["piccadilly.run=" + runId] }));
        let released = false, stream, buffer = "", count = 0;
        const authority = preparationScope.getStore(); registerRequestOwner(authority); beforeDispatch(); authority?.assertEngineDispatch("GET", "/events");
        const row = { method: "EVENTS", state: "ACTIVE", owner: authority }; requests.add(row);
        const req = request({ socketPath: socket, method: "GET", path: "/v1.47/events?filters=" + filters });
        row.abort = () => { released = true; req.destroy(); stream?.destroy(); };
        const startup = setTimeout(() => { req.destroy(); reject(new LinuxSafetyError("LINUX_EVENT_STREAM_TIMEOUT")); }, 5000);
        const maximum = setTimeout(() => { req.destroy(); failure(new LinuxSafetyError("LINUX_EVENT_STREAM_DEADLINE")); }, 900000);
        req.once("error", () => { clearTimeout(startup); const error = new LinuxSafetyError("LINUX_EVENT_STREAM_FAILED"); reject(error); if (!released) failure(error); });
        req.once("close", () => { row.state = "JOINED"; clearTimeout(startup); clearTimeout(maximum); });
        req.once("response", res => {
          stream = res; clearTimeout(startup);
          if (res.statusCode !== 200) { req.destroy(); reject(new LinuxSafetyError("LINUX_EVENT_STREAM_FAILED")); return; }
          res.on("data", bytes => {
            try {
              buffer += bytes.toString("utf8"); linuxAssert(buffer.length <= 65536, "LINUX_EVENT_STREAM_LIMIT");
              let end; while ((end = buffer.indexOf("\n")) >= 0) {
                const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); linuxAssert(++count <= 20000, "LINUX_EVENT_STREAM_LIMIT");
                receive({ id: value.Actor?.ID, type: value.Type, action: value.Action?.split(":")[0], attempt: value.Actor?.Attributes?.["piccadilly.attempt"], execId: value.Actor?.Attributes?.execID });
              }
            } catch { failure(new LinuxSafetyError("LINUX_EVENT_STREAM_INVALID")); }
          });
          res.once("close", () => { if (!released) failure(new LinuxSafetyError("LINUX_EVENT_STREAM_LOST")); });
          done({ abort: row.abort, async close() { released = true; clearTimeout(maximum); const joined = new Promise(resolveClose => req.once("close", resolveClose)); req.destroy(); stream?.destroy(); if (row.state !== "JOINED") await linuxBounded(() => joined, 5000, "LINUX_EVENT_JOIN_FAILED"); } });
        }); req.end();
      });
    },
    async attach(id, receive, failure, { beforeDispatch = () => {} } = {}) {
      linuxAssert(hex(id), "LINUX_CONTAINER_IDENTITY"); await check();
      return new Promise((done, reject) => {
        const authority = preparationScope.getStore(); registerRequestOwner(authority); beforeDispatch(); authority?.assertEngineDispatch("POST", "/containers/" + id + "/attach");
        const req = request({ socketPath: socket, method: "POST", path: `/v1.47/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`, headers: { Connection: "Upgrade", Upgrade: "tcp" } });
        let socketHandle, released = false; const row = { method: "ATTACH", state: "ACTIVE", owner: authority }; requests.add(row);
        const timer = setTimeout(() => { req.destroy(); reject(new LinuxSafetyError("LINUX_ATTACH_TIMEOUT")); }, 5000);
        req.once("error", () => { clearTimeout(timer); reject(new LinuxSafetyError("LINUX_ATTACH_FAILED")); });
        req.once("close", () => { if (!socketHandle) row.state = "JOINED"; });
        req.once("response", res => { clearTimeout(timer); res.destroy(); reject(new LinuxSafetyError("LINUX_ATTACH_NOT_UPGRADED")); });
        req.once("upgrade", (res, stream, head) => {
          clearTimeout(timer); socketHandle = stream;
          row.abort = () => { released = true; stream.destroy(); };
          if (res.statusCode !== 101) { stream.destroy(); reject(new LinuxSafetyError("LINUX_ATTACH_NOT_UPGRADED")); return; }
          const frames = decodeDockerFrames(receive, () => failure(new LinuxSafetyError("LINUX_SUPERVISOR_STDERR")), failure);
          stream.on("data", bytes => frames.push(bytes)); if (head.length) frames.push(head);
          stream.once("error", () => failure(new LinuxSafetyError("LINUX_ATTACH_LOST")));
          stream.once("close", () => { row.state = "JOINED"; frames.end(); if (!released) failure(new LinuxSafetyError("LINUX_ATTACH_LOST")); });
          done({ write(packet) { linuxAssert(!stream.destroyed, "LINUX_ATTACH_LOST"); stream.write(JSON.stringify(packet) + "\n"); },
            expectClose() { released = true; },
            abort: row.abort,
            async close() { released = true; if (!socketHandle.destroyed) { const closed = new Promise(resolveClose => stream.once("close", resolveClose)); stream.end(); stream.destroy(); await linuxBounded(() => closed, 5000, "LINUX_ATTACH_JOIN_FAILED"); } },
          });
        }); req.end();
      });
    },
  });
  if (!synthetic) qualifiedLinuxEngines.add(engine); return engine;
}

export async function linuxSourceInventory(root, names) {
  linuxAssert(Array.isArray(names) && names.length > 0 && names.length <= 600 && new Set(names).size === names.length, "LINUX_SOURCE_INVENTORY_INVALID");
  const files = [];
  for (const name of [...names].sort()) {
    linuxAssert(typeof name === "string" && !isAbsolute(name) && !name.split(/[\\/]/u).includes("..") && !name.includes("\\") && !/(^|\/)\.env(?!\.example$)|(^|\/)\.git(?:\/|$)/u.test(name), "LINUX_SOURCE_PATH_REJECTED");
    const path = join(root, name), info = await lstat(path);
    linuxAssert(info.isFile() && !info.isSymbolicLink() && info.size <= 5 * 1024 ** 2 && await realpath(path) === resolve(await realpath(root), name), "LINUX_SOURCE_NOT_REGULAR");
    files.push({ name, sha256: digest(await readFile(path)) });
  }
  return { files, freeze: digest(JSON.stringify(files)) };
}

export async function fetchLinuxApproval(url, expectedSha256, destination) {
  linuxAssert(hex(expectedSha256) && /^https:\/\/github\.com\/TommyGiacopini\/piccadilly-booking\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.json$/u.test(url), "LINUX_ARTIFACT_URL_REJECTED");
  const data = await download(url, 512 * 1024); linuxAssert(digest(data) === expectedSha256, "LINUX_ARTIFACT_APPROVAL_MISSING");
  assertLinuxArtifactPlan(JSON.parse(data), data, expectedSha256); await writeFile(destination, data, { flag: "wx", mode: 0o600 });
}
export async function downloadLinuxArtifact(url, maximum, options = {}) {
  const authority = options.authority ?? preparationScope.getStore();
  if (!authority) return receiveLinuxArtifact(url, maximum, options);
  const operation = authority.register("DOWNLOAD", "https-artifact"), previous = new Set(artifactTransfers);
  return authority.track(operation, authority.dispatch(operation, async () => {
    try { return await receiveLinuxArtifact(url, maximum, { ...options, authority, signal: authority.signal }); }
    finally { authority.completeTransfer(operation, [...artifactTransfers].filter(row => !previous.has(row)).every(row => row.joined)); }
  }));
}
async function receiveLinuxArtifact(url, maximum, { request = httpsGet, timeoutMs = 60000, authority, signal } = {}) {
  linuxAssert(Number.isInteger(maximum) && maximum > 0 && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, "LINUX_DOWNLOAD_LIMIT");
  const deadline = performance.now() + timeoutMs;
  let current = new URL(url);
  for (let redirects = 0; redirects <= 3; redirects++) {
    linuxAssert(current.protocol === "https:" && ["github.com", "release-assets.githubusercontent.com", "nodejs.org", "binaries.prisma.sh"].includes(current.hostname) && !current.username && !current.password, "LINUX_DOWNLOAD_ORIGIN_REJECTED");
    linuxAssert(performance.now() < deadline, "LINUX_DOWNLOAD_TIMEOUT");
    const transfer = { joined: false, failure: null }; artifactTransfers.add(transfer);
    const result = await new Promise((done, reject) => {
      let req, response, requestClosed = false, responseClosed = true, ended = false, settled = false, value, joinTimer;
      const finish = () => {
        if (settled || !requestClosed || !responseClosed) return;
        settled = true; transfer.joined = true; clearTimeout(timer); clearTimeout(joinTimer); signal?.removeEventListener("abort", aborted);
        if (transfer.failure) reject(new LinuxSafetyError(transfer.failure));
        else if (ended) done(value); else { transfer.failure = "LINUX_DOWNLOAD_TRUNCATED"; reject(new LinuxSafetyError(transfer.failure)); }
      };
      const fail = code => {
        transfer.failure ??= code; req?.destroy(); response?.destroy();
        joinTimer ??= setTimeout(() => { if (!settled) { settled = true; clearTimeout(timer); reject(new LinuxSafetyError(transfer.failure)); } }, 5000);
        finish();
      };
      const aborted = () => fail(authority?.primary ?? "P1C_ABORTED");
      const timer = setTimeout(() => fail("LINUX_DOWNLOAD_TIMEOUT"), Math.max(1, deadline - performance.now()));
      try {
        authority?.assert(); linuxAssert(!signal?.aborted, "P1C_ABORTED");
        req = request(current, { agent: false }, res => {
          response = res; responseClosed = false; const chunks = []; let size = 0;
          res.once("close", () => { responseClosed = true; finish(); }); res.once("error", () => fail("LINUX_DOWNLOAD_FAILED"));
          res.on("data", chunk => { size += chunk.length; if (size > maximum) fail("LINUX_DOWNLOAD_LIMIT"); else chunks.push(chunk); });
          res.once("end", () => {
            ended = true;
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && typeof res.headers.location === "string") value = { location: res.headers.location };
            else if (res.statusCode === 200) value = { data: Buffer.concat(chunks) };
            else transfer.failure ??= "LINUX_DOWNLOAD_FAILED";
            finish();
          });
        });
        req.once("close", () => { requestClosed = true; finish(); }); req.once("error", () => fail("LINUX_DOWNLOAD_FAILED"));
        signal?.addEventListener("abort", aborted, { once: true }); if (signal?.aborted) aborted();
        req.setTimeout(Math.min(15000, timeoutMs), () => fail("LINUX_DOWNLOAD_TIMEOUT"));
      } catch { requestClosed = true; fail("LINUX_DOWNLOAD_FAILED"); }
    });
    authority?.assert(); if (result.data) return result.data; current = new URL(result.location, current);
  }
  throw new LinuxSafetyError("LINUX_DOWNLOAD_REDIRECT_LIMIT");
}
const download = downloadLinuxArtifact;

export async function runLinuxTool(executable, args, options = {}) {
  const authority = options.authority ?? preparationScope.getStore();
  if (authority) return authority.run("TOOL", "spawn-tool", operation => executeLinuxTool(executable, args, { ...options, signal: authority.signal, authority, operationId: operation.id }));
  return executeLinuxTool(executable, args, options);
}
async function executeLinuxTool(executable, args, { cwd, environment, timeoutMs = 60000, expectedSha256, beforeSpawn = () => {}, signal, allowedHelpers = [], requiredHelpers = [], authority, operationId = null,
  synthetic = false, readExecutable, spawnProcess } = {}) {
  linuxAssert((!readExecutable && !spawnProcess) || synthetic === true, "LINUX_SYNTHETIC_TOOL_ADAPTER_FORBIDDEN");
  linuxAssert(isAbsolute(executable) && hex(expectedSha256) && digest(await (readExecutable ?? readFile)(executable)) === expectedSha256, "LINUX_TOOL_NOT_QUALIFIED");
  const profiles = [...allowedHelpers];
  for (const helper of profiles) {
    linuxAssert(digest(await readFile(helper.path)) === helper.sha256 && (!helper.entryPath || digest(await readFile(helper.entryPath)) === helper.entrySha256), "LINUX_TOOL_HELPER_CHANGED");
  }
  if (args.includes("--import")) {
    linuxAssert(cwd && args.includes(join(cwd, "node_modules/tsx/dist/loader.mjs")) && args.includes(join(cwd, "prisma/seed.ts")), "LINUX_TOOL_ARGUMENTS_REJECTED");
    const path = join(cwd, "node_modules/@esbuild/linux-x64/bin/esbuild"), version = JSON.parse(await readFile(join(cwd, "node_modules/esbuild/package.json"), "utf8")).version;
    profiles.push({ path, sha256: digest(await readFile(path)), commandSha256: digest(Buffer.from([path, "--service=" + version, "--ping"].join("\0") + "\0")) });
  }
  return new Promise((done, reject) => {
    beforeSpawn(); authority?.assert(); linuxAssert(!signal?.aborted, "P1C_ABORTED");
    const child = (spawnProcess ?? spawn)(executable, args, { cwd, env: environment, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, primary, timer, closed = false, stopObserving = false;
    const row = { pid: child.pid, executableSha256: expectedSha256, birth: null, joined: false, treeVerified: false, failure: null, stopFailure: null, helpers: [], operationId, exitCode: null, exitObserved: false }; toolProcesses.add(row);
    let stopping, abortJoinTimer;
    const stopOwned = () => stopping ??= preparationScope.run(null, async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // Reconfirm the instance immediately before signalling this owned handle.
      const identityDeadline = performance.now() + 1000;
      while (row.birth === null && child.exitCode === null && child.signalCode === null && performance.now() < identityDeadline) await new Promise(done => setTimeout(done, 10));
      if (child.exitCode !== null || child.signalCode !== null) return;
      linuxAssert(row.birth !== null, "LINUX_TOOL_STOP_IDENTITY_MISSING");
      const current = await linuxBounded(() => readLinuxProcess(child.pid), 1000, "LINUX_TOOL_STOP_IDENTITY_MISSING");
      linuxAssert(current.pid === row.pid && current.startTicks === row.birth && current.parent === process.pid && current.executableSha256 === expectedSha256, "LINUX_TOOL_STOP_IDENTITY_MISMATCH");
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await new Promise(done => setTimeout(done, 250));
      if (child.exitCode === null && child.signalCode === null) {
        const fresh = await linuxBounded(() => readLinuxProcess(child.pid), 1000, "LINUX_TOOL_STOP_IDENTITY_MISSING");
        linuxAssert(fresh.startTicks === row.birth && fresh.executableSha256 === expectedSha256 && fresh.parent === process.pid, "LINUX_TOOL_STOP_IDENTITY_MISMATCH");
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }).catch(error => { row.stopFailure ??= codeOf(error); });
    if (authority && Number.isInteger(child.pid)) authority.registerTool(child, { pid: child.pid, executableSha256: expectedSha256, operationId }, { stop: stopOwned, joined: () => row.joined && row.treeVerified });
    const aborted = () => {
      primary ??= new LinuxSafetyError(authority?.primary ?? "P1C_ABORTED"); authority?.revoke(primary); void stopOwned();
      abortJoinTimer ??= setTimeout(() => {
        stopObserving = true; row.failure ??= "LINUX_TOOL_JOIN_FAILED"; clearTimeout(timer); clearTimeout(joined);
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); reject(primary);
      }, 5000);
    };
    signal?.addEventListener("abort", aborted, { once: true });
    const collect = data => { bytes += data.length; if (bytes > 4 * 1024 ** 2) { primary ??= new LinuxSafetyError("LINUX_TOOL_OUTPUT_LIMIT"); aborted(); } };
    for (const pipe of [child.stdout, child.stderr]) pipe.on("data", collect);
    child.once("error", () => { primary ??= new LinuxSafetyError("LINUX_TOOL_SPAWN_FAILED"); });
    child.once("exit", code => { row.exitObserved = true; row.exitCode = code; });
    const observation = preparationScope.run(null, () => observeToolTree(child, row, () => closed, () => stopObserving, profiles, requiredHelpers)).catch(error => {
      primary ??= error instanceof LinuxSafetyError ? error : new LinuxSafetyError("LINUX_TOOL_TREE_NOT_VERIFIED"); row.failure = primary.code; aborted();
    });
    timer = setTimeout(() => { primary ??= new LinuxSafetyError("LINUX_TOOL_TIMEOUT"); aborted(); }, timeoutMs);
    const joined = setTimeout(() => { stopObserving = true; row.failure = primary?.code ?? "LINUX_TOOL_JOIN_FAILED"; child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); reject(primary ?? new LinuxSafetyError("LINUX_TOOL_JOIN_FAILED")); }, timeoutMs + 5000);
    child.once("close", code => {
      closed = true; row.joined = true; clearTimeout(timer); clearTimeout(joined); clearTimeout(abortJoinTimer); signal?.removeEventListener("abort", aborted);
      void linuxBounded(() => observation, 5000, "LINUX_TOOL_HELPER_JOIN_FAILED").then(() => {
        row.failure = primary?.code ?? (code !== 0 ? "LINUX_TOOL_FAILED" : null);
        if (primary || code !== 0 || !row.treeVerified || row.failure || row.stopFailure || !row.exitObserved) reject(primary ?? new LinuxSafetyError(row.failure ?? row.stopFailure ?? (code !== 0 ? "LINUX_TOOL_FAILED" : "LINUX_TOOL_TREE_NOT_VERIFIED"))); else done({ exitCode: code, joined: true, identity: row });
      }).catch(error => { stopObserving = true; row.failure = primary?.code ?? error.code; reject(primary ?? error); });
    });
  });
}

// Pure build specification: no default tag, invented digest or unqualified init.
// The qualification manifest is an independently approved external artifact.
export function linuxImageSpecification(plan) {
  linuxAssert(image(plan.baseReference), "LINUX_BASE_IMAGE_UNQUALIFIED");
  return `FROM ${plan.baseReference}\nCOPY runtime/ /usr/local/\nCOPY app/ /app/\nWORKDIR /app\nUSER 10001:10001\nENTRYPOINT [\"/usr/local/bin/node\",\"/app/scripts/m13-p1-worker-linux-entry.mjs\"]\nCMD []\n`;
}

export async function measureLinuxPreparation(engine, evidenceDirectory, stage, paths, logicalPaths = {}) {
  const info = await engine.verify(), usage = await engine.call("GET", "/system/df"), filesystems = [], logical = {};
  for (const [category, path] of Object.entries({ ...paths, docker: info.DockerRootDir })) {
    const value = await statfs(path); filesystems.push({ category, availableBytes: value.bavail * value.bsize, totalBytes: value.blocks * value.bsize });
  }
  let entries = 0;
  const size = async path => {
    const info = await lstat(path); linuxAssert(++entries <= 200000, "LINUX_STORAGE_INVENTORY_LIMIT");
    if (!info.isDirectory() || info.isSymbolicLink()) return info.size;
    let bytes = 0; for (const name of await readdir(path)) bytes += await size(join(path, name)); return bytes;
  };
  for (const [category, path] of Object.entries(logicalPaths)) logical[category] = await size(path);
  const value = { stage, measuredAt: new Date().toISOString(), engineId: info.ID, filesystems, logicalBytes: logical,
    layersBytes: usage.LayersSize, images: (usage.Images ?? []).map(row => ({ id: row.Id, size: row.Size, sharedSize: row.SharedSize })),
    containers: (usage.Containers ?? []).map(row => ({ id: row.Id, writableBytes: row.SizeRw, rootBytes: row.SizeRootFs })),
    volumes: (usage.Volumes ?? []).map(row => ({ name: row.Name, size: row.UsageData?.Size ?? null })),
    buildCacheBytes: (usage.BuildCache ?? []).reduce((sum, row) => sum + row.Size, 0),
    note: "Logical directory sizes and Engine layer accounting are distinct; global changes are not attributed exclusively to this run." };
  await writeFile(join(evidenceDirectory, "storage-" + stage + ".json"), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); return value;
}

// Engine API v1.47 lists containers/networks as arrays, but wraps volumes in
// an object. Missing/null inventories are never evidence of resource absence.
export function assertLinuxPreparationCensus(containers, networks, volumeResult) {
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  const ids = (rows, key, valid) => {
    linuxAssert(Array.isArray(rows) && rows.length <= 1024, "LINUX_PREPARATION_CENSUS_INVALID");
    const result = [];
    for (const row of rows) {
      linuxAssert(object(row) && Object.hasOwn(row, key) && valid(row[key]), "LINUX_PREPARATION_CENSUS_INVALID");
      result.push(row[key]);
    }
    linuxAssert(new Set(result).size === result.length, "LINUX_PREPARATION_CENSUS_AMBIGUOUS"); return result.sort();
  };
  linuxAssert(object(volumeResult) && Object.hasOwn(volumeResult, "Volumes") && Array.isArray(volumeResult.Volumes), "LINUX_PREPARATION_CENSUS_INVALID");
  if (Object.hasOwn(volumeResult, "Warnings")) linuxAssert(volumeResult.Warnings === null || Array.isArray(volumeResult.Warnings) && volumeResult.Warnings.length === 0, "LINUX_PREPARATION_CENSUS_INCOMPLETE");
  return { containers: ids(containers, "Id", hex), networks: ids(networks, "Id", hex),
    volumes: ids(volumeResult.Volumes, "Name", value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u.test(value)) };
}
export async function readLinuxPreparationResources(engine) {
  const [containers, networks, volumes] = await Promise.all([engine.call("GET", "/containers/json?all=1"), engine.call("GET", "/networks"), engine.call("GET", "/volumes")]);
  return assertLinuxPreparationCensus(containers, networks, volumes);
}

export async function prepareLinuxImage({ root, evidenceDirectory, manifestPath, approvalSha256, sourceNames, record, authority = preparationScope.getStore() }) {
  linuxAssert(process.platform === "linux" && process.arch === "x64", "LINUX_CONTROLLER_PLATFORM");
  linuxAssert(authority && !authority.revoked, "LINUX_PREPARATION_AUTHORITY_REQUIRED");
  linuxAssert(typeof record === "function", "LINUX_PREPARATION_EVIDENCE_REQUIRED");
  const bytes = await readFile(manifestPath); linuxAssert(bytes.length <= 512 * 1024, "LINUX_ARTIFACT_PLAN_INVALID");
  const plan = assertLinuxArtifactPlan(parseLinuxJson(bytes), bytes, approvalSha256); linuxAssert(plan.v === 2, "LINUX_RUNTIME_MANIFEST_V2_REQUIRED");
  const source = await linuxSourceInventory(root, sourceNames); linuxAssert(source.freeze === plan.sourceFreeze, "LINUX_SOURCE_CHANGED");
  const memory = await readFile("/proc/meminfo", "utf8");
  linuxAssert(Number(/^MemAvailable:\s+(\d+) kB$/mu.exec(memory)?.[1]) / 1024 >= LINUX_PROFILE.admissionMiB, "LINUX_MEMORY_ADMISSION_FAILED");
  await mkdir(evidenceDirectory, { recursive: true });
  const engine = await createLinuxEngine();
  await measureLinuxPreparation(engine, evidenceDirectory, "before-build", { root, evidence: evidenceDirectory }, { dependencies: join(root, "node_modules") });
  const base = await engine.call("GET", "/images/" + encodeURIComponent(plan.baseReference) + "/json");
  const baseDigest = plan.baseReference.split("@")[1];
  linuxAssert(base.Id === plan.baseConfig && base.Os === "linux" && base.Architecture === "amd64" && !base.Config.OnBuild?.length
    && base.RepoDigests?.some(value => ["node@" + baseDigest, "library/node@" + baseDigest, plan.baseReference].includes(value)), "LINUX_BASE_IMAGE_UNQUALIFIED");
  const context = await mkdtemp(join(tmpdir(), "p1c-linux-build-")), app = join(context, "app");
  await mkdir(app);
  // Dependencies are installed in the future, separately authorized preparation
  // lane. They must be Linux artifacts; Windows node_modules are never copied.
  linuxAssert(process.versions.node === "24.14.1" && digest(await readFile(process.execPath)) === plan.nodeSha256, "LINUX_NODE_UNQUALIFIED");
  for (const name of sourceNames.filter(name => /^(src\/|prisma\/|scripts\/|package(?:-lock)?\.json$|tsconfig\.json$)/u.test(name))) {
    await mkdir(resolve(app, name, ".."), { recursive: true }); await cp(join(root, name), join(app, name), { errorOnExist: true });
  }
  const rootModules = join(root, "node_modules"); linuxAssert((await lstat(rootModules)).isDirectory() && !(await lstat(rootModules)).isSymbolicLink(), "LINUX_DEPENDENCIES_MISSING");
  // Reject escaping symlinks before cp; npm's internal .bin links are permitted.
  const inspect = async path => { for (const item of await readdir(path, { withFileTypes: true })) { const child = join(path, item.name); if (item.isSymbolicLink()) { const target = await realpath(child); linuxAssert(!relative(rootModules, target).startsWith("..") && !isAbsolute(relative(rootModules, target)), "LINUX_DEPENDENCY_ESCAPE"); } else if (item.isDirectory()) await inspect(child); } };
  await inspect(rootModules); await cp(rootModules, join(app, "node_modules"), { recursive: true, dereference: false });
  const generated = join(root, "src/generated/prisma");
  linuxAssert((await lstat(generated)).isDirectory() && !(await lstat(generated)).isSymbolicLink(), "LINUX_PRISMA_GENERATION_MISSING");
  await cp(generated, join(app, "src/generated/prisma"), { recursive: true, dereference: false });
  const nodePath = "/usr/local/bin/node", helperPath = "/app/node_modules/@esbuild/linux-x64/bin/esbuild";
  const files = Object.fromEntries(source.files.filter(file => /^(src\/|prisma\/|scripts\/|package(?:-lock)?\.json$|tsconfig\.json$)/u.test(file.name)).map(file => ["/app/" + file.name, file.sha256]));
  files["/app/node_modules/tsx/dist/loader.mjs"] = digest(await readFile(join(rootModules, "tsx/dist/loader.mjs")));
  const closure = async path => { for (const item of await readdir(path, { withFileTypes: true })) { const child = join(path, item.name); if (item.isDirectory()) await closure(child); else if (item.isFile()) files["/app/" + relative(app, child)] = digest(await readFile(child)); else if (item.isSymbolicLink()) { linuxAssert(!relative(app, await realpath(child)).startsWith(".."), "LINUX_DEPENDENCY_ESCAPE"); } else throw new LinuxSafetyError("LINUX_ARTIFACT_SPECIAL_FILE"); } };
  await closure(join(app, "node_modules")); await closure(join(app, "src/generated/prisma"));
  const baseEnvironment = base.Config.Env ?? [];
  linuxAssert(baseEnvironment.every(value => /^(PATH|NODE_VERSION|YARN_VERSION)=/u.test(value)) && baseEnvironment.includes("NODE_VERSION=24.14.1"), "LINUX_BASE_ENVIRONMENT_UNQUALIFIED");
  const profile = { v: 1, node: { path: nodePath, sha256: plan.nodeSha256 }, init: plan.init, baseEnvironment, workerSeccomp: plan.workerSeccomp,
    helper: { path: helperPath, sha256: digest(await readFile(join(rootModules, "@esbuild/linux-x64/bin/esbuild"))),
      commandSha256: digest(Buffer.from([helperPath, "--service=" + JSON.parse(await readFile(join(rootModules, "esbuild/package.json"), "utf8")).version, "--ping"].join("\0") + "\0")) }, files, osFiles: plan.osFiles };
  await writeFile(join(app, "p1c-artifact.json"), JSON.stringify(profile));
  await mkdir(join(context, "runtime/bin"), { recursive: true }); await cp(process.execPath, join(context, "runtime/bin/node"));
  const specification = linuxImageSpecification(plan); await writeFile(join(context, "Dockerfile"), specification);
  // The image tag is local and correlated. No registry push or Docker socket mount.
  const artifactAttempt = randomUUID(), tag = "piccadilly-p1c-linux:" + source.freeze.slice(0, 24) + "-" + artifactAttempt.slice(0, 8);
  try { await engine.call("GET", "/images/" + encodeURIComponent(tag) + "/json"); throw new LinuxSafetyError("LINUX_IMAGE_TAG_COLLISION"); }
  catch (error) { if (error.code !== "LINUX_ENGINE_HTTP_404") throw error; }
  const resourcesBeforeBuild = await readLinuxPreparationResources(engine);
  record("preparation-resources", { phase: "before-build", engineId: engine.id, containers: resourcesBeforeBuild.containers, networks: resourcesBeforeBuild.networks,
    volumeNameHashes: resourcesBeforeBuild.volumes.map(digest), ownImageId: null });
  const contextTar = join(await mkdtemp(join(tmpdir(), "p1c-build-stream-")), "context.tar");
  await runLinuxTool("/usr/bin/tar", ["-cf", contextTar, "-C", context, "."], { expectedSha256: plan.tools.tar, environment: { PATH: "/usr/bin:/bin" }, authority,
    timeoutMs: Math.min(60000, authority.remaining()) });
  const contextInfo = await lstat(contextTar); linuxAssert(contextInfo.isFile() && !contextInfo.isSymbolicLink() && contextInfo.size <= plan.preparation.contextMaximumBytes, "LINUX_BUILD_CONTEXT_LIMIT");
  const built = await runLinuxPreparationDaemon({ authority, engine, kind: "build", reference: tag,
    contextArchive: { path: contextTar, bytes: contextInfo.size }, labels: { "piccadilly.preparation": authority.attempt, "piccadilly.source": source.freeze } });
  const resourcesAfterBuild = await readLinuxPreparationResources(engine);
  record("preparation-resources", { phase: "after-build", engineId: engine.id, containers: resourcesAfterBuild.containers, networks: resourcesAfterBuild.networks,
    volumeNameHashes: resourcesAfterBuild.volumes.map(digest), ownImageId: built.Id });
  linuxAssert(JSON.stringify(resourcesAfterBuild) === JSON.stringify(resourcesBeforeBuild), "LINUX_ARTIFACT_RESIDUAL_RESOURCES");
  linuxAssert(/^sha256:[a-f0-9]{64}$/u.test(built.Id) && built.Os === "linux" && built.Architecture === "amd64" && built.Config.User === "10001:10001"
    && !built.Config.Cmd?.length && !built.Config.Healthcheck && !Object.keys(built.Config.Volumes ?? {}).length && !Object.keys(built.Config.ExposedPorts ?? {}).length
    && JSON.stringify(built.Config.Entrypoint) === JSON.stringify([nodePath, "/app/scripts/m13-p1-worker-linux-entry.mjs"]), "LINUX_IMAGE_ATTESTATION_FAILED");
  const archivePath = join(evidenceDirectory, "linux-worker-image.tar");
  linuxAssert(!await lstat(archivePath).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), "LINUX_IMAGE_ARCHIVE_COLLISION");
  await runLinuxPreparationDaemon({ authority, engine, kind: "save", reference: built.Id, output: archivePath, maximum: plan.preparation.imageArchiveMaximumBytes });
  const archiveInfo = await lstat(archivePath); linuxAssert(archiveInfo.isFile() && !archiveInfo.isSymbolicLink() && archiveInfo.size <= plan.preparation.imageArchiveMaximumBytes, "LINUX_IMAGE_ARCHIVE_BUDGET");
  const archiveHash = createHash("sha256"); for await (const block of createReadStream(archivePath, { highWaterMark: 65536 })) { authority.assert(); archiveHash.update(block); }
  const schemaEnginePath = join(root, "node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x");
  linuxAssert(digest(await readFile(schemaEnginePath)) === plan.prisma.binarySha256, "LINUX_PRISMA_EXECUTABLE_CHANGED");
  const hostPrisma = { schemaEnginePath, sha256: plan.prisma.binarySha256, helpers: await prismaHelpers(plan, "migrate", root, process.execPath, join(root, "prisma.config.ts")) };
  const result = { kind: "BUILT_LOCAL_ATTESTED", sourceFreeze: source.freeze, artifactAttempt, localTag: tag, artifactResourceAbsence: "PASS_VERIFIED_NO_ADDED_CONTAINER_NETWORK_VOLUME",
    imageId: built.Id, diffIds: built.RootFS.Layers, profile, hostPrisma, imageArchiveSha256: archiveHash.digest("hex"), imageArchiveBytes: archiveInfo.size,
    specificationSha256: digest(specification), approvalSha256, runtimeNodeSha256: plan.nodeSha256, diskAdmissionMiB: plan.diskAdmissionMiB,
    preparationOwner: authority.attempt, preparationResources: resourcesBeforeBuild, admissionPurpose: plan.purpose, diskBudget: plan.diskBudget };
  await writeFile(join(evidenceDirectory, "linux-image.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  await measureLinuxPreparation(engine, evidenceDirectory, "after-build", { root, evidence: evidenceDirectory, buildContext: context }, { buildContext: context, dependencies: rootModules, imageArchive: archivePath });
  qualifiedLinuxImages.add(result); return result;
}

export function selectLinuxAdmissionMode(mode, handlers) {
  linuxAssert(["ARTIFACT_DISCOVERY", "QUALIFIED_WORKLOAD"].includes(mode), "LINUX_MODE_AUTHORITY_MISMATCH");
  // There is deliberately no fallback, retry or transition from discovery.
  return mode === "ARTIFACT_DISCOVERY" ? handlers.discovery() : handlers.workload();
}

const emptyScenarios = () => Object.fromEntries(Array.from({ length: 10 }, (_, index) => ["C" + String(index + 1).padStart(2, "0"), "NOT_RUN"]));
export const createLinuxAdmissionOutcome = mode => ({ status: "FAIL", mode, primary: null, secondary: [], omissions: [], scenarios: emptyScenarios(), preparationComplete: false,
  daemonReconciled: false, processesJoined: false, sqlQuiescence: "NOT_RUN", teardownComplete: false, artifactCleanup: "NOT_RUN", nativeMeasurement: "NOT_QUALIFIED_BY_IMPLEMENTATION" });
export function preserveLinuxAdmissionFailure(outcome, error, { secondary = [], omissions = [] } = {}) {
  const failure = codeOf(error);
  if (outcome.primary === null) outcome.primary = failure; else if (outcome.primary !== failure && !outcome.secondary.includes(failure)) outcome.secondary.push(failure);
  outcome.status = "FAIL";
  for (const value of secondary) if (!outcome.secondary.includes(value)) outcome.secondary.push(value);
  for (const value of omissions) if (!outcome.omissions.includes(value)) outcome.omissions.push(value);
  return outcome;
}
export function linuxRetentionResult(outcome, { step, id, url, sha256, archiveSha256 }) {
  const valid = evOutcome(outcome), retained = step === "success" && /^\d{1,30}$/u.test(id ?? "") && hex(sha256)
    && /^https:\/\/github\.com\/TommyGiacopini\/piccadilly-booking\/actions\/runs\/\d+\/artifacts\/\d+$/u.test(url ?? "") && hex(archiveSha256);
  return { mode: valid ? outcome.mode : "NOT_VERIFIABLE", status: valid ? outcome.status : "NOT_COMPLETED", primary: valid ? outcome.primary : "LINUX_RUNTIME_EVIDENCE_INCOMPLETE",
    secondary: valid ? [...outcome.secondary] : [], scenarios: valid ? outcome.scenarios : {}, omissions: valid ? outcome.omissions : ["LINUX_RUNTIME_EVIDENCE_INCOMPLETE"],
    retention: retained ? "UPLOADED_INDEPENDENT_DOWNLOAD_VERIFICATION_REQUIRED" : "NOT_VERIFIABLE", retentionFailure: retained ? null : "LINUX_UPLOAD_NOT_VERIFIED",
    artifactId: retained ? id : null, artifactUrl: retained ? url : null, artifactDigest: retained ? sha256 : null, archiveSha256: hex(archiveSha256) ? archiveSha256 : null,
    complete: retained && valid && outcome.status !== "FAIL" };
}
export function linuxFinalizationWindow(schedule, started, current) {
  linuxAssert(Number.isFinite(started) && started >= schedule.started && started <= current, "LINUX_FINALIZATION_CLOCK_INVALID");
  const deadline = Math.min(schedule.ends.finalization, started + 30000); linuxAssert(current < deadline, "LINUX_FINALIZATION_DEADLINE"); return deadline;
}
function finalizationDeadline(schedule) {
  const current = linuxAdmissionNow(), previous = process.env.P1C_FINALIZATION_STARTED_UPTIME_MS;
  const started = previous === undefined ? current : Number(previous);
  const deadline = linuxFinalizationWindow(schedule, started, current);
  if (previous === undefined) { process.env.P1C_FINALIZATION_STARTED_UPTIME_MS = String(started); appendFileSync(process.env.GITHUB_ENV, "P1C_FINALIZATION_STARTED_UPTIME_MS=" + started + "\n"); }
  return deadline;
}

export async function removeOwnedLinuxImage({ image: prepared, engine, authority, record }) {
  authority.assert(); const current = await engine.call("GET", "/images/" + prepared.imageId + "/json");
  linuxAssert(current.Id === prepared.imageId && current.Config.Labels?.["piccadilly.preparation"] === prepared.preparationOwner
    && current.Config.Labels?.["piccadilly.source"] === prepared.sourceFreeze && authority.attempt === prepared.preparationOwner, "LINUX_DISCOVERY_IMAGE_OWNERSHIP");
  record("image-disposition", { imageId: prepared.imageId, preparationAttempt: prepared.preparationOwner, removed: false });
  const operation = authority.register("DAEMON", "remove-owned-image");
  const absent = await authority.track(operation, (async () => {
    const response = await engine.call("DELETE", "/images/" + prepared.imageId, undefined, { binary: true, beforeDispatch: () => authority.dispatch(operation, () => undefined) });
    let absent = false; try { await engine.call("GET", "/images/" + prepared.imageId + "/json"); } catch (error) { if (error.code === "LINUX_ENGINE_HTTP_404") absent = true; else throw error; }
    authority.assert(); linuxAssert(absent && Buffer.isBuffer(response), "LINUX_DISCOVERY_IMAGE_RESIDUAL");
    authority.completeDaemon(operation, { engineId: engine.id, responseComplete: true, instanceVerified: true, responseSha256: digest(response), artifactId: prepared.imageId });
    return absent;
  })());
  const actual = await readLinuxPreparationResources(engine); authority.assert();
  record("preparation-resources", { phase: "after-image-cleanup", engineId: engine.id, containers: actual.containers, networks: actual.networks, volumeNameHashes: actual.volumes.map(digest), ownImageId: prepared.imageId });
  record("image-disposition", { imageId: prepared.imageId, preparationAttempt: prepared.preparationOwner, removed: absent });
  linuxAssert(JSON.stringify(actual) === JSON.stringify(prepared.preparationResources), "LINUX_ARTIFACT_RESIDUAL_RESOURCES");
}

function recordPreparationFacts(writer, authority) {
  const operations = authority.records();
  for (let offset = 0; offset < operations.length; offset += 256) {
    writer.record("operations", { rows: operations.slice(offset, offset + 256).map(({ id, kind, name, state, dispatched, settled, daemonComplete, transportJoined, failure }) => ({ id, kind, name, state, dispatched, settled, daemonComplete, transportJoined, failure })) });
  }
  writer.record("channels", { rows: authority.channels() });
  for (const row of operations) if (row.daemonProof) writer.record("daemon", { operationId: row.id, ...row.daemonProof, complete: row.daemonComplete });
  for (const row of toolProcesses) {
    writer.record("tool", { operationId: row.operationId, pid: row.pid ?? null, executableSha256: row.executableSha256, startTicks: row.birth, exitObserved: row.exitObserved,
      closeObserved: row.joined, exitCode: row.exitCode, treeVerified: row.treeVerified, failure: row.failure, stopFailure: row.stopFailure, helpers: row.helpers.map(projectLinuxProcess) });
    if (row.failureObservation) writer.record("rejection", { pid: row.failureObservation.processId, parent: row.failureObservation.parentProcessId,
      startTicks: row.failureObservation.startTicks, executableSha256: row.failureObservation.executableSha256, failedPredicate: row.failureObservation.failedPredicate });
  }
}
function recordArtifactFacts(writer, plan, proof) {
  writer.record("approval", { manifestSha256: proof.manifestSha256, artifactIdentitiesSha256: proof.artifactIdentitiesSha256, diskBudgetSha256: proof.diskBudgetSha256,
    timeBudgetSha256: proof.timeBudgetSha256, purpose: plan.purpose, humanApprovalRequired: true });
  writer.record("artifacts", { nodeVersion: plan.nodeVersion, nodeArchiveSha256: plan.nodeArchiveSha256, nodeSha256: plan.nodeSha256, sourceFreeze: plan.sourceFreeze,
    baseReference: plan.baseReference, baseConfig: plan.baseConfig, initSha256: plan.init.sha256, tarSha256: plan.tools.tar, dockerSha256: plan.tools.docker, xzSha256: plan.preparation.xz.sha256,
    osFiles: Object.entries(plan.osFiles).map(([path, sha256]) => ({ pathSha256: digest(path), sha256 })), seccompSha256: digest(JSON.stringify(plan.workerSeccomp)),
    prismaEngineCommit: plan.prisma.engineCommit, prismaGzipSha256: plan.prisma.gzipSha256, prismaBinarySha256: plan.prisma.binarySha256, prismaHelpersSha256: digest(JSON.stringify(plan.prisma.helpers)) });
}
function initialAdmissionIdentity(mode, sha, manifestUrl) {
  return { v: 1, mode, repository: "TommyGiacopini/piccadilly-booking", commit: process.env.GITHUB_SHA ?? null, tree: process.env.P1C_SOURCE_TREE ?? null,
    sourceFreeze: null, workflowSha256: null, manifestSha256: sha, manifestUrl, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, attempt: randomUUID(),
    runner: { os: process.env.RUNNER_OS, arch: process.env.RUNNER_ARCH, imageVersion: process.env.ImageVersion ?? null, engineId: null },
    bootstrap: { version: process.versions.node, sha256: digest(readFileSync(process.execPath)) }, policy: { retentionDays: 14, compressedMaxBytes: EVIDENCE_POLICY.compressedBytes },
    approvalModel: "HUMAN_WORK3_CLASSIC3_REQUIRED_NOT_CRYPTOGRAPHIC_SIGNATURE" };
}
function assertRetentionEligibility() {
  linuxAssert(process.env.P1C_RETENTION_CONFIRMED === "true" && /^\d+$/u.test(process.env.GITHUB_RETENTION_DAYS ?? "")
    && Number(process.env.GITHUB_RETENTION_DAYS) >= EVIDENCE_POLICY.days, "LINUX_RETENTION_POLICY_NOT_CONFIRMED");
}
function phasePaths(root, raw, info, distribution = tmpdir()) {
  return { root, temp: process.env.RUNNER_TEMP, docker: info.DockerRootDir, cache: distribution, artifact: raw, evidence: process.env.P1C_SANITIZED_DIRECTORY };
}
function phaseProof(writer, name, deadline, started, complete) {
  writer.record("phase", { name, startedMs: started, endedMs: linuxAdmissionNow(), deadlineMs: deadline, complete });
}
async function boundedAdmissionPhase(name, schedule, writer, work, expire) {
  // harness.run(worker-runtime) includes its separately budgeted 15s guard.
  // The application role retains its original full 600s cap.
  const seconds = ADMISSION_PHASE_SECONDS[name] + (name === "worker" ? ADMISSION_PHASE_SECONDS.workerGuard : 0);
  const started = linuxAdmissionNow(), deadline = Math.min(schedule.admit(name), started + seconds * 1000);
  writer.record("phase", { name, startedMs: started, endedMs: null, deadlineMs: deadline, complete: false });
  let timer;
  try {
    const result = await Promise.race([Promise.resolve().then(() => { schedule.admit(name); return work(deadline); }), new Promise((_, reject) => {
      timer = setTimeout(() => { const error = new LinuxSafetyError("LINUX_JOB_PHASE_EXPIRED"); expire(error); reject(error); }, Math.max(1, deadline - linuxAdmissionNow()));
    })]);
    schedule.admit(name); phaseProof(writer, name, deadline, started, true); return result;
  } catch (error) { phaseProof(writer, name, deadline, started, false); throw error; }
  finally { clearTimeout(timer); }
}

async function bootstrapLinuxJob(mode, manifestUrl, approvalSha256, sourceListPath, evidenceDirectory, sanitizedDirectory) {
  linuxAssert(process.platform === "linux" && process.arch === "x64" && process.env.GITHUB_REPOSITORY === "TommyGiacopini/piccadilly-booking"
    && process.env.GITHUB_EVENT_NAME === "workflow_dispatch" && ["ARTIFACT_DISCOVERY", "QUALIFIED_WORKLOAD"].includes(mode), "LINUX_WORKFLOW_CONTEXT_REJECTED");
  const schedule = linuxJobSchedule(Number(process.env.P1C_JOB_STARTED_UPTIME_MS)), writer = createLinuxEvidence(sanitizedDirectory, initialAdmissionIdentity(mode, approvalSha256, manifestUrl));
  const outcome = createLinuxAdmissionOutcome(mode), authority = createPreparationAuthority({ deadline: schedule.admit("preparation"), attempt: writer.identity().attempt, record: value => writer.record("authority", value) });
  writer.record("phase", { name: "preparation", startedMs: schedule.started, endedMs: null, deadlineMs: schedule.ends.preparation, complete: false });
  const interrupted = () => authority.revoke(new LinuxSafetyError("LINUX_CONTROLLER_INTERRUPTED"));
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  try {
    await withPreparationAuthority(authority, async () => {
      assertRetentionEligibility(); await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
      const manifestPath = join(evidenceDirectory, "approved-linux.json");
      await fetchLinuxApproval(manifestUrl, approvalSha256, manifestPath);
      const bytes = await readFile(manifestPath), plan = assertLinuxArtifactPlan(parseLinuxJson(bytes), bytes, approvalSha256);
      linuxAssert(plan.v === 2 && plan.purpose === mode, "LINUX_RUNTIME_MANIFEST_V2_REQUIRED");
      const root = fileURLToPath(new URL("../", import.meta.url)), sourceNames = (await readFile(sourceListPath, "utf8")).split("\0").filter(Boolean), source = await linuxSourceInventory(root, sourceNames);
      linuxAssert(source.freeze === plan.sourceFreeze && !(await readdir(root)).some(name => name === ".npmrc" || name.startsWith(".env") && name !== ".env.example"), "LINUX_SOURCE_CHANGED");
      const workflowSha256 = digest(await readFile(join(root, ".github/workflows/m13-p1-c-linux-qualification.yml"))), engine = await createLinuxEngine(), info = await engine.verify();
      const observed = { repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA, tree: process.env.P1C_SOURCE_TREE, sourceFreeze: source.freeze, workflowSha256,
        runnerProfile: { os: process.env.RUNNER_OS, arch: process.env.RUNNER_ARCH, image: "ubuntu-24.04", imageVersion: process.env.ImageVersion, engineVersion: info.ServerVersion }, bootstrapIdentity: writer.identity().bootstrap };
      const proof = assertLinuxApprovalBinding(plan, observed, approvalSha256, mode);
      writer.bind({ sourceFreeze: source.freeze, workflowSha256, runner: { ...writer.identity().runner, engineId: info.ID } }); recordArtifactFacts(writer, plan, proof);
      if (mode === "QUALIFIED_WORKLOAD") linuxAssert(process.env.P1C_WORKLOAD_AUTHORIZED === "true", "LINUX_WORKLOAD_NOT_AUTHORIZED");
      linuxAssert(digest(await readFile("/usr/bin/docker")) === plan.tools.docker && digest(await readFile("/usr/bin/tar")) === plan.tools.tar
        && digest(await readFile(plan.preparation.xz.path)) === plan.preparation.xz.sha256, "LINUX_PREPARATION_TOOL_CHANGED");
      const memory = await readFile("/proc/meminfo", "utf8"); linuxAssert(info.MemTotal / 1024 ** 2 >= 3840 && Number(/^MemAvailable:\s+(\d+) kB$/mu.exec(memory)?.[1]) / 1024 >= 3840, "LINUX_MEMORY_ADMISSION_FAILED");
      const distribution = await mkdtemp(join(tmpdir(), "p1c-node-"));
      const environment = await runLinuxDiskPhase({ budget: plan.diskBudget, phase: "dependencies", paths: phasePaths(root, evidenceDirectory, info, distribution), authority,
        record: value => writer.record("storage", value) }, async () => {
        await measureLinuxPreparation(engine, evidenceDirectory, "before-dependencies", { root, evidence: evidenceDirectory });
        const archive = await download("https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-x64.tar.xz", 60 * 1024 ** 2);
        linuxAssert(digest(archive) === LINUX_NODE_ARCHIVE_SHA256, "LINUX_NODE_ARCHIVE_MISMATCH");
        const archivePath = join(distribution, "node.tar.xz"); await writeFile(archivePath, archive, { flag: "wx" });
        const xz = plan.preparation.xz, xzProfile = { path: xz.path, sha256: xz.sha256, commandSha256: digest(Buffer.from([xz.argv0, ...xz.args].join("\0") + "\0")) };
        await runLinuxTool("/usr/bin/tar", ["-xJf", archivePath, "--directory", distribution], { expectedSha256: plan.tools.tar, environment: { PATH: "/usr/bin:/bin" },
          allowedHelpers: [xzProfile], requiredHelpers: [xzProfile], timeoutMs: Math.min(60000, authority.remaining()) });
        const runtime = join(distribution, "node-v24.14.1-linux-x64"), node = join(runtime, "bin/node");
        linuxAssert(digest(await readFile(node)) === plan.nodeSha256, "LINUX_NODE_UNQUALIFIED");
        const env = { PATH: join(runtime, "bin") + ":/usr/bin:/bin", HOME: distribution, TMPDIR: tmpdir(), NPM_CONFIG_USERCONFIG: join(distribution, "empty-user.npmrc"),
          NPM_CONFIG_GLOBALCONFIG: join(distribution, "empty-global.npmrc"), NPM_CONFIG_CACHE: join(distribution, "npm-cache"), NEXT_TELEMETRY_DISABLED: "1", CHECKPOINT_DISABLE: "1",
          PRISMA_HIDE_UPDATE_MESSAGE: "1", PRISMA_GENERATE_SKIP_AUTOINSTALL: "true" };
        for (const path of [env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG]) await writeFile(path, "", { flag: "wx" });
        await runLinuxTool(node, [join(runtime, "lib/node_modules/npm/bin/npm-cli.js"), "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, environment: env,
          expectedSha256: plan.nodeSha256, timeoutMs: Math.min(600000, authority.remaining()) });
        const engineVersion = parseLinuxJson(await readFile(join(root, "node_modules/@prisma/engines-version/package.json"))).prisma.enginesVersion;
        linuxAssert(engineVersion === plan.prisma.engineCommit && parseLinuxJson(await readFile(join(root, "node_modules/prisma/package.json"))).version === "7.9.1", "LINUX_PRISMA_VERSION_MISMATCH");
        const compressed = await download(`https://binaries.prisma.sh/all_commits/${engineVersion}/debian-openssl-3.0.x/schema-engine.gz`, 64 * 1024 ** 2);
        linuxAssert(digest(compressed) === plan.prisma.gzipSha256, "LINUX_PRISMA_ARCHIVE_MISMATCH");
        const binary = gunzipSync(compressed, { maxOutputLength: 128 * 1024 ** 2 });
        linuxAssert(digest(binary) === plan.prisma.binarySha256 && binary.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && binary[4] === 2 && binary[5] === 1 && binary.readUInt16LE(18) === 62, "LINUX_PRISMA_EXECUTABLE_CHANGED");
        const binaryPath = join(root, "node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x");
        try { linuxAssert(digest(await readFile(binaryPath)) === plan.prisma.binarySha256, "LINUX_PRISMA_EXECUTABLE_CHANGED"); }
        catch (error) { if (error.code !== "ENOENT") throw error; await writeFile(binaryPath, binary, { flag: "wx", mode: 0o555 }); }
        env.PRISMA_SCHEMA_ENGINE_BINARY = binaryPath;
        const config = join(distribution, "prisma-generate.config.mjs"); await writeFile(config, "export default " + JSON.stringify({ schema: join(root, "prisma/schema.prisma") }) + ";\n", { flag: "wx" });
        await runLinuxTool(node, [join(root, "node_modules/prisma/build/index.js"), "generate", "--config", config], { cwd: root, environment: env,
          expectedSha256: plan.nodeSha256, allowedHelpers: await prismaHelpers(plan, "generate", root, node, config), timeoutMs: Math.min(60000, authority.remaining()) });
        await measureLinuxPreparation(engine, evidenceDirectory, "after-dependencies", { root, evidence: evidenceDirectory, distribution }, { dependencies: join(root, "node_modules"), distribution });
        return env;
      });
      await runLinuxDiskPhase({ budget: plan.diskBudget, phase: "pulls", paths: phasePaths(root, evidenceDirectory, info, distribution), authority,
        record: value => writer.record("storage", value) }, async () => {
        for (const [reference, expectedConfig] of [[plan.baseReference, plan.baseConfig],
          ["postgres@sha256:b6a16ed0eb96e2c362811f7eeb951eac8b459e7b40be4149ea5444aa7c65569b", "sha256:bd1890816ae0b8ad4644f05728570d4be774e1f1490d7232f5084b52ea335183"],
          ["haproxy@sha256:3c2931ee7070f321b0bde9cbf5c27227d72b43f5862b9f028516fbeff4644fbf", "sha256:92fa659751a39ced505c3d78f03387c463372b2b9129400e27edeb49abd347d2"]]) {
          await runLinuxPreparationDaemon({ authority, engine, kind: "pull", reference, expectedConfig });
        }
        await measureLinuxPreparation(engine, evidenceDirectory, "after-pulls", { root, evidence: evidenceDirectory, distribution });
      });
      for (let count = 0; count < 50 && !engine.joined(); count++) await new Promise(done => setTimeout(done, 10));
      authority.assert(); linuxAssert(authority.quiescent() && linuxToolQuiescence().verified && engine.joined(), "LINUX_RUNTIME_HANDOFF_NOT_SAFE");
      recordPreparationFacts(writer, authority);
      const node = join(distribution, "node-v24.14.1-linux-x64/bin/node"), handoff = { identity: writer.identity(), observed, mode, attempt: authority.attempt, deadline: authority.deadline,
        controllerPid: process.pid, startTicks: parseLinuxStat(await readFile("/proc/self/stat", "utf8")).startTicks, bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), engineId: engine.id };
      await writeFile(join(evidenceDirectory, "preparation-handoff.json"), JSON.stringify(handoff) + "\n", { flag: "wx", mode: 0o600 });
      for (const key of ["GITHUB_REPOSITORY", "GITHUB_EVENT_NAME", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_RETENTION_DAYS", "GITHUB_ENV", "RUNNER_OS", "RUNNER_ARCH", "RUNNER_TEMP", "ImageVersion", "P1C_SOURCE_TREE", "P1C_JOB_STARTED_UPTIME_MS", "P1C_SANITIZED_DIRECTORY", "P1C_WORKLOAD_AUTHORIZED", "P1C_RETENTION_CONFIRMED"]) {
        if (process.env[key] !== undefined) environment[key] = process.env[key];
      }
      authority.assert(); linuxAssert(authority.quiescent(), "LINUX_RUNTIME_HANDOFF_NOT_SAFE");
      handoffLinuxRuntime({ node, args: [fileURLToPath(import.meta.url), mode === "ARTIFACT_DISCOVERY" ? "--discovery-job" : "--qualified-job", manifestPath, approvalSha256, sourceListPath, evidenceDirectory],
        environment, quiescence: linuxToolQuiescence() });
    });
  } catch (error) {
    preserveLinuxAdmissionFailure(outcome, error); authority.revoke(error);
    const reconciliation = await authority.stop({ deadline: Math.min(linuxAdmissionNow() + 70000, schedule.ends.teardown) });
    outcome.secondary.push(...reconciliation.failures); outcome.omissions.push("LINUX_WORKLOAD_NOT_ENTERED");
    try { recordPreparationFacts(writer, authority); writer.record("error", { primary: outcome.primary, secondary: outcome.secondary, omissions: outcome.omissions }); writer.outcome(outcome); }
    catch { console.error("LINUX_EVIDENCE_INCOMPLETE"); }
    throw error;
  } finally { authority.dispose(); process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted); }
}

async function continueLinuxJob(mode, manifestPath, approvalSha256, sourceListPath, evidenceDirectory) {
  const schedule = linuxJobSchedule(Number(process.env.P1C_JOB_STARTED_UPTIME_MS)), handoff = parseLinuxJson(await readFile(join(evidenceDirectory, "preparation-handoff.json")));
  linuxAssert(handoff.mode === mode && handoff.controllerPid === process.pid && handoff.startTicks === parseLinuxStat(await readFile("/proc/self/stat", "utf8")).startTicks
    && handoff.bootId === (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() && handoff.deadline === schedule.ends.preparation, "LINUX_RUNTIME_HANDOFF_NOT_VERIFIED");
  const writer = createLinuxEvidence(process.env.P1C_SANITIZED_DIRECTORY, handoff.identity, { resume: true }), outcome = createLinuxAdmissionOutcome(mode);
  const authority = createPreparationAuthority({ deadline: schedule.admit("preparation"), attempt: handoff.attempt, record: value => writer.record("authority", value) });
  const interrupted = () => authority.revoke(new LinuxSafetyError("LINUX_CONTROLLER_INTERRUPTED")); process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  let image, plan, engine, sourceNames, prepared = false;
  try {
    await withPreparationAuthority(authority, async () => {
      assertRetentionEligibility(); const bytes = await readFile(manifestPath); plan = assertLinuxArtifactPlan(parseLinuxJson(bytes), bytes, approvalSha256);
      assertLinuxApprovalBinding(plan, handoff.observed, approvalSha256, mode);
      linuxAssert(process.versions.node === "24.14.1" && digest(await readFile(process.execPath)) === plan.nodeSha256, "LINUX_RUNTIME_HANDOFF_NOT_VERIFIED");
      sourceNames = (await readFile(sourceListPath, "utf8")).split("\0").filter(Boolean); engine = await createLinuxEngine();
      linuxAssert(engine.id === handoff.engineId, "LINUX_ENGINE_CHANGED");
      const info = await engine.verify(), root = fileURLToPath(new URL("../", import.meta.url));
      image = await runLinuxDiskPhase({ budget: plan.diskBudget, phase: "build", paths: phasePaths(root, evidenceDirectory, info), authority, record: value => writer.record("storage", value) },
        () => prepareLinuxImage({ root, evidenceDirectory, manifestPath, approvalSha256, sourceNames, authority, record: writer.record }));
      writer.record("image", { artifactId: image.imageId, diffIds: image.diffIds, sourceFreeze: image.sourceFreeze, archiveSha256: image.imageArchiveSha256,
        archiveBytes: image.imageArchiveBytes, profileSha256: digest(JSON.stringify(image.profile)), preparationAttempt: authority.attempt });
      await selectLinuxAdmissionMode(mode, {
        discovery: () => removeOwnedLinuxImage({ image, engine, authority, record: writer.record }),
        workload: () => { linuxAssert(process.env.P1C_WORKLOAD_AUTHORIZED === "true" && plan.diskBudget.basis === "MEASURED_APPROVED", "LINUX_WORKLOAD_NOT_AUTHORIZED"); },
      });
      for (let count = 0; count < 50 && !engine.joined(); count++) await new Promise(done => setTimeout(done, 10));
      authority.assert(); linuxAssert(authority.quiescent() && linuxToolQuiescence().verified && engine.joined(), "LINUX_PREPARATION_JOIN_INCOMPLETE");
      recordPreparationFacts(writer, authority); authority.seal(); prepared = true;
      phaseProof(writer, "preparation", schedule.ends.preparation, schedule.started, true);
    });
    outcome.preparationComplete = true; outcome.daemonReconciled = true;
    if (mode === "ARTIFACT_DISCOVERY") {
      outcome.status = "NOT_VERIFIABLE"; outcome.processesJoined = true; outcome.teardownComplete = false; outcome.artifactCleanup = "PASS_VERIFIED";
      outcome.omissions.push("LINUX_WORKLOAD_NOT_ENTERED", "LINUX_OS_INIT_INSTANCE_QUALIFICATION_NOT_RUN", "LINUX_PREPARATION_ARTIFACT_FILES_RETAINED");
      // Identity discovery produces no workload authority or C01-C10 PASS.
    } else await runQualifiedLinuxWorkload({ plan, image, engine, writer, schedule, observed: handoff.observed, approvalSha256, sourceNames, evidenceDirectory, outcome });
  } catch (error) {
    preserveLinuxAdmissionFailure(outcome, error);
    if (!prepared) { authority.revoke(error); const reconciliation = await authority.stop({ deadline: Math.min(linuxAdmissionNow() + 70000, schedule.ends.teardown) }); outcome.secondary.push(...reconciliation.failures);
      try { recordPreparationFacts(writer, authority); } catch { outcome.omissions.push("LINUX_PREPARATION_EVIDENCE_INCOMPLETE"); } }
  } finally {
    authority.dispose(); process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
    try { finalizationDeadline(schedule); writer.record("error", { primary: outcome.primary, secondary: outcome.secondary, omissions: outcome.omissions }); writer.outcome(outcome); }
    catch { outcome.primary ??= "LINUX_EVIDENCE_INCOMPLETE"; outcome.status = "FAIL"; }
  }
  console.log(JSON.stringify({ mode, status: outcome.status, primary: outcome.primary, scenarios: outcome.scenarios, omissions: outcome.omissions }));
  linuxAssert(outcome.status !== "FAIL", outcome.primary ?? "LINUX_QUALIFICATION_FAILED");
}

async function runQualifiedLinuxWorkload({ plan, image, engine, writer, schedule, observed, approvalSha256, sourceNames, evidenceDirectory, outcome }) {
  const abort = new AbortController(), interrupted = () => abort.abort(new LinuxSafetyError("LINUX_CONTROLLER_INTERRUPTED"));
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted); let harness, worker, entered = false, teardown;
  try {
    const admission = createLinuxWorkloadAdmission({ plan, observed, manifestSha256: approvalSha256, authorized: process.env.P1C_WORKLOAD_AUTHORIZED === "true", schedule, record: writer.record });
    const { createLinuxQualificationHarness } = await import("./m13-p1-environment.mjs");
    schedule.admit("bootstrap"); harness = await createLinuxQualificationHarness({ engine, image, sourceNames, evidenceDirectory, signal: abort.signal, toolHashes: plan.tools, admission });
    await boundedAdmissionPhase("bootstrap", schedule, writer, () => harness.create(), error => abort.abort(error));
    await boundedAdmissionPhase("writers", schedule, writer, async () => { await harness.run("migrate"); schedule.admit("writers"); await harness.run("seed"); }, error => abort.abort(error));
    entered = true; worker = await boundedAdmissionPhase("worker", schedule, writer, () => harness.run("worker-runtime"), error => abort.abort(error));
  } catch (error) { preserveLinuxAdmissionFailure(outcome, error); }
  finally {
    if (harness) { try { await boundedAdmissionPhase("teardown", schedule, writer, async deadline => {
      teardown = await harness.close();
      if (teardown.complete) {
        // Cleanup is a distinct, image-only capability inside the SAME 70s tail;
        // it cannot recreate preparation, start a tool, pull or build an image.
        const owner = createPreparationAuthority({ deadline, purpose: "OWNED_ARTIFACT_CLEANUP", ownedImage: image.imageId, attempt: image.preparationOwner, record: value => writer.record("authority", value) });
        try { await withPreparationAuthority(owner, () => removeOwnedLinuxImage({ image, engine, authority: owner, record: writer.record }));
          for (let count = 0; count < 50 && !owner.quiescent(); count++) await new Promise(done => setTimeout(done, 10));
          owner.assert(); linuxAssert(owner.quiescent(), "LINUX_PREPARATION_JOIN_INCOMPLETE"); recordPreparationFacts(writer, owner); owner.seal(); outcome.artifactCleanup = "PASS_VERIFIED";
        } catch (error) { outcome.artifactCleanup = "FAIL"; owner.revoke(error); const reconciliation = await owner.stop({ deadline }); outcome.secondary.push(...reconciliation.failures);
          try { recordPreparationFacts(writer, owner); } catch { outcome.omissions.push("LINUX_ARTIFACT_CLEANUP_EVIDENCE_INCOMPLETE"); } throw error; }
        finally { owner.dispose(); }
      }
    }, error => abort.abort(error)); }
      catch (error) { outcome.secondary.push(codeOf(error)); } }
    process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
  }
  const finalOwner = createPreparationAuthority({ deadline: finalizationDeadline(schedule), purpose: "EVIDENCE_FINALIZATION" });
  try { await withPreparationAuthority(finalOwner, async () => {
  let partial = worker?.workerReceipt;
  if (entered && !partial && harness) {
    try { const path = join(evidenceDirectory, "worker-runtime.json"), info = await lstat(path); linuxAssert(info.isFile() && !info.isSymbolicLink() && info.size <= 4 * 1024 ** 2, "LINUX_PARTIAL_RECEIPT_INVALID");
      const receipt = parseLinuxJson(await readFile(path), 4 * 1024 ** 2), own = harness.receipt(); linuxAssert(receipt.runId === own.runId && receipt.generation === own.generation, "LINUX_PARTIAL_RECEIPT_INVALID"); partial = receipt; }
    catch { outcome.omissions.push("LINUX_PARTIAL_RECEIPT_NOT_VERIFIABLE"); }
  }
  if (entered) for (const key of Object.keys(outcome.scenarios)) outcome.scenarios[key] = evStatus(partial?.scenarios?.[key]) ? partial.scenarios[key] : "NOT_VERIFIABLE";
  for (const row of partial?.persistedResults ?? []) writer.record("delivery", { id: row.id, status: row.status, channel: row.channel, attemptCount: row.attempt_count, receiptCount: row.receipts,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null, leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    availableAt: row.available_at ? new Date(row.available_at).toISOString() : null, failure: row.terminal_failure_code ?? null, providerKind: row.provider_kind ?? null,
    referenceSha256: row.provider_reference ? digest(row.provider_reference) : null, payloadHash: row.payload_hash ?? null,
    attempts: row.attempts.map(value => ({ number: value.number, outcome: value.outcome, failure: value.failure ?? null, deduplicated: value.deduplicated ?? null,
      startedAt: new Date(value.startedAt).toISOString(), completedAt: value.completedAt ? new Date(value.completedAt).toISOString() : null })) });
  outcome.processesJoined = teardown?.processesJoined === true; outcome.sqlQuiescence = teardown?.sqlQuiescence ?? "NOT_VERIFIABLE"; outcome.teardownComplete = teardown?.complete === true;
  if (entered) outcome.scenarios.C10 = worker && !outcome.primary && outcome.teardownComplete && outcome.processesJoined ? "PASS_VERIFIED" : "NOT_VERIFIABLE";
  const source = await linuxSourceInventory(fileURLToPath(new URL("../", import.meta.url)), sourceNames); linuxAssert(source.freeze === image.sourceFreeze, "LINUX_SOURCE_CHANGED");
  await measureLinuxPreparation(engine, evidenceDirectory, "after-teardown", { root: fileURLToPath(new URL("../", import.meta.url)), evidence: evidenceDirectory });
  outcome.status = !outcome.primary && outcome.secondary.length === 0 && outcome.omissions.length === 0 && outcome.teardownComplete
    && outcome.artifactCleanup === "PASS_VERIFIED" && Object.values(outcome.scenarios).every(value => value === "PASS_VERIFIED") ? "PASS_VERIFIED" : "FAIL";
  }); } finally { finalOwner.dispose(); }
}

async function finalizeLinuxAdmissionEvidence(directory, destination) {
  const schedule = linuxJobSchedule(Number(process.env.P1C_JOB_STARTED_UPTIME_MS)); schedule.admit("finalization");
  assertRetentionEligibility();
  const owner = createPreparationAuthority({ deadline: finalizationDeadline(schedule), purpose: "EVIDENCE_FINALIZATION" });
  let receipt;
  try { receipt = await withPreparationAuthority(owner, async () => {
    const identity = parseLinuxJson(await readFile(join(directory, "identity.json"))), outcomePath = join(directory, "outcome.json");
    try { await lstat(outcomePath); }
    catch (error) { if (error.code !== "ENOENT") throw error; const writer = createLinuxEvidence(directory, identity, { resume: true }), outcome = createLinuxAdmissionOutcome(identity.mode);
      outcome.primary = "LINUX_RESULT_NOT_COMPLETED"; outcome.omissions.push("LINUX_RUNTIME_EVIDENCE_INCOMPLETE"); owner.assert(); writer.outcome(outcome); }
    const result = await packageLinuxEvidence(directory, destination); owner.assert(); return result;
  }); } catch (error) { owner.revoke(error); await owner.stop({ deadline: Math.min(linuxAdmissionNow() + 1000, schedule.ends.retention) }); throw error; }
  finally { owner.dispose(); }
  assertLinuxRetentionTail(schedule);
  // Only an exact archive path is exported; no directory or wildcard upload.
  linuxAssert(!/[\r\n]/u.test(receipt.path), "LINUX_EVIDENCE_PATH_INVALID");
  appendFileSync(process.env.GITHUB_ENV, "P1C_UPLOAD_FILE=" + receipt.path + "\nP1C_ARCHIVE_SHA256=" + receipt.sha256 + "\n", { encoding: "utf8" });
  console.log(JSON.stringify({ evidenceSha256: receipt.sha256, bytes: receipt.bytes, manifestSha256: receipt.manifestSha256, retentionDays: receipt.retentionDays }));
}

export function assertLinuxRetentionTail(schedule) { linuxAssert(schedule.remaining("retention") >= 120000, "LINUX_RETENTION_TAIL_UNAVAILABLE"); }
async function checkpointLinuxAdmissionFailure(error) {
  const schedule = linuxJobSchedule(Number(process.env.P1C_JOB_STARTED_UPTIME_MS)); schedule.admit("finalization");
  const owner = createPreparationAuthority({ deadline: Math.min(finalizationDeadline(schedule), linuxAdmissionNow() + 1000), purpose: "EVIDENCE_FINALIZATION" });
  try { return await withPreparationAuthority(owner, async () => {
    const directory = process.env.P1C_SANITIZED_DIRECTORY, path = join(directory, "outcome.json"), identityPath = join(directory, "identity.json");
    const metadata = await lstat(identityPath); linuxAssert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1, "LINUX_EVIDENCE_FILE_REJECTED");
    const identity = parseLinuxJson(await readFile(identityPath)); linuxAssert(evIdentity(identity), "LINUX_EVIDENCE_IDENTITY_INVALID");
    let outcome;
    try { const file = await lstat(path); linuxAssert(file.isFile() && !file.isSymbolicLink() && file.nlink === 1, "LINUX_EVIDENCE_FILE_REJECTED"); outcome = parseLinuxJson(await readFile(path)); linuxAssert(evOutcome(outcome), "LINUX_EVIDENCE_OUTCOME_INVALID"); }
    catch (failure) { if (failure.code !== "ENOENT") throw failure; outcome = createLinuxAdmissionOutcome(identity.mode); outcome.omissions.push("LINUX_RUNTIME_EVIDENCE_INCOMPLETE"); }
    preserveLinuxAdmissionFailure(outcome, error);
    await writeFile(path, JSON.stringify(outcome) + "\n", { flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0), mode: 0o600 }); return true;
  }); } finally { owner.dispose(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void (async () => {
    if (process.argv[2] === "--admission-job" && process.argv.length === 9) await bootstrapLinuxJob(...process.argv.slice(3));
    else if (process.argv[2] === "--discovery-job" && process.argv.length === 7) await continueLinuxJob("ARTIFACT_DISCOVERY", ...process.argv.slice(3));
    else if (process.argv[2] === "--qualified-job" && process.argv.length === 7) await continueLinuxJob("QUALIFIED_WORKLOAD", ...process.argv.slice(3));
    else if (process.argv[2] === "--finalize-evidence" && process.argv.length === 5) await finalizeLinuxAdmissionEvidence(...process.argv.slice(3));
    else throw new LinuxSafetyError("LINUX_IMAGE_COMMAND_REJECTED");
  })().catch(async error => { let checkpoint = false; try { checkpoint = await checkpointLinuxAdmissionFailure(error); } catch { /* Missing evidence stays explicit; never replace the primary. */ }
    console.error(JSON.stringify({ code: codeOf(error), failureEvidenceCheckpoint: checkpoint ? "RECORDED" : "NOT_VERIFIABLE" })); process.exitCode = 2; });
}
