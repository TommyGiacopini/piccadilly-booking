import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, constants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { createServer, isIPv4 } from "node:net";
import { request as httpRequest } from "node:http";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

export const NODE_REFERENCE = "24.14.1";
export const ARCHIVE_NAME = "node-v24.14.1-win-x64.zip";
// Authenticated against the official clearsigned manifest; see the runbook.
export const ARCHIVE_SHA256 = "6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70";
export const DISTRIBUTION_URL = "https://nodejs.org/dist/v24.14.1/";
export const POSTGRES_IMAGE = "postgres:18.4-alpine3.24";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const verifiedRuntimes = new WeakSet();
const runtimeVerifiers = new Set();
const applicationProcesses = new Set();
const engineRequests = new Set();
export const D13_LIMITS = Object.freeze({ fullTargetMs: 15_000, fullMaximumMs: 60_000, operationalMs: 15_000, fileConcurrency: 8 });
const exec = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const timestamp = () => new Date().toISOString();
const pause = ms => new Promise(done => setTimeout(done, ms));
const osKeys = ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME"];
export class SafetyError extends Error {
  constructor(code) { super(code); this.name = "SafetyError"; this.code = code; }
}
const requireSafe = (condition, code) => { if (!condition) throw new SafetyError(code); };
const inside = (root, path) => { const part = relative(resolve(root), resolve(path)); return part === "" || (!part.startsWith("..") && !isAbsolute(part)); };

export function cleanEnvironment(source, runtimeDirectory) {
  for (const key of Object.keys(source)) {
    if (/^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_REPL_EXTERNAL_MODULE|DATABASE_URL|DOCKER_HOST|DOCKER_CONTEXT|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|RENDER|RENDER_SERVICE_ID|RENDER_EXTERNAL_URL)$/iu.test(key)) {
      requireSafe(!source[key], "UNTRUSTED_ENVIRONMENT");
    }
  }
  const environment = {};
  for (const name of osKeys) {
    const entry = Object.entries(source).find(([key]) => key.toUpperCase() === name.toUpperCase());
    if (entry && typeof entry[1] === "string") environment[name] = entry[1];
  }
  environment.PATH = [runtimeDirectory, join(projectRoot, "node_modules", ".bin"), join(environment.SystemRoot ?? "/", "System32")].join(delimiter);
  return environment;
}

export function redact(text, secrets = []) {
  let safe = String(text);
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) safe = safe.replaceAll(secret, "[REDACTED]");
  return safe.replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, "[REDACTED_DATABASE_URL]")
    .replace(/(?:__Host-)?piccadilly_session=[^\s;"']+/giu, "[REDACTED_COOKIE]")
    .replace(/(authorization|x-piccadilly-draft-session-binding)\s*[:=]\s*[^\r\n]+/giu, "$1: [REDACTED]");
}

// Read only selected members of an already authenticated ZIP, without extraction.
export function zipMembers(buffer, include = name => name.endsWith("/node.exe") || name.includes("/node_modules/npm/")) {
  let end = buffer.length - 22;
  while (end >= Math.max(0, buffer.length - 65_557) && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  requireSafe(end >= 0 && buffer.readUInt32LE(end) === 0x06054b50, "ARCHIVE_INVALID");
  const members = new Map();
  let offset = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    requireSafe(buffer.readUInt32LE(offset) === 0x02014b50, "ARCHIVE_INVALID");
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 24), packed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    requireSafe(!name.startsWith("/") && !name.split("/").includes("..") && !members.has(name), "ARCHIVE_INVALID");
    if (include(name)) {
      const local = buffer.readUInt32LE(offset + 42);
      requireSafe(size <= 128 * 1024 * 1024 && buffer.readUInt32LE(local) === 0x04034b50, "ARCHIVE_INVALID");
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const payload = buffer.subarray(start, start + packed);
      requireSafe(method === 0 || method === 8, "ARCHIVE_INVALID");
      const body = method === 8 ? inflateRawSync(payload, { maxOutputLength: Math.max(1, size) }) : payload;
      requireSafe(body.length === size, "ARCHIVE_INVALID");
      if (!name.endsWith("/")) members.set(name, body);
    }
    offset += 46 + nameLength + extra + comment;
  }
  return members;
}

async function regularBytes(path, signal) {
  const info = await lstat(path);
  requireSafe(info.isFile() && !info.isSymbolicLink(), "NON_REGULAR_FILE");
  return readFile(path, signal ? { signal } : undefined);
}
export async function checkBundledFiles(runtimeDirectory, members) {
  requireSafe(!(await lstat(join(runtimeDirectory, "node_modules", "npm"))).isSymbolicLink(), "BUNDLED_LINK_REJECTED");
  const prefix = "node-v24.14.1-win-x64/";
  requireSafe(members.has(prefix + "node.exe") && members.has(prefix + "node_modules/npm/package.json"), "BUNDLED_NPM_MISSING");
  const expected = new Map([...members].map(([name, body]) => [name.slice(prefix.length), hash(body)]));
  for (const [name, digest] of expected) requireSafe(hash(await regularBytes(join(runtimeDirectory, name))) === digest, "BUNDLED_FILE_MISMATCH");
  async function walk(folder) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      requireSafe(!item.isSymbolicLink(), "BUNDLED_LINK_REJECTED");
      const path = join(folder, item.name);
      if (item.isDirectory()) await walk(path);
      else requireSafe(item.isFile() && expected.has(relative(runtimeDirectory, path).split("\\").join("/")), "UNEXPECTED_NPM_FILE");
    }
  }
  await walk(join(runtimeDirectory, "node_modules", "npm"));
  return { expected, npmVersion: JSON.parse(members.get(prefix + "node_modules/npm/package.json").toString()).version };
}

export function verificationQuiescence(registry = runtimeVerifiers) {
  const records = [...registry].map(record => ({ ...record }));
  const active = records.filter(record => !record.exitObserved).length;
  return { verified: active === 0, active, unknown: records.filter(record => record.state === "UNKNOWN").length, records };
}

export function ownedProcessQuiescence(records = applicationProcesses) {
  const rows = [...records].map(record => ({ ...record }));
  return { verified: rows.every(row => row.state === "JOINED" || row.state === "NOT_STARTED"), active: rows.filter(row => row.state === "ACTIVE").length, unknown: rows.filter(row => row.state === "UNKNOWN").length, records: rows };
}

// Only this fixed, read-only worker entry is used in a verified runtime. The
// injected factory is for synthetic tests and cannot mint a runtime capability.
export async function verifyFilesBounded(payload, control = {}, { registry = runtimeVerifiers, workerFactory = data => new Worker(new URL(import.meta.url), { workerData: data, execArgv: [], env: Object.fromEntries(osKeys.filter(key => process.env[key]).map(key => [key, process.env[key]])) }), joinMs = 5_000, maximumMs = D13_LIMITS.operationalMs } = {}) {
  const now = () => performance.now(), started = now();
  control.beforeSpawn?.();
  requireSafe(!control.signal?.aborted, control.signal?.reason?.code ?? "RUN_ABORTED");
  requireSafe([D13_LIMITS.operationalMs, D13_LIMITS.fullMaximumMs].includes(maximumMs), "VERIFIER_CAP_INVALID");
  const limit = Math.floor(Math.min(maximumMs, control.timeoutMs ?? maximumMs, control.effectiveTimeout?.() ?? maximumMs));
  requireSafe(limit >= 1 && joinMs > 0 && joinMs <= 5_000, "OPERATION_PHASE_TIMEOUT");
  const id = randomUUID(), manifest = hash(JSON.stringify(payload.files)), deadline = started + limit;
  const record = { id, manifest, mode: payload.mode, state: "STARTING", startedMonotonicMs: started, deadlineMonotonicMs: deadline, effectiveTimeoutMs: limit, exitObserved: false, abortRequestedMonotonicMs: null, endMonotonicMs: null, workElapsedMs: null, abortJoinElapsedMs: 0, primaryFailure: null, abortFailure: null, joinFailure: null };
  registry.add(record);
  return new Promise((resolveVerifier, rejectVerifier) => {
    let worker, message, primary, settled = false, stopping = false, drainTimer, timer;
    const emit = kind => { try { control.record?.(kind, { ...record }); } catch { record.secondaryDiagnosticFailure = "VERIFIER_RECEIPT_WRITE_FAILED"; primary ??= new SafetyError("EVIDENCE_WRITE_FAILED"); } };
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(drainTimer); control.signal?.removeEventListener("abort", abort);
      record.endMonotonicMs = now(); record.workElapsedMs ??= record.endMonotonicMs - started;
      if (record.abortRequestedMonotonicMs !== null) record.abortJoinElapsedMs = record.endMonotonicMs - record.abortRequestedMonotonicMs;
      record.primaryFailure = primary?.code ?? null; emit("runtime-verifier-settled"); record.primaryFailure = primary?.code ?? null;
      if (primary) { primary.verification = { ...record }; rejectVerifier(primary); }
      else resolveVerifier({ ...record, files: message.files, result: "VERIFIED" });
    };
    const stop = error => {
      primary ??= error instanceof SafetyError ? error : new SafetyError(error?.code ?? "RUN_ABORTED");
      if (stopping || settled) return; stopping = true; record.state = "STOPPING";
      record.abortRequestedMonotonicMs = now(); record.workElapsedMs = record.abortRequestedMonotonicMs - started;
      emit("runtime-verifier-abort");
      drainTimer = setTimeout(() => { record.state = "UNKNOWN"; record.joinFailure = "VERIFIER_JOIN_INCOMPLETE"; primary.joinFailure = record.joinFailure; worker?.unref?.(); finish(); }, joinMs);
      try {
        worker?.postMessage({ kind: "abort", id });
      } catch { record.abortFailure = "VERIFIER_ABORT_MESSAGE_FAILED"; }
      try { Promise.resolve(worker?.terminate()).catch(() => { record.abortFailure = "VERIFIER_TERMINATE_FAILED"; }); }
      catch { record.abortFailure = "VERIFIER_TERMINATE_FAILED"; }
    };
    const abort = () => stop(control.signal.reason ?? new SafetyError("RUN_ABORTED"));
    timer = setTimeout(() => stop(new SafetyError("OPERATION_PHASE_TIMEOUT")), Math.max(1, Math.floor(deadline - now())));
    control.signal?.addEventListener("abort", abort, { once: true });
    try {
      emit("runtime-verifier-start"); if (primary) throw primary; control.beforeSpawn?.();
      requireSafe(now() < deadline && !control.signal?.aborted, "OPERATION_PHASE_TIMEOUT");
      worker = workerFactory({ kind: "m13-runtime-verifier", id, manifest, ...payload });
      record.threadId = worker.threadId; record.state = "ACTIVE";
      worker.on("message", value => {
        if (settled || primary) return;
        if (now() >= deadline || control.signal?.aborted) { stop(control.signal?.reason ?? new SafetyError("OPERATION_PHASE_TIMEOUT")); return; }
        if (value?.kind === "failed") { stop(new SafetyError(value.code ?? "RUNTIME_VALIDATION_FAILED")); return; }
        if (value?.kind !== "verified" || value.id !== id || value.manifest !== manifest || value.files !== payload.files.length || value.version !== process.version || value.execPath !== process.execPath) { stop(new SafetyError("VERIFIER_RECEIPT_INVALID")); return; }
        message = value;
      });
      worker.on("error", () => stop(new SafetyError("RUNTIME_VERIFIER_FAILED")));
      worker.once("exit", code => {
        record.exitObserved = true; record.exitCode = code; record.state = "JOINED";
        if (!primary && (now() >= deadline || control.signal?.aborted)) primary = control.signal?.reason instanceof SafetyError ? control.signal.reason : new SafetyError("OPERATION_PHASE_TIMEOUT");
        if (!primary && (code !== 0 || !message)) primary = new SafetyError("VERIFIER_EXIT_WITHOUT_PROOF");
        finish();
      });
      if (control.signal?.aborted) abort();
    } catch (error) {
      if (worker) stop(error);
      else { primary = error; record.state = "NOT_STARTED"; record.exitObserved = true; finish(); }
    }
  });
}

async function runtimeVerifierEntry(data) {
  const controller = new AbortController();
  const abort = value => { if (value?.kind === "abort" && value.id === data.id) controller.abort(new SafetyError("RUN_ABORTED")); };
  parentPort.on("message", abort);
  const guard = () => { if (controller.signal.aborted) throw controller.signal.reason; };
  try {
    requireSafe(isAbsolute(data.root) && ["bundle", "binary", "psql"].includes(data.mode) && data.files.length > 0, "VERIFIER_INPUT_INVALID");
    const expected = new Map(data.files);
    requireSafe(expected.size === data.files.length && [...expected].every(([name, digest]) => typeof name === "string" && !isAbsolute(name) && !name.split(/[\\/]/u).some(part => part === ".." || part === "" || part === ".") && /^[a-f0-9]{64}$/u.test(digest)), "VERIFIER_INPUT_INVALID");
    if (data.mode !== "psql") requireSafe(await realpath(process.execPath) === await realpath(join(data.root, "node.exe")), "EXTERNAL_NODE_REJECTED");
    if (data.mode === "bundle") requireSafe(!(await lstat(join(data.root, "node_modules/npm"))).isSymbolicLink(), "BUNDLED_LINK_REJECTED");
    const entries = [...expected]; let next = 0;
    // Bounded I/O concurrency; every expected byte is still hashed. CPU work is
    // confined to this terminable worker, never the parent's deadline loop.
    await Promise.all(Array.from({ length: Math.min(D13_LIMITS.fileConcurrency, entries.length) }, async () => {
      while (next < entries.length) { guard(); const [name, digest] = entries[next++]; const bytes = await regularBytes(join(data.root, name), controller.signal); guard(); requireSafe(hash(bytes) === digest, data.mode === "psql" ? "PSQL_BUNDLE_CHANGED" : "BUNDLED_FILE_MISMATCH"); guard(); }
    }));
    async function walk(folder) {
      guard(); const entries = await readdir(folder, { withFileTypes: true }); guard();
      for (const item of entries) { guard(); requireSafe(!item.isSymbolicLink(), "BUNDLED_LINK_REJECTED"); const path = join(folder, item.name); if (item.isDirectory()) { requireSafe(data.mode !== "psql", "PSQL_UNEXPECTED_FILE"); await walk(path); } else requireSafe(item.isFile() && expected.has(relative(data.root, path).split("\\").join("/")), data.mode === "psql" ? "PSQL_UNEXPECTED_FILE" : "UNEXPECTED_NPM_FILE"); }
    }
    if (data.mode !== "binary") await walk(data.mode === "bundle" ? join(data.root, "node_modules/npm") : data.root);
    guard(); parentPort.postMessage({ kind: "verified", id: data.id, manifest: data.manifest, files: expected.size, version: process.version, execPath: process.execPath });
  } catch (error) { parentPort.postMessage({ kind: "failed", code: error instanceof SafetyError ? error.code : "RUNTIME_VALIDATION_FAILED" }); }
  finally { parentPort.removeListener("message", abort); parentPort.close(); }
}

async function executeChild(args, environment, { signal, deadlineMs = 1_800_000, secrets = [], stdout = () => {} } = {}) {
  requireSafe(!signal?.aborted, "ABORTED_BEFORE_SPAWN");
  const startedAt = timestamp(), started = Date.now();
  const child = spawn(process.execPath, args, { cwd: projectRoot, env: environment, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const owned = { pid: child.pid ?? null, state: child.pid ? "ACTIVE" : "NOT_STARTED", startedAt }; applicationProcesses.add(owned);
  child.once("close", () => { owned.state = "JOINED"; owned.endedAt = timestamp(); });
  let reason, chunks = [], bytes = 0, stopping, joinTimer, killTimer;
  let finish = () => {};
  const stop = code => {
    reason ??= code;
    if (stopping || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    stopping = (async () => {
      if (process.platform === "win32") {
        await exec(join(environment.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }).catch(() => { reason = "PROCESS_TREE_STOP_INCOMPLETE"; child.kill("SIGKILL"); });
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch { reason = "PROCESS_TREE_STOP_INCOMPLETE"; }
        killTimer = setTimeout(() => { if (child.exitCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch { reason = "PROCESS_TREE_STOP_INCOMPLETE"; } } }, 2_000);
      }
      joinTimer = setTimeout(() => { reason = "PROCESS_JOIN_INCOMPLETE"; child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish({ exitCode: child.exitCode, signal: child.signalCode, reason, joined: false }); }, 5_000);
    })();
  };
  const abort = () => stop("ABORTED_AFTER_SPAWN");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("CHILD_DEADLINE"), deadlineMs);
  const capture = chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) stop("OUTPUT_LIMIT"); else chunks.push(chunk); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  const result = await new Promise(resolveChild => {
    finish = resolveChild;
    child.once("error", () => resolveChild({ exitCode: null, signal: null, reason: "SPAWN_ERROR", joined: true }));
    child.once("close", (code, childSignal) => resolveChild({ exitCode: code, signal: childSignal, reason, joined: true }));
    child.once("exit", () => { if (!joinTimer) joinTimer = setTimeout(() => { reason = "PROCESS_JOIN_INCOMPLETE"; child.stdout.destroy(); child.stderr.destroy(); child.unref(); resolveChild({ exitCode: child.exitCode, signal: child.signalCode, reason, joined: false }); }, 5_000); });
  });
  clearTimeout(timer); signal?.removeEventListener("abort", abort); await stopping; clearTimeout(joinTimer); clearTimeout(killTimer);
  if (result.joined === false && owned.state !== "JOINED") owned.state = "UNKNOWN";
  const output = redact(Buffer.concat(chunks).toString("utf8"), secrets); chunks = [];
  await stdout(output);
  return { ...result, reason: reason ?? result.reason ?? null, pid: child.pid ?? null, startedAt, endedAt: timestamp(), durationMs: Date.now() - started, executable: process.execPath, args };
}

export async function verifyRuntime(distributionDirectory) {
  requireSafe(process.version === "v" + NODE_REFERENCE && platform() === "win32" && arch() === "x64", "REFERENCE_LANE_NOT_EXECUTED");
  requireSafe(process.execArgv.length === 0, "PRELOAD_OR_NODE_FLAGS_REJECTED");
  const directory = resolve(distributionDirectory), root = join(directory, "node-v24.14.1-win-x64");
  requireSafe(await realpath(process.execPath) === await realpath(join(root, "node.exe")), "EXTERNAL_NODE_REJECTED");
  const archive = await regularBytes(join(directory, ARCHIVE_NAME));
  requireSafe(hash(archive) === ARCHIVE_SHA256, "DISTRIBUTION_HASH_MISMATCH");
  const manifest = (await regularBytes(join(directory, "SHASUMS256.txt"))).toString();
  requireSafe(manifest.split(/\r?\n/u).some(line => line === ARCHIVE_SHA256 + "  " + ARCHIVE_NAME), "MANIFEST_MISMATCH");
  const members = zipMembers(archive), prefix = "node-v24.14.1-win-x64/";
  requireSafe(members.has(prefix + "node.exe") && members.has(prefix + "node_modules/npm/package.json"), "BUNDLED_NPM_MISSING");
  const bundled = { expected: new Map([...members].map(([name, body]) => [name.slice(prefix.length), hash(body)])), npmVersion: JSON.parse(members.get(prefix + "node_modules/npm/package.json").toString()).version };
  const fullQualification = await verifyFilesBounded({ root, mode: "bundle", files: [...bundled.expected] }, { timeoutMs: D13_LIMITS.fullMaximumMs }, { maximumMs: D13_LIMITS.fullMaximumMs });
  const environment = cleanEnvironment(process.env, root);
  environment.NPM_CONFIG_USERCONFIG = join(directory, "unused-user.npmrc");
  environment.NPM_CONFIG_GLOBALCONFIG = join(directory, "unused-global.npmrc");
  environment.NPM_CONFIG_CACHE = join(directory, "npm-cache");
  const npmCli = join(root, "node_modules/npm/bin/npm-cli.js");
  let output = "";
  const command = await executeChild([npmCli, "--version"], environment, { deadlineMs: 30_000, stdout: value => { output = value; } });
  requireSafe(command.exitCode === 0 && !command.reason && output.trim() === bundled.npmVersion, "NPM_VERSION_MISMATCH");
  const receipt = { execPath: process.execPath, version: process.version, os: platform(), arch: arch(), osRelease: release(), binarySha256: hash(await regularBytes(process.execPath)), archiveSha256: ARCHIVE_SHA256, archiveUrl: DISTRIBUTION_URL + ARCHIVE_NAME, manifestUrl: DISTRIBUTION_URL + "SHASUMS256.txt", trustAnchor: "Official signed-manifest SHA256 pinned in source; independent GPG verification in bootstrap evidence", npmCli, npmVersion: bundled.npmVersion, npmCliSha256: bundled.expected.get("node_modules/npm/bin/npm-cli.js"), npmProvenance: "VERIFIED_OFFICIAL_ARCHIVE_BUNDLE", nodePinPass: true, operationalSecurityApproval: false, npmVersionCommand: command, fullQualification };
  requireSafe(bundled.expected.get("node.exe") === receipt.binarySha256, "RUNTIME_CHANGED");
  const expected = [...bundled.expected].map(row => Object.freeze([...row])); Object.freeze(expected);
  const runtime = { directory: root, npmCli, receipt,
    assertQualified: control => verifyFilesBounded({ root, mode: "bundle", files: expected }, control, { maximumMs: D13_LIMITS.fullMaximumMs }),
    assertOperationalLive: control => verifyFilesBounded({ root, mode: "binary", files: [["node.exe", receipt.binarySha256]] }, control),
    assertExecutionLive: control => verifyFilesBounded({ root, mode: "binary", files: [["node.exe", receipt.binarySha256]] }, control),
    assertLive: control => verifyFilesBounded({ root, mode: "bundle", files: expected }, control) };
  verifiedRuntimes.add(runtime); return runtime;
}

// Positive correlation only: an empty effective mapping is not a published port.
// These snapshots deliberately exclude Config.Env and all credential material.
export function inspectDockerBinding(container) {
  const requested = container.HostConfig?.PortBindings ?? {};
  const observed = container.NetworkSettings?.Ports ?? {};
  const safePorts = ports => Object.fromEntries(Object.entries(ports).map(([key, rows]) => [
    /^\d{1,5}\/(?:tcp|udp)$/u.test(key) ? key : "[INVALID_PORT_KEY]",
    rows === null ? null : Array.isArray(rows) ? rows.map(row => ({ HostIp: typeof row?.HostIp === "string" && /^[\da-fA-F:.\[\]]{0,64}$/u.test(row.HostIp) ? row.HostIp : "[INVALID_HOST]", HostPort: typeof row?.HostPort === "string" && /^\d{0,5}$/u.test(row.HostPort) ? row.HostPort : "[INVALID_PORT]" })) : "[INVALID_BINDINGS]",
  ]));
  let code = null, candidateMapping = null;
  const configuration = requested["5432/tcp"], bindings = observed["5432/tcp"];
  const validPort = value => typeof value === "string" && /^\d{1,5}$/u.test(value) && Number(value) >= 1 && Number(value) <= 65535;
  if (Object.keys(requested).length !== 1 || !Array.isArray(configuration) || configuration.length !== 1 || configuration[0]?.HostIp !== "127.0.0.1" || configuration[0]?.HostPort !== "") code = "PORT_CONFIGURATION_MISMATCH";
  else if (Object.keys(observed).length === 0 || (Object.keys(observed).length === 1 && (bindings === null || Array.isArray(bindings) && bindings.length === 0))) code = "PORT_BINDING_NOT_PUBLISHED";
  else if (Object.keys(observed).length !== 1 || !Array.isArray(bindings) || bindings.length !== 1) code = "PORT_BINDING_AMBIGUOUS";
  else if (bindings[0]?.HostIp !== configuration[0].HostIp || !validPort(bindings[0]?.HostPort)) code = "PORT_BINDING_UNSAFE";
  else candidateMapping = { HostIp: bindings[0].HostIp, HostPort: bindings[0].HostPort, containerPort: "5432/tcp" };
  return { requestedBinding: "127.0.0.1::5432", hostConfigPortBindings: safePorts(requested), networkSettingsPorts: safePorts(observed), classification: code ? "REJECTED" : "METADATA_CORRELATED", code, candidateMapping };
}

export function assertResourceMetadata(lease, container, network, running = true) {
  const labels = container.Config?.Labels ?? {}, host = container.HostConfig ?? {};
  requireSafe(container.Id === lease.containerId && labels["piccadilly.owner"] === lease.owner && labels["piccadilly.run"] === lease.runId, "OWNERSHIP_MISMATCH");
  requireSafe(container.Created === lease.createdAt && container.Image === lease.imageId && container.Config.Image === lease.imageId, "CREATION_IDENTITY_MISMATCH");
  requireSafe(container.Path === "docker-entrypoint.sh" && container.Args.join(" ") === "postgres", "CONTAINER_PROCESS_MISMATCH");
  const configured = Object.fromEntries((container.Config.Env ?? []).map(item => { const at = item.indexOf("="); return [item.slice(0, at), item.slice(at + 1)]; }));
  requireSafe(configured.POSTGRES_DB === lease.database && configured.POSTGRES_USER === lease.role && configured.POSTGRES_PASSWORD === lease.password, "DATABASE_CREDENTIALS_MISMATCH");
  requireSafe((container.Mounts ?? []).every(m => m.Type === "tmpfs" && m.Destination === "/var/lib/postgresql") && Object.keys(host.Tmpfs ?? {}).join() === "/var/lib/postgresql", "PERSISTENT_MOUNT_REJECTED");
  requireSafe(!host.Binds?.length && !host.Privileged && host.NetworkMode === lease.networkId, "CONTAINER_CONFIG_MISMATCH");
  requireSafe(network.Id === lease.networkId && network.Internal === true && network.Labels?.["piccadilly.owner"] === lease.owner && network.Labels?.["piccadilly.run"] === lease.runId, "NETWORK_OWNERSHIP_MISMATCH");
  requireSafe(!Object.keys(network.Containers ?? {}).some(id => id !== lease.containerId), "FOREIGN_NETWORK_MEMBER");
  if (running) {
    requireSafe(container.State?.Running === true && container.State.Pid > 0, "CONTAINER_NOT_RUNNING");
    const binding = inspectDockerBinding(container);
    requireSafe(binding.classification === "METADATA_CORRELATED", binding.code);
    requireSafe(Object.keys(container.NetworkSettings.Networks ?? {}).length === 1 && Object.values(container.NetworkSettings.Networks)[0].NetworkID === lease.networkId, "NETWORK_TARGET_MISMATCH");
    return binding.candidateMapping.HostPort;
  }
}
export function assertServerIdentity(lease, identity) {
  requireSafe(identity.database === lease.database && identity.role === lease.role && /^18\.4(?:\s|$)/u.test(identity.version) && identity.serverPort === 5432, "DATABASE_IDENTITY_MISMATCH");
  requireSafe(identity.dataDirectory.startsWith("/var/lib/postgresql/") && /^\d+$/u.test(identity.systemIdentifier), "DATABASE_STORAGE_MISMATCH");
  requireSafe(!lease.systemIdentifier || lease.systemIdentifier === identity.systemIdentifier, "SERVER_IDENTITY_CHANGED");
}

const identitySql = "SELECT json_build_object('database',current_database(),'role',current_user,'version',current_setting('server_version'),'dataDirectory',current_setting('data_directory'),'systemIdentifier',(pg_control_system()).system_identifier::text,'serverPort',inet_server_port())";
async function tool(path, args, environment, operations = []) {
  const startedAt = timestamp();
  const running = exec(path, args, { cwd: projectRoot, env: environment, windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  try {
    const result = await running;
    operations.push({ executable: path, args: args.map(value => /^(SELECT |BEGIN READ ONLY)/u.test(value) ? "[READ_ONLY_IDENTITY_QUERY]" : value), pid: running.child?.pid ?? null, startedAt, endedAt: timestamp(), exitCode: 0 });
    return result.stdout.trim();
  } catch {
    operations.push({ executable: path, operation: args[2] ?? args[0], pid: running.child?.pid ?? null, startedAt, endedAt: timestamp(), result: "FAILED" });
    throw new SafetyError("INFRASTRUCTURE_INTROSPECTION_UNAVAILABLE");
  }
}
async function realBackend(runtime) {
  const environment = cleanEnvironment(process.env, runtime.directory);
  const docker = join(environment.LOCALAPPDATA, "Programs/DockerDesktop/resources/bin/docker.exe");
  const git = join(process.env.ProgramFiles ?? "C:/Program Files", "Git/cmd/git.exe");
  await access(docker, constants.F_OK); await access(git, constants.F_OK);
  const context = JSON.parse(await tool(docker, ["context", "inspect"], environment));
  requireSafe(context.length === 1 && context[0].Endpoints?.docker?.Host === "npipe:////./pipe/dockerDesktopLinuxEngine", "NON_LOCAL_DOCKER_REJECTED");
  const endpoint = context[0].Endpoints.docker.Host;
  const operations = [];
  return { docker: (args, extra = {}) => tool(docker, ["--host", endpoint, ...args], { ...environment, ...extra }, operations),
    source: async () => {
      const paths = (await tool(git, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], environment)).split("\0").filter(Boolean).sort();
      const inventory = [];
      for (const name of paths) inventory.push({ name, sha256: hash(await regularBytes(join(projectRoot, name))) });
      return { files: inventory.length, freeze: hash(JSON.stringify(inventory)) };
    },
    applicationPort: async () => {
      for (const host of ["127.0.0.1", "::1"]) await new Promise((done, rejected) => {
        const server = createServer();
        server.once("error", () => rejected(new SafetyError("APPLICATION_PORT_NOT_FREE")));
        server.listen({ host, port: 4000, exclusive: true }, () => server.close(error => error ? rejected(new SafetyError("APPLICATION_PORT_NOT_FREE")) : done()));
      });
    },
    child: executeChild, toolchain: { docker, dockerSha256: hash(await regularBytes(docker)), git, gitSha256: hash(await regularBytes(git)), endpoint, operations } };
}

export function commandDefinitions(runtime) {
  const npm = (...args) => [runtime.npmCli, ...args];
  return {
    ci: npm("ci", "--no-audit", "--no-fund"), unit: ["--test", "scripts/m13-p1-environment.test.mjs", "scripts/run-e2e.test.mjs"],
    generate: ["node_modules/prisma/build/index.js", "generate"], validate: ["node_modules/prisma/build/index.js", "validate"],
    lint: ["node_modules/eslint/bin/eslint.js", "."], typecheck: ["node_modules/typescript/bin/tsc", "--noEmit"], build: ["node_modules/next/dist/bin/next", "build"],
    migrate: ["node_modules/prisma/build/index.js", "migrate", "deploy"], seed: ["node_modules/prisma/build/index.js", "db", "seed"],
    vitest: ["scripts/run-vitest-isolated.mjs"], "vitest-core": ["scripts/run-vitest-isolated.mjs", "scripts/m13-p1-environment.test.mjs", "scripts/staging-worker-startup.test.mjs", "scripts/start-staging-worker.test.mjs", "scripts/staging-tooling.test.ts", "scripts/run-vitest-isolated.test.mjs", "scripts/run-e2e.test.mjs"],
    e2e: ["scripts/run-e2e.mjs"], "e2e-core": ["scripts/run-e2e.mjs", "tests/e2e/m13-local-readiness.spec.ts", "--workers=1", "--retries=0"],
    "npm-ls": npm("ls", "--all", "--json"), "audit-full": npm("audit", "--json"), "audit-production": npm("audit", "--omit=dev", "--json"),
  };
}
export const PLANS = Object.freeze({ core: ["ci", "unit", "generate", "validate", "lint", "typecheck", "build", "migrate", "seed", "vitest-core", "e2e-core"], full: ["ci", "unit", "generate", "validate", "lint", "typecheck", "build", "migrate", "seed", "vitest", "e2e"], diagnostics: ["npm-ls", "audit-full", "audit-production"] });

export async function createRunHarness({ runtime, adapters, evidenceDirectory, signal, deadlineMs = 1_800_000 }) {
  requireSafe(adapters || verifiedRuntimes.has(runtime), "VERIFIED_RUNTIME_CAPABILITY_REQUIRED");
  // Historical D0/D1 simulation contract, retained for the 82 regression cases.
  // It is never an operational fallback: real execution uses the proxy harness.
  requireSafe(adapters?.toolchain?.simulation === true, "LEGACY_DIRECT_PUBLISH_DISABLED");
  const simulated = Boolean(adapters), backend = adapters ?? await realBackend(runtime);
  const runId = randomUUID(), owner = randomBytes(32).toString("hex"), suffix = randomBytes(16).toString("hex");
  const lease = { runId, owner, database: "piccadilly_e2e_" + suffix, role: "m13_p1_" + suffix.slice(0, 16), password: randomBytes(32).toString("base64url") };
  const secrets = [lease.password], events = [], commands = [];
  let closed = false, busy = false, firstWriter = false, closePromise, evidenceWriteFailed = false;
  if (!simulated) requireSafe(evidenceDirectory && !inside(projectRoot, evidenceDirectory), "ARTIFACTS_MUST_BE_EXTERNAL");
  const event = (kind, fields = {}) => {
    const record = { kind, at: timestamp(), runId, sequence: events.length + 1, ...fields }; events.push(record);
    if (!simulated) {
      try { appendFileSync(join(evidenceDirectory, "events.jsonl"), JSON.stringify(record) + "\n", { encoding: "utf8", flush: true }); }
      catch { evidenceWriteFailed = true; }
    }
  };
  const jsonDocker = async args => JSON.parse(await backend.docker(args));
  const resource = async running => {
    requireSafe(lease.containerId && lease.createdAt && lease.networkId && !closed, "RUN_CREATED_RESOURCE_REQUIRED");
    const containers = await jsonDocker(["inspect", lease.containerId]);
    const networks = await jsonDocker(["network", "inspect", lease.networkId]);
    requireSafe(containers.length === 1 && networks.length === 1, "INSPECT_AMBIGUOUS");
    const binding = inspectDockerBinding(containers[0]);
    event("binding-observed", { expectedContainerId: lease.containerId, observedContainerId: containers[0].Id, networkId: networks[0].Id, runningRequired: running, ...binding, selectedMapping: null, sanitizedTarget: null, dockerPortCheck: "NOT_RUN" });
    let port;
    try { port = assertResourceMetadata(lease, containers[0], networks[0], running); }
    catch (error) { event("resource-rejected", { containerId: lease.containerId, code: error.code ?? "RESOURCE_INVALID", binding }); throw error; }
    if (running) {
      let output;
      try { output = await backend.docker(["port", lease.containerId, "5432/tcp"]); }
      catch { event("publication-check-rejected", { containerId: lease.containerId, code: "PORT_PUBLICATION_NOT_VERIFIABLE", binding }); throw new SafetyError("PORT_PUBLICATION_NOT_VERIFIABLE"); }
      const safeOutput = typeof output === "string" && /^[\da-fA-F:.\[\]\s]{0,1024}$/u.test(output) ? output.trim() : "[INVALID_PUBLICATION_OUTPUT]";
      const correlated = safeOutput === "127.0.0.1:" + port;
      event("publication-observed", { containerId: lease.containerId, binding, dockerPortOutput: safeOutput, classification: correlated ? "ENDPOINT_CORRELATED" : "REJECTED", selectedMapping: correlated ? binding.candidateMapping : null, sanitizedTarget: correlated ? `postgresql://127.0.0.1:${port}/${lease.database}` : null });
      requireSafe(correlated, "PORT_ENDPOINT_MISMATCH");
    }
    return { container: containers[0], network: networks[0], port, binding };
  };
  const preflight = async () => {
    requireSafe(!signal?.aborted, "ABORTED_BEFORE_PREFLIGHT");
    const observed = await resource(true);
    const mounts = await backend.docker(["exec", lease.containerId, "cat", "/proc/mounts"]);
    requireSafe(mounts.split("\n").some(line => line.split(" ")[1] === "/var/lib/postgresql" && line.split(" ")[2] === "tmpfs"), "ACTUAL_TMPFS_NOT_VERIFIED");
    const identity = JSON.parse(await backend.docker(["exec", "--env", "PGPASSWORD", lease.containerId, "psql", "--no-psqlrc", "-h", "127.0.0.1", "-p", "5432", "-U", lease.role, "-d", lease.database, "-Atc", identitySql], { PGPASSWORD: lease.password }));
    assertServerIdentity(lease, identity); lease.systemIdentifier ??= identity.systemIdentifier;
    requireSafe(!lease.port || lease.port === observed.port, "PORT_CHANGED"); lease.port = observed.port;
    const url = new URL(`postgresql://127.0.0.1:${lease.port}/${lease.database}`);
    url.username = lease.role; url.password = lease.password; lease.url = url.href;
    const receipt = { containerId: lease.containerId, containerPid: observed.container.State.Pid, entrypoint: observed.container.Path, createdAt: lease.createdAt, imageId: lease.imageId, imageOrigins: lease.imageOrigins, networkId: lease.networkId, internalNetwork: true, labels: { owner: lease.owner, run: runId }, tmpfs: true, bindingEvidence: observed.binding, bindings: [{ host: "127.0.0.1", port: lease.port }], server: identity, checkedAt: timestamp(), simulated };
    event("preflight-positive", receipt); requireSafe(!evidenceWriteFailed, "EVIDENCE_WRITE_FAILED"); return receipt;
  };
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
    let complete = true;
    if (lease.containerId) {
      try {
        await resource(false);
        await backend.docker(["rm", "--force", lease.containerId]);
        const remaining = await backend.docker(["ps", "-aq", "--no-trunc", "--filter", "id=" + lease.containerId]);
        requireSafe(!remaining.trim(), "CONTAINER_TEARDOWN_INCOMPLETE");
        event("container-removed", { containerId: lease.containerId });
      } catch (error) { complete = false; event("teardown-incomplete", { resource: "container", containerId: lease.containerId, code: error instanceof SafetyError ? error.code : "CLEANUP_FAILED" }); }
    }
    if (lease.networkId && complete) {
      try {
        const networks = await jsonDocker(["network", "inspect", lease.networkId]);
        requireSafe(networks.length === 1 && networks[0].Id === lease.networkId && networks[0].Internal === true && networks[0].Labels?.["piccadilly.owner"] === owner && networks[0].Labels?.["piccadilly.run"] === runId && !Object.keys(networks[0].Containers ?? {}).length, "NETWORK_CLEANUP_NOT_OWNED");
        await backend.docker(["network", "rm", lease.networkId]);
        const remaining = await backend.docker(["network", "ls", "-q", "--no-trunc", "--filter", "id=" + lease.networkId]);
        requireSafe(!remaining.trim(), "NETWORK_TEARDOWN_INCOMPLETE"); event("network-removed", { networkId: lease.networkId });
      } catch (error) { complete = false; event("teardown-incomplete", { resource: "network", networkId: lease.networkId, code: error instanceof SafetyError ? error.code : "CLEANUP_FAILED" }); }
    }
    closed = true; event("teardown", { complete }); return complete;
    })();
    return closePromise;
  };
  const receipt = () => ({ runId, simulated, runtime: runtime.receipt, toolchain: backend.toolchain, events, commands, positiveOwnership: events.some(e => e.kind === "preflight-positive"), firstWriterPreflight: firstWriter, evidenceStatus: evidenceWriteFailed ? "WRITE_FAILED" : "RECORDED", teardown: events.findLast(e => e.kind === "teardown") ?? null });
  const create = async () => {
    requireSafe(!lease.containerId && !lease.networkId && !closed, "RUN_ALREADY_CREATED");
    try {
      const images = await jsonDocker(["image", "inspect", POSTGRES_IMAGE]);
      requireSafe(images.length === 1 && /^sha256:[a-f0-9]{64}$/u.test(images[0].Id) && images[0].RepoDigests?.some(name => /^postgres@sha256:[a-f0-9]{64}$/u.test(name)), "IMAGE_ORIGIN_NOT_VERIFIED");
      lease.imageId = images[0].Id; lease.imageOrigins = images[0].RepoDigests;
      lease.networkId = (await backend.docker(["network", "create", "--internal", "--driver", "bridge", "--label", "piccadilly.owner=" + owner, "--label", "piccadilly.run=" + runId, "m13-p1-" + suffix])).trim();
      requireSafe(/^[a-f0-9]{64}$/u.test(lease.networkId), "NETWORK_CREATION_UNCERTAIN");
      event("network-created", { networkId: lease.networkId }); requireSafe(!evidenceWriteFailed, "EVIDENCE_WRITE_FAILED");
      lease.containerId = (await backend.docker(["create", "--pull=never", "--name", "m13-p1-" + suffix, "--network", lease.networkId, "--label", "piccadilly.owner=" + owner, "--label", "piccadilly.run=" + runId, "--tmpfs", "/var/lib/postgresql:rw,noexec,nosuid", "--publish", "127.0.0.1::5432", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB=" + lease.database, "--env", "POSTGRES_USER=" + lease.role, lease.imageId], { POSTGRES_PASSWORD: lease.password })).trim();
      requireSafe(/^[a-f0-9]{64}$/u.test(lease.containerId), "CONTAINER_CREATION_UNCERTAIN");
      event("container-create-returned", { containerId: lease.containerId }); requireSafe(!evidenceWriteFailed, "EVIDENCE_WRITE_FAILED");
      const initial = await jsonDocker(["inspect", lease.containerId]); requireSafe(initial.length === 1, "INSPECT_AMBIGUOUS"); lease.createdAt = initial[0].Created;
      await resource(false); event("container-created", { containerId: lease.containerId, imageId: lease.imageId, createdAt: lease.createdAt }); requireSafe(!evidenceWriteFailed, "EVIDENCE_WRITE_FAILED");
      await backend.docker(["start", lease.containerId]); event("container-started", { containerId: lease.containerId });
      // Only a refused connection during PostgreSQL bootstrap is retried. A
      // metadata mismatch is not retried or treated as readiness.
      const deadline = Date.now() + 30_000;
      while (true) {
        await resource(true);
        try { return await preflight(); }
        catch (error) { if (error.code !== "INFRASTRUCTURE_INTROSPECTION_UNAVAILABLE" || Date.now() >= deadline) throw error; await pause(250); }
      }
    } catch (error) { event("blocked", { code: error.code ?? "CREATE_FAILED" }); await close(); throw error; }
  };
  const run = async role => {
    requireSafe(!busy && !closed, "RUN_BUSY_OR_CLOSED");
    const definitions = commandDefinitions(runtime);
    requireSafe(Object.hasOwn(definitions, role), "COMMAND_NOT_ALLOWLISTED"); busy = true;
    try {
      await runtime.assertLive();
      const before = await backend.source();
      if (["e2e", "e2e-core"].includes(role)) { await backend.applicationPort(); event("application-port-free", { port: 4000 }); }
      const proof = await preflight();
      requireSafe(!signal?.aborted, "ABORTED_BEFORE_SPAWN");
      if (!firstWriter) { firstWriter = true; event("first-writer-preflight", { role, containerId: lease.containerId, checkedAt: proof.checkedAt }); }
      const environment = cleanEnvironment({}, runtime.directory);
      Object.assign(environment, simulated ? {} : cleanEnvironment(process.env, runtime.directory));
      const generated = Object.fromEntries(["AUTH_RATE_LIMIT_SECRET", "PUBLIC_BOOKING_RATE_LIMIT_SECRET", "PUBLIC_BOOKING_MANAGEMENT_SECRET", "AUTH_DEMO_ADMIN_PASSWORD", "AUTH_DEMO_STAFF_PASSWORD"].map(key => [key, "M13-only-" + randomBytes(32).toString("base64url")]));
      secrets.push(lease.url, ...Object.values(generated));
      Object.assign(environment, generated, { DATABASE_URL: lease.url, APP_ENV: "development", AUTH_TRUST_PROXY: "false", RESERVATION_PRIVACY_POLICY_VERSION: "m13-p1-synthetic", RESERVATION_TERMS_VERSION: "m13-p1-synthetic", RESERVATION_IDEMPOTENCY_TTL_HOURS: "24", PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS: "900", PUBLIC_BOOKING_READ_LIMIT: "10000", PUBLIC_BOOKING_MUTATION_LIMIT: "10000", NEXT_TELEMETRY_DISABLED: "1", NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/", NPM_CONFIG_CACHE: join(evidenceDirectory, "npm-cache"), NPM_CONFIG_USERCONFIG: join(evidenceDirectory, "empty-user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(evidenceDirectory, "empty-global.npmrc") });
      const result = await backend.child(definitions[role], environment, { signal, deadlineMs, secrets, stdout: output => { if (!simulated) return writeFile(join(evidenceDirectory, role + ".log"), output); } });
      const after = await backend.source();
      const record = { role, ...result, preflight: proof, before, after, result: result.exitCode === 0 && !result.reason ? "PASS" : "FAIL" };
      commands.push(record); event("child-joined", { role, exitCode: result.exitCode, reason: result.reason, pid: result.pid });
      requireSafe(before.freeze === after.freeze, "SOURCE_CHANGED");
      if (["npm-ls", "audit-full", "audit-production"].includes(role) && result.exitCode === 1 && !result.reason) return record;
      requireSafe(result.exitCode === 0 && !result.reason, "CHILD_FAILED"); return record;
    } finally { busy = false; }
  };
  return Object.freeze({ create, preflight, run, close, receipt });
}

export async function finishOwnedRun(harness, primaryError) {
  let complete = true, cleanupCode = null;
  if (harness) {
    try { complete = await harness.close() === true; }
    catch (error) { complete = false; cleanupCode = error instanceof SafetyError ? error.code : "CLEANUP_FAILED"; }
  }
  const cleanupStatus = harness ? complete ? "COMPLETE" : "INCOMPLETE" : "NOT_REQUIRED";
  const receipt = { ...(harness?.receipt() ?? {}), primaryFailure: primaryError ? { code: primaryError instanceof SafetyError ? primaryError.code : "UNCLASSIFIED_FAILURE", secondaryDiagnosticFailure: primaryError.secondaryDiagnosticFailure ?? null, abortFailure: primaryError.verification?.abortFailure ?? null, joinFailure: primaryError.joinFailure ?? null } : null, cleanupStatus, cleanupError: cleanupCode };
  const error = primaryError ?? (complete ? null : new SafetyError("TEARDOWN_INCOMPLETE"));
  if (error) error.cleanupStatus = cleanupStatus;
  return { complete, cleanupStatus, receipt, error };
}

export async function lifecycleProbe(name, { signal, deadlineMs = 1000 } = {}) {
  const probes = { exit: "process.exit(7)", wait: "setInterval(()=>{},1000)", tree: "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});setInterval(()=>{},1000)" };
  requireSafe(Object.hasOwn(probes, name), "PROBE_NOT_ALLOWLISTED");
  const osOnly = Object.fromEntries(osKeys.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  return executeChild(["-e", probes[name]], cleanEnvironment(osOnly, dirname(process.execPath)), { signal, deadlineMs });
}

export async function main(argv = process.argv.slice(2), { environment = process.env, qualifyRuntime = verifyRuntime, createHarness = createProxyRunHarness } = {}) {
  const [mode, ...pairs] = argv;
  requireSafe(["verify", "run"].includes(mode) && pairs.length % 2 === 0, "CLI_ARGUMENTS_REJECTED");
  const options = {};
  for (let i = 0; i < pairs.length; i += 2) {
    requireSafe(["--distribution-dir", "--evidence-dir", "--plan", "--artifact-dir", "--engine-id"].includes(pairs[i]) && !Object.hasOwn(options, pairs[i]), "CLI_ARGUMENTS_REJECTED"); options[pairs[i]] = pairs[i + 1];
  }
  requireSafe(options["--distribution-dir"] && options["--evidence-dir"], "CLI_ARGUMENTS_REJECTED");
  requireSafe(!inside(projectRoot, options["--evidence-dir"]) && !inside(projectRoot, options["--distribution-dir"]), "ARTIFACTS_MUST_BE_EXTERNAL");
  cleanEnvironment(environment, dirname(process.execPath));
  for (const name of await readdir(projectRoot)) requireSafe(!name.startsWith(".env") || name === ".env.example", "LOCAL_ENV_FILE_REJECTED");
  requireSafe(!(await readdir(projectRoot)).includes(".npmrc"), "PROJECT_NPMRC_REJECTED");
  const evidence = resolve(options["--evidence-dir"]); await mkdir(evidence, { recursive: true });
  requireSafe(!inside(await realpath(projectRoot), await realpath(evidence)), "ARTIFACTS_MUST_BE_EXTERNAL");
  const runtime = await qualifyRuntime(options["--distribution-dir"]);
  await writeFile(join(evidence, "runtime.json"), JSON.stringify(runtime.receipt, null, 2) + "\n");
  if (mode === "verify") { console.info(JSON.stringify({ runtime: runtime.receipt, databaseOwnership: "NOT_RUN", sensitiveCommands: "NOT_RUN" })); return; }
  const plan = options["--plan"] ?? "core"; requireSafe(Object.hasOwn(PLANS, plan), "PLAN_NOT_ALLOWLISTED");
  const controller = new AbortController(); let received;
  const sigint = () => { received = "SIGINT"; controller.abort(); }, sigterm = () => { received = "SIGTERM"; controller.abort(); };
  process.once("SIGINT", sigint); process.once("SIGTERM", sigterm);
  let harness, primaryError, outcome;
  try {
    harness = await createHarness({ runtime, evidenceDirectory: evidence, signal: controller.signal, artifactDirectory: options["--artifact-dir"], expectedEngineId: options["--engine-id"] });
    await harness.create();
    const earlyQuiescence = await harness.validateQuiescence();
    requireSafe(earlyQuiescence?.status === "PASS_VERIFIED", "EARLY_QUIESCENCE_REQUIRED");
    for (const role of PLANS[plan]) { console.info(JSON.stringify({ role, state: "guarding" })); const record = await harness.run(role); if (record.exitCode !== 0) process.exitCode = 1; console.info(JSON.stringify({ role, state: "joined", exitCode: record.exitCode, result: record.result })); }
  } catch (error) { primaryError = error; }
  finally {
    outcome = await finishOwnedRun(harness, primaryError);
    try { await writeFile(join(evidence, "run.json"), JSON.stringify({ runtime: runtime.receipt, ...outcome.receipt }, null, 2) + "\n"); }
    catch {
      console.error(JSON.stringify({ event: "receipt-write-failed", code: "EVIDENCE_WRITE_FAILED", cleanupStatus: outcome.cleanupStatus }));
      outcome.error ??= new SafetyError("EVIDENCE_WRITE_FAILED");
    }
    process.removeListener("SIGINT", sigint); process.removeListener("SIGTERM", sigterm);
    if (received) process.exitCode = received === "SIGINT" ? 130 : 143;
  }
  if (outcome.error) throw outcome.error;
}

export const D6_PROFILE = Object.freeze({ pgMemory: 1536 * 1024 ** 2, pgTmpfs: 1024 * 1024 ** 2, proxyMemory: 256 * 1024 ** 2, proxyTmpfs: 16 * 1024 ** 2, maxconn: 64, bootstrapMs: 30_000 });
export const D6_PINS = Object.freeze({
  postgres: { tag: POSTGRES_IMAGE, index: "sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15", manifest: "sha256:b6a16ed0eb96e2c362811f7eeb951eac8b459e7b40be4149ea5444aa7c65569b", config: "sha256:bd1890816ae0b8ad4644f05728570d4be774e1f1490d7232f5084b52ea335183" },
  haproxy: { tag: "haproxy:3.2.26-alpine3.24", index: "sha256:5893840576071e6217cd52ebdcc14f454c6f7a631056fa6f4e0f40d3cac4215b", manifest: "sha256:3c2931ee7070f321b0bde9cbf5c27227d72b43f5862b9f028516fbeff4644fbf", config: "sha256:92fa659751a39ced505c3d78f03387c463372b2b9129400e27edeb49abd347d2" },
  psqlArchive: "fbe23da234ee31547bf8a36d29dfd81e82b849df2d2b78d2eecb43d360252f8c",
});
const qualifiedProxyArtifacts = new WeakSet();
const d6IdentitySql = "BEGIN READ ONLY; SELECT json_build_object('database',current_database(),'role',current_user,'version',current_setting('server_version'),'dataDirectory',current_setting('data_directory'),'systemIdentifier',(pg_control_system()).system_identifier::text,'postmasterStart',pg_postmaster_start_time()::text,'serverAddress',inet_server_addr()::text,'clientAddress',inet_client_addr()::text,'serverPort',inet_server_port()); COMMIT;";
const d14IdentityJson = d6IdentitySql.slice("BEGIN READ ONLY; SELECT ".length, -"; COMMIT;".length);
// A fresh connection/transaction for each sample avoids reusing pg_stat_activity
// snapshots. Never select query text or exclude unnamed client sessions.
const d14CensusSql = "BEGIN READ ONLY; SELECT json_build_object('monitor',json_build_object('pid',pg_backend_pid(),'applicationName',current_setting('application_name'),'backendStart',(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()),'readOnly',current_setting('transaction_read_only')),'identity'," + d14IdentityJson + ",'clients',(SELECT coalesce(json_agg(json_build_object('pid',pid,'backendStart',backend_start::text,'database',datname,'role',usename,'applicationName',application_name,'backendType',backend_type,'state',state,'transactionOpen',xact_start IS NOT NULL) ORDER BY pid),'[]'::json) FROM pg_stat_activity WHERE backend_type='client backend' OR backend_type IS NULL),'sameRoleNonClients',(SELECT coalesce(json_agg(json_build_object('type',backend_type,'count',n)),'[]'::json) FROM (SELECT backend_type,count(*) AS n FROM pg_stat_activity WHERE usename=current_user AND backend_type<>'client backend' GROUP BY backend_type) g)); COMMIT;";

export function classifySessionCensus(snapshot, { database, role, monitorName, syntheticPid = null, syntheticName = null }) {
  const m = snapshot?.monitor, rows = snapshot?.clients;
  requireSafe(m && Number.isInteger(m.pid) && m.pid > 0 && m.applicationName === monitorName && typeof m.backendStart === "string" && m.backendStart.length > 0 && m.readOnly === "on" && Array.isArray(rows), "SQL_MONITOR_IDENTITY_INVALID");
  requireSafe(rows.length <= 1024 && new Set(rows.map(r => r?.pid)).size === rows.length, "SQL_CENSUS_INVALID");
  const own = rows.filter(r => r.pid === m.pid);
  requireSafe(own.length === 1 && own[0].backendType === "client backend" && own[0].backendStart === m.backendStart && own[0].applicationName === monitorName && own[0].database === database && own[0].role === role && own[0].state === "active" && own[0].transactionOpen === true, "SQL_MONITOR_IDENTITY_INVALID");
  const other = rows.filter(r => r.pid !== m.pid).map(r => {
    requireSafe(Number.isInteger(r.pid) && r.pid > 0 && typeof r.backendStart === "string" && typeof r.transactionOpen === "boolean", "SQL_CENSUS_INVALID");
    const state = ["active", "idle", "idle in transaction", "idle in transaction (aborted)"].includes(r.state) ? r.state : "unknown";
    const synthetic = r.pid === syntheticPid && r.applicationName === syntheticName && r.database === database && r.role === role;
    return { pid: r.pid, backendStart: r.backendStart, state, transactionOpen: r.transactionOpen, sameDatabase: r.database === database, sameRole: r.role === role, ownership: synthetic ? "SYNTHETIC_CLIENT_CORRELATED" : "UNRECONCILED", backendType: r.backendType === "client backend" ? "client backend" : "unknown" };
  });
  const nonClients = snapshot.sameRoleNonClients ?? [];
  requireSafe(Array.isArray(nonClients) && nonClients.every(r => typeof r.type === "string" && /^[a-z ]{1,64}$/u.test(r.type) && Number.isInteger(r.count) && r.count >= 0), "SQL_CENSUS_INVALID");
  return { monitor: { pid: m.pid, backendStart: m.backendStart, applicationName: monitorName, readOnly: true }, otherClientSessionsCount: other.length, activeSessionsCount: other.filter(r => r.state === "active").length, idleSessionsCount: other.filter(r => r.state === "idle").length, idleInTransactionCount: other.filter(r => r.state.startsWith("idle in transaction")).length, openTransactionsCount: other.filter(r => r.transactionOpen).length, unknownSessionsCount: other.filter(r => r.state === "unknown" || r.ownership === "UNRECONCILED" || r.backendType === "unknown").length, sessions: other, sameRoleNonClients: nonClients, legacyRoleWideCount: other.filter(r => r.sameRole).length + nonClients.reduce((n, r) => n + r.count, 0), quiet: other.length === 0 };
}

export async function verifyProxyArtifacts(directory, runtime) {
  requireSafe(directory && !inside(projectRoot, directory), "ARTIFACTS_MUST_BE_EXTERNAL");
  const root = await realpath(resolve(directory)); requireSafe(!inside(await realpath(projectRoot), root), "ARTIFACTS_MUST_BE_EXTERNAL");
  for (const role of ["postgres", "haproxy"]) {
    const pin = D6_PINS[role];
    const indexBytes = await regularBytes(join(root, role + "-index.json"));
    const manifestBytes = await regularBytes(join(root, role + "-manifest.json"));
    const configBytes = await regularBytes(join(root, role + "-config.json"));
    requireSafe("sha256:" + hash(indexBytes) === pin.index && "sha256:" + hash(manifestBytes) === pin.manifest && "sha256:" + hash(configBytes) === pin.config, "OCI_ARTIFACT_CHANGED");
    const index = JSON.parse(indexBytes), manifest = JSON.parse(manifestBytes), config = JSON.parse(configBytes);
    requireSafe(index.manifests.filter(m => m.platform?.os === "linux" && m.platform?.architecture === "amd64" && m.digest === pin.manifest).length === 1 && manifest.config.digest === pin.config && config.os === "linux" && config.architecture === "amd64", "OCI_PLATFORM_MISMATCH");
  }
  const archive = await regularBytes(join(root, "postgresql-18.6-1-windows-x64-binaries.zip"));
  requireSafe(hash(archive) === D6_PINS.psqlArchive, "PSQL_PUBLISHER_CHECKSUM_MISMATCH");
  const members = zipMembers(archive, name => /^pgsql\/bin\/(?:psql\.exe|[^/]+\.dll)$/iu.test(name));
  const expected = new Map([...members].map(([name, data]) => [name.slice("pgsql/bin/".length), hash(data)]));
  requireSafe(expected.has("psql.exe") && expected.has("libpq.dll"), "PSQL_BUNDLE_INCOMPLETE");
  const executable = join(root, "windows-psql", "psql.exe");
  const expectedFiles = [...expected].map(row => Object.freeze([...row])); Object.freeze(expectedFiles);
  const assertExecutableLive = control => verifyFilesBounded({ root: join(root, "windows-psql"), mode: "psql", files: expectedFiles }, control);
  const assertLive = async () => { await (runtime.assertQualified ?? runtime.assertLive)(); await assertExecutableLive(); };
  await assertLive();
  const environment = cleanEnvironment({}, runtime.directory);
  for (const key of osKeys) if (process.env[key]) environment[key] = process.env[key];
  environment.PATH = [join(root, "windows-psql"), join(environment.SystemRoot, "System32")].join(delimiter);
  environment.LC_ALL = "C";
  const version = await exec(executable, ["--version"], { env: environment, windowsHide: true, timeout: 5_000, maxBuffer: 16_384 });
  requireSafe(/^psql \(PostgreSQL\) 18\.6\s*$/u.test(version.stdout.trim()), "PSQL_VERSION_MISMATCH");
  const artifacts = { root, executable, assertLive, assertExecutableLive, environment, receipt: { status: "PASS_VERIFIED", psqlVersion: version.stdout.trim(), psqlArchiveSha256: D6_PINS.psqlArchive, psqlBinarySha256: expected.get("psql.exe"), source: "https://get.enterprisedb.com/postgresql/postgresql-18.6-1-windows-x64-binaries.zip", checksumSource: "https://github.com/EnterpriseDB/edb-installers/issues/742", files: [...expected].map(([name, sha256]) => ({ name, sha256 })), images: D6_PINS, operationalSecurityApproval: false } };
  qualifiedProxyArtifacts.add(artifacts); return artifacts;
}

export function proxyConfiguration(pgAddress) {
  requireSafe(/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(pgAddress) && pgAddress.split(".").every(p => Number(p) <= 255) && !pgAddress.startsWith("127."), "PROXY_TARGET_INVALID");
  return `global\n  maxconn 64\n  hard-stop-after 5s\n  stats socket /run/haproxy/owned.sock mode 600 level user\n  stats timeout 3s\ndefaults\n  mode tcp\n  timeout connect 3s\n  timeout queue 3s\n  timeout client 1h\n  timeout server 1h\nfrontend owned_front\n  bind 0.0.0.0:15432\n  default_backend owned_back\nbackend owned_back\n  server owned_pg ${pgAddress}:5432\n`;
}
function d6Labels(lease, role) { return { "piccadilly.owner": lease.owner, "piccadilly.run": lease.runId, "piccadilly.role": role }; }
export function proxyConfigArchive(content) {
  const data = Buffer.from(content), header = Buffer.alloc(512);
  const put = (value, start, length) => header.write(value, start, length, "ascii");
  put("haproxy.cfg", 0, 100); put("0000444\0", 100, 8); put("0000000\0", 108, 8); put("0000000\0", 116, 8);
  put(data.length.toString(8).padStart(11, "0") + "\0", 124, 12); put("00000000000\0", 136, 12);
  header.fill(32, 148, 156); header[156] = 48; put("ustar\0", 257, 6); put("00", 263, 2);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0); put(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512 + 1024)]);
}
function labelsMatch(actual, expected) { return Object.entries(expected).every(([k, v]) => actual?.[k] === v); }
function noMounts(container, role) {
  const host = container.HostConfig;
  requireSafe(!host.Binds?.length && !host.VolumesFrom?.length && !host.Privileged && (container.Mounts ?? []).every(m => m.Type === "tmpfs"), "PERSISTENT_MOUNT_REJECTED");
  const path = role === "postgres" ? "/var/lib/postgresql" : "/run/haproxy";
  requireSafe(Object.keys(host.Tmpfs ?? {}).join() === path && (container.Mounts ?? []).every(m => m.Destination === path), "TMPFS_CONFIG_MISMATCH");
  const value = host.Tmpfs[path], size = role === "postgres" ? D6_PROFILE.pgTmpfs : D6_PROFILE.proxyTmpfs;
  requireSafe(value.split(",").includes("size=" + size) && value.includes("noexec") && value.includes("nosuid"), "TMPFS_BUDGET_MISMATCH");
  const memory = role === "postgres" ? D6_PROFILE.pgMemory : D6_PROFILE.proxyMemory;
  requireSafe(host.Memory === memory && host.MemorySwap === memory, "MEMORY_BUDGET_MISMATCH");
}
export function assertD6Container(lease, container, role, running = true) {
  const expected = lease[role];
  requireSafe(expected?.id && container.Id === expected.id && labelsMatch(container.Config?.Labels, d6Labels(lease, role)), "OWNERSHIP_MISMATCH");
  requireSafe((!expected.attempt || container.Config.Labels["piccadilly.attempt"] === expected.attempt) && container.Created === expected.created && container.Image === expected.imageId && container.Config.Image === expected.imageId, "CREATION_IDENTITY_MISMATCH");
  noMounts(container, role);
  const networks = Object.values(container.NetworkSettings?.Networks ?? {});
  const ids = networks.map(n => n.NetworkID).sort();
  const wanted = role === "postgres" ? [lease.backend.id] : [lease.backend.id, lease.frontend.id].sort();
  if (running) {
    requireSafe(container.State?.Running === true && container.State.Pid > 0, "CONTAINER_NOT_RUNNING");
    requireSafe(JSON.stringify(ids) === JSON.stringify(wanted), "NETWORK_TARGET_MISMATCH");
    if (expected.started) requireSafe(container.State.StartedAt === expected.started && container.State.Pid === expected.pid, "RESOURCE_GENERATION_CHANGED");
  }
  if (role === "postgres") {
    requireSafe(!Object.keys(container.HostConfig.PortBindings ?? {}).length && Object.values(container.NetworkSettings.Ports ?? {}).every(p => p === null || Array.isArray(p) && !p.length), "POSTGRESQL_HOST_PUBLICATION_FORBIDDEN");
    requireSafe(container.Path === "docker-entrypoint.sh" && container.Args.join(" ") === "postgres", "CONTAINER_PROCESS_MISMATCH");
    const config = Object.fromEntries((container.Config.Env ?? []).map(s => { const p = s.indexOf("="); return [s.slice(0, p), s.slice(p + 1)]; }));
    requireSafe(config.POSTGRES_DB === lease.database && config.POSTGRES_USER === lease.role && config.POSTGRES_PASSWORD === lease.password, "DATABASE_CREDENTIALS_MISMATCH");
    if (running) requireSafe(networks[0].Gateway === "" && !networks[0].GlobalIPv6Address && !networks[0].IPv6Gateway, "POSTGRESQL_EXTERNAL_ROUTE");
  } else {
    requireSafe(container.Config.User === "99:99" && container.HostConfig.CapDrop?.includes("ALL") && !container.HostConfig.CapAdd?.length && container.HostConfig.SecurityOpt?.some(value => /^no-new-privileges(?::true)?$/u.test(value)), "PROXY_PRIVILEGE_MISMATCH");
    requireSafe(container.Path === "docker-entrypoint.sh" && container.Args.join(" ") === "haproxy -f /usr/local/etc/haproxy/haproxy.cfg", "PROXY_PROCESS_MISMATCH");
    const request = { "15432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(lease.port) }] };
    requireSafe(JSON.stringify(container.HostConfig.PortBindings) === JSON.stringify(request), "PORT_CONFIGURATION_MISMATCH");
    if (running) {
      const actual = container.NetworkSettings.Ports;
      requireSafe(actual?.["15432/tcp"]?.length, "PORT_BINDING_NOT_PUBLISHED");
      requireSafe(JSON.stringify(actual) === JSON.stringify(request), "PORT_BINDING_AMBIGUOUS");
    }
  }
}
export function assertD6Network(lease, network, role) {
  requireSafe(network.Id === lease[role]?.id && (!lease[role].attempt || network.Labels?.["piccadilly.attempt"] === lease[role].attempt) && network.Created === lease[role]?.created && labelsMatch(network.Labels, d6Labels(lease, role)), "NETWORK_OWNERSHIP_MISMATCH");
  requireSafe(network.Driver === "bridge" && network.Internal === (role === "backend") && network.EnableIPv6 === false, "NETWORK_CONFIG_MISMATCH");
  if (role === "backend") requireSafe(network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] === "isolated", "BACKEND_ISOLATION_MISMATCH");
  const permitted = role === "backend" ? [lease.postgres?.id, lease.haproxy?.id] : [lease.haproxy?.id];
  requireSafe(Object.keys(network.Containers ?? {}).every(id => permitted.includes(id)), "FOREIGN_NETWORK_MEMBER");
}
// Only the identity protocol's numeric address fields may use this equivalence.
// PostgreSQL inet::text retains /32; no other prefix or address family is allowed.
export function canonicalIdentityIPv4(value) {
  requireSafe(typeof value === "string", "DATABASE_IP_ADDRESS_INVALID");
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/32)?$/u.exec(value);
  requireSafe(match && match[0] === value && isIPv4(match[1]), "DATABASE_IP_ADDRESS_INVALID");
  return match[1];
}
export function assertD6Identity(lease, internal, host) {
  const pgAddress = canonicalIdentityIPv4(lease.pgAddress), proxyAddress = canonicalIdentityIPv4(lease.proxyAddress);
  for (const row of [internal, host]) requireSafe(row && row.database === lease.database && row.role === lease.role && /^18\.4(?:\s|$)/u.test(row.version) && row.serverPort === 5432 && canonicalIdentityIPv4(row.serverAddress) === pgAddress && row.dataDirectory === "/var/lib/postgresql/18/docker" && /^\d+$/u.test(row.systemIdentifier) && typeof row.postmasterStart === "string" && row.postmasterStart.length > 10, "DATABASE_IDENTITY_MISMATCH");
  requireSafe(canonicalIdentityIPv4(internal.clientAddress) === pgAddress && canonicalIdentityIPv4(host.clientAddress) === proxyAddress, "DATABASE_CLIENT_ADDRESS_MISMATCH");
  for (const key of ["database", "role", "version", "serverPort", "serverAddress", "dataDirectory", "systemIdentifier", "postmasterStart"]) requireSafe(key === "serverAddress" ? canonicalIdentityIPv4(internal[key]) === canonicalIdentityIPv4(host[key]) : internal[key] === host[key], "SERVER_IDENTITY_CHANGED");
  if (lease.identity) for (const key of ["systemIdentifier", "postmasterStart"]) requireSafe(lease.identity[key] === host[key], "SERVER_IDENTITY_CHANGED");
}
export function assertD6RunnerTarget(lease, context) {
  const phases = ["vitest:prepare", "vitest:create", "vitest:migrate", "vitest:seed", "vitest:inspect", "vitest:test", "vitest:cleanup", "vitest:drop", "e2e:fingerprint-before", "e2e:prepare-fixture", "e2e:cleanup-initial", "e2e:prepare-users", "e2e:application", "e2e:playwright", "e2e:cleanup-final", "e2e:fingerprint-after"];
  requireSafe(phases.includes(context.phase), "RUNNER_PHASE_NOT_ALLOWED");
  const raw = context.plan?.sourceUrl?.href ?? context.environment?.DATABASE_URL;
  requireSafe(raw === lease.url, "RUNNER_DATABASE_MISMATCH");
  if (context.plan) {
    const source = new URL(lease.url), target = context.plan.targetUrl, maintenance = context.plan.maintenanceUrl;
    requireSafe(/^piccadilly_vitest_[a-f0-9]{32}$/u.test(context.plan.targetDatabaseName) && target.pathname === "/" + context.plan.targetDatabaseName && maintenance.pathname === "/postgres", "RUNNER_DATABASE_MISMATCH");
    for (const url of [target, maintenance]) for (const key of ["protocol", "hostname", "port", "username", "password", "search", "hash"]) requireSafe(url[key] === source[key], "RUNNER_DATABASE_MISMATCH");
  }
}

export const D8_LIMITS = Object.freeze({ bootstrapMs: 30_000, commandMs: 15_000, queryMs: 5_000, joinMs: 5_000, proxyStopMs: 10_000, postgresStopMs: 30_000, teardownMs: 70_000 });

async function abortablePollDelay(ms, signal) {
  await new Promise((done, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); done(); }, ms);
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
  });
}

// The 250ms cadence is not a new phase deadline. Reserve time for the fresh
// post-wakeup guard, and never enter a zero-delay retry loop near expiry.
export async function waitReadinessPoll(control, sleep = abortablePollDelay) {
  control.beforeSpawn();
  const remaining = control.effectiveTimeout(), delayMs = Math.min(250, Math.floor(remaining / 2));
  requireSafe(delayMs >= 1, control.deadlineCode);
  await sleep(delayMs, control.signal);
  control.beforeSpawn();
}

function waitWithSignal(promise, signal) {
  return new Promise((done, reject) => {
    const abort = () => reject(signal.reason instanceof SafetyError ? signal.reason : new SafetyError("RUN_ABORTED"));
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    Promise.resolve(promise).then(value => { signal.removeEventListener("abort", abort); done(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

// A deadline belongs to one phase/generation. It is never renewed by a re-check.
export class MonotonicBudget {
  constructor({ durationMs, code, now = () => performance.now(), signal, record = () => {}, onTimeout = () => {} }) {
    this.now = now; this.started = now(); this.last = this.started; this.deadline = this.started + durationMs; this.code = code; this.record = record;
    this.controller = new AbortController(); this.signal = this.controller.signal; this.onTimeout = onTimeout;
    this.parent = signal; this.abort = () => this.controller.abort(signal.reason instanceof SafetyError ? signal.reason : new SafetyError("RUN_ABORTED"));
    signal?.addEventListener("abort", this.abort, { once: true }); if (signal?.aborted) this.abort();
    this.timer = setTimeout(() => { const error = new SafetyError(code); this.controller.abort(error); this.onTimeout(error); }, durationMs); this.timer.unref?.();
  }
  elapsed() { const current = this.now(); requireSafe(Number.isFinite(current) && current >= this.last, "MONOTONIC_CLOCK_INVALID"); this.last = current; return current - this.started; }
  remaining() { return Math.max(0, this.deadline - this.started - this.elapsed()); }
  assert() {
    if (this.remaining() < 1 && !this.signal.aborted) { const error = new SafetyError(this.code); this.controller.abort(error); this.onTimeout(error); }
    if (this.signal.aborted) throw this.signal.reason instanceof SafetyError ? this.signal.reason : new SafetyError("RUN_ABORTED");
  }
  control(maxMs) {
    this.assert(); const remainingMs = this.remaining(); const timeoutMs = Math.floor(Math.min(maxMs, remainingMs));
    requireSafe(timeoutMs >= 1, this.code);
    return { timeoutMs, remainingMs, signal: this.signal, deadlineCode: this.code, beforeSpawn: () => this.assert() };
  }
  async run(name, maxMs, operation) {
    const control = this.control(maxMs), startedMs = this.elapsed(); let error;
    const phase = new AbortController(), timeoutCode = control.remainingMs <= maxMs ? this.code : "OPERATION_PHASE_TIMEOUT";
    control.timeoutCode = timeoutCode;
    const phaseTimer = setTimeout(() => { const error = new SafetyError(timeoutCode); this.onTimeout(error); phase.abort(error); }, control.timeoutMs);
    control.signal = AbortSignal.any([this.signal, phase.signal]);
    control.effectiveTimeout = () => Math.floor(Math.min(maxMs, this.remaining(), control.timeoutMs - (this.elapsed() - startedMs)));
    control.record = (kind, value) => this.record(kind, { phase: name, ...value });
    control.beforeSpawn = () => { this.assert(); if (control.signal.aborted) throw control.signal.reason; requireSafe(control.effectiveTimeout() >= 1, timeoutCode); };
    this.record("operation-start", { name, scope: this.code, elapsedMs: startedMs, remainingMs: control.remainingMs, effectiveTimeoutMs: control.timeoutMs, maxTimeoutMs: maxMs });
    try { control.beforeSpawn(); const result = await operation(control); this.assert(); control.beforeSpawn(); return result; }
    catch (caught) {
      if (["INFRASTRUCTURE_COMMAND_TIMEOUT", "OPERATION_PHASE_TIMEOUT"].includes(caught.code) && this.remaining() < 1 && !this.signal.aborted) this.controller.abort(new SafetyError(this.code));
      error = this.signal.aborted ? this.signal.reason : control.signal.aborted ? control.signal.reason : caught;
      if (error !== caught) { error.secondaryDiagnosticFailure = caught.code ?? "OPERATION_FAILED"; if (caught.verification) error.verification = caught.verification; if (caught.joinFailure) error.joinFailure = caught.joinFailure; }
      throw error;
    }
    finally { clearTimeout(phaseTimer); this.record("operation-end", { name, scope: this.code, elapsedMs: this.elapsed(), durationMs: this.elapsed() - startedMs, remainingMs: this.remaining(), code: error?.code ?? null }); }
  }
  dispose() { clearTimeout(this.timer); this.parent?.removeEventListener("abort", this.abort); }
}

// Stop/join the actual CLI, retaining late stdout. A timed-out Promise is never
// accepted as proof that the daemon did not create a resource.
export async function runInfrastructureProcess(executable, args, options) {
  const { environment, timeoutMs, signal, beforeSpawn = () => {}, onSpawn = () => {}, input, binary = false, secrets = [], spawnProcess = spawn } = options;
  requireSafe(!signal?.aborted, signal?.reason?.code ?? "RUN_ABORTED"); beforeSpawn();
  const effectiveTimeoutMs = options.effectiveTimeout ? Math.min(timeoutMs, options.effectiveTimeout()) : timeoutMs;
  requireSafe(effectiveTimeoutMs >= 1, options.deadlineCode ?? "OPERATION_PHASE_TIMEOUT");
  const child = spawnProcess(executable, args, { env: environment, windowsHide: true, shell: false, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
  onSpawn(child); const buffers = [], errors = []; let size = 0, primary, joined = false, hardKill, joinTimer, finished = false;
  return new Promise((resolveProcess, rejectProcess) => {
    const finish = () => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(hardKill); clearTimeout(joinTimer); signal?.removeEventListener("abort", abort);
      const stdout = Buffer.concat(buffers), stderr = redact(Buffer.concat(errors).toString("utf8"), secrets).slice(0, 8192);
      if (primary || !joined || child.exitCode !== 0) {
        const error = primary ?? new SafetyError(!joined ? "INFRASTRUCTURE_JOIN_INCOMPLETE" : "INFRASTRUCTURE_COMMAND_FAILED");
        Object.assign(error, { stdout: stdout.toString("utf8"), stderr, pid: child.pid ?? null, joined, exitCode: child.exitCode, processStarted: Boolean(child.pid), effectiveTimeoutMs }); rejectProcess(error);
      } else resolveProcess({ stdout: binary ? stdout : stdout.toString("utf8"), stderr, pid: child.pid, joined, exitCode: child.exitCode, effectiveTimeoutMs });
    };
    const stop = reason => {
      primary ??= reason; if (joinTimer) return;
      try { child.kill("SIGTERM"); } catch { /* Join remains mandatory below. */ }
      hardKill = setTimeout(() => { if (!joined) { try { child.kill("SIGKILL"); } catch { /* Recorded as an incomplete join. */ } } }, 1_000);
      joinTimer = setTimeout(finish, D8_LIMITS.joinMs);
    };
    const abort = () => stop(signal.reason instanceof SafetyError ? signal.reason : new SafetyError("RUN_ABORTED"));
    const timer = setTimeout(() => stop(new SafetyError("INFRASTRUCTURE_COMMAND_TIMEOUT")), effectiveTimeoutMs);
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const capture = (target, data) => { size += data.length; if (size > 8 * 1024 * 1024) stop(new SafetyError("INFRASTRUCTURE_OUTPUT_LIMIT")); else target.push(Buffer.from(data)); };
    child.stdout.on("data", data => capture(buffers, data)); child.stderr.on("data", data => capture(errors, data));
    child.once("error", () => { primary ??= new SafetyError("INFRASTRUCTURE_SPAWN_FAILED"); joined = !child.pid; if (joined) finish(); else stop(primary); });
    child.once("close", () => { joined = true; finish(); });
    if (input) { child.stdin.on("error", () => stop(new SafetyError("INFRASTRUCTURE_INPUT_FAILED"))); child.stdin.end(input); }
  });
}

export function parseObservationSections(output, names) {
  const text = String(output), result = {}; let position = 0;
  for (const name of [...names, "end"]) {
    const marker = "__M13_" + name + "__\n";
    requireSafe(text.startsWith(marker, position), "OBSERVATION_FORMAT_INVALID"); position += marker.length;
    if (name === "end") { requireSafe(text.slice(position).trim() === "", "OBSERVATION_FORMAT_INVALID"); break; }
    const next = text.indexOf("__M13_", position); requireSafe(next >= position, "OBSERVATION_FORMAT_INVALID"); result[name] = text.slice(position, next).trim(); position = next;
  }
  return result;
}
const pgObservationNames = ["mounts", "route", "memory", "swap"];
const proxyObservationNames = ["hash", "permissions", "forward", "memory", "swap", "status", "cmdline", "mounts", "diagnostic"];
function observationScript(fields, diagnostic = false) {
  const lines = ["set -eu"];
  for (const [name, command] of fields) lines.push("printf '__M13_" + name + "__\\n'", command, "printf '\\n'");
  if (diagnostic) lines.push("printf '__M13_diagnostic__\\n'", "if output=$(printf 'show servers state owned_back\\n' | socat - UNIX-CONNECT:/run/haproxy/owned.sock 2>&1); then printf 'EXIT=0\\n%s\\n' \"$output\"; else printf 'EXIT=1\\n%s\\n' \"$output\"; fi");
  lines.push("printf '__M13_end__\\n'"); return lines.join("\n");
}
const pgObservationScript = observationScript([["mounts", "cat /proc/mounts"], ["route", "cat /proc/net/route"], ["memory", "cat /sys/fs/cgroup/memory.max"], ["swap", "cat /sys/fs/cgroup/memory.swap.max"]]);
const proxyObservationScript = observationScript([["hash", "sha256sum /usr/local/etc/haproxy/haproxy.cfg"], ["permissions", "stat -c '%u:%g:%a' /usr/local/etc/haproxy/haproxy.cfg"], ["forward", "cat /proc/sys/net/ipv4/ip_forward"], ["memory", "cat /sys/fs/cgroup/memory.max"], ["swap", "cat /sys/fs/cgroup/memory.swap.max"], ["status", "cat /proc/1/status"], ["cmdline", "tr '\\000' ' ' </proc/1/cmdline"], ["mounts", "cat /proc/mounts"]], true);

export const D15_ENGINE_ENDPOINT = "npipe:////./pipe/dockerDesktopLinuxEngine";
export function assertDockerTarget(context, endpoint = D15_ENGINE_ENDPOINT) {
  requireSafe(endpoint === D15_ENGINE_ENDPOINT && Array.isArray(context) && context.length === 1 && context[0]?.Name === "desktop-linux" && context[0]?.Endpoints?.docker?.Host === endpoint, "DOCKER_CONTEXT_IDENTITY_CHANGED");
}
export async function verifyDockerEngine(expectedId, context, control, readIdentity = readLocalEngineIdentity) {
  assertDockerTarget(context);
  const id = await readIdentity(D15_ENGINE_ENDPOINT, control);
  control.beforeSpawn(); requireSafe(id === expectedId, "DOCKER_ENGINE_IDENTITY_CHANGED");
  return { id, context: context[0].Name, endpoint: D15_ENGINE_ENDPOINT, transport: "LOCAL_PIPE_READ_ONLY_INFO_API" };
}

// Fixed read-only API on the already qualified local pipe. No TCP, credentials,
// redirects, arbitrary routes, keepalive, or daemon mutation is possible here.
export async function readLocalEngineIdentity(endpoint, control, { requestFactory = httpRequest, registry = engineRequests, joinMs = D8_LIMITS.joinMs } = {}) {
  requireSafe(endpoint === D15_ENGINE_ENDPOINT, "NON_LOCAL_DOCKER_REJECTED");
  control.beforeSpawn();
  const started = performance.now(), limit = Math.floor(Math.min(control.timeoutMs, control.effectiveTimeout()));
  requireSafe(limit > 0 && joinMs > 0 && joinMs <= D8_LIMITS.joinMs, "OPERATION_PHASE_TIMEOUT");
  const row = { state: "ACTIVE", startedMonotonicMs: started, deadlineMonotonicMs: started + limit, requestClosed: false, socketClosed: false, primaryFailure: null };
  registry.add(row);
  return new Promise((done, reject) => {
    let request, socket, body = "", responseEnded = false, primary, timer, joinTimer, settled = false;
    const finish = () => {
      if (settled || (!row.requestClosed || (socket && !row.socketClosed)) && row.state !== "UNKNOWN") return;
      settled = true; clearTimeout(timer); clearTimeout(joinTimer); control.signal.removeEventListener("abort", abort);
      row.state = row.state === "UNKNOWN" ? "UNKNOWN" : "JOINED"; row.elapsedMs = performance.now() - started;
      if (!primary && (row.elapsedMs >= limit || control.signal.aborted)) primary = control.signal.reason ?? new SafetyError(control.timeoutCode ?? "OPERATION_PHASE_TIMEOUT");
      let id;
      if (!primary) { try { id = JSON.parse(body).ID; requireSafe(responseEnded && typeof id === "string" && /^[a-f0-9-]{36}$/iu.test(id), "DOCKER_ENGINE_RESPONSE_INVALID"); } catch { primary = new SafetyError("DOCKER_ENGINE_RESPONSE_INVALID"); } }
      row.primaryFailure = primary?.code ?? null; control.record?.("engine-api-settled", { ...row });
      if (primary) { if (row.state === "UNKNOWN") primary.joinFailure = "ENGINE_API_JOIN_INCOMPLETE"; reject(primary); } else done(id);
    };
    const stop = error => {
      if (settled) return;
      primary ??= error;
      joinTimer ??= setTimeout(() => { row.state = "UNKNOWN"; finish(); }, joinMs);
      request?.destroy(); socket?.destroy(); finish();
    };
    const abort = () => stop(control.signal.reason ?? new SafetyError("RUN_ABORTED"));
    timer = setTimeout(() => stop(new SafetyError(control.timeoutCode ?? "OPERATION_PHASE_TIMEOUT")), limit);
    control.signal.addEventListener("abort", abort, { once: true });
    try {
      control.beforeSpawn();
      request = requestFactory({ socketPath: "\\\\.\\pipe\\dockerDesktopLinuxEngine", method: "GET", path: "/info", agent: false, headers: { Connection: "close" } }, response => {
        if (response.statusCode !== 200) { stop(new SafetyError("DOCKER_ENGINE_RESPONSE_INVALID")); return; }
        response.setEncoding("utf8");
        response.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) stop(new SafetyError("DOCKER_ENGINE_RESPONSE_INVALID")); });
        response.once("error", () => stop(new SafetyError("DOCKER_ENGINE_REQUEST_FAILED")));
        response.once("end", () => { responseEnded = true; request.destroy(); socket?.destroy(); finish(); });
      });
      request.once("socket", value => { socket = value; value.once("close", () => { row.socketClosed = true; finish(); }); if (primary) value.destroy(); });
      request.once("error", () => stop(new SafetyError("DOCKER_ENGINE_REQUEST_FAILED")));
      request.once("close", () => { row.requestClosed = true; if (!responseEnded && !primary) stop(new SafetyError("DOCKER_ENGINE_REQUEST_FAILED")); else finish(); });
      request.end(); if (control.signal.aborted) abort();
    } catch (error) { if (!request) row.requestClosed = true; stop(error instanceof SafetyError ? error : new SafetyError("DOCKER_ENGINE_REQUEST_FAILED")); }
  });
}

async function d6Backend(runtime, artifacts, evidenceDirectory, expectedEngineId) {
  requireSafe(qualifiedProxyArtifacts.has(artifacts), "QUALIFIED_ARTIFACT_CAPABILITY_REQUIRED");
  requireSafe(typeof expectedEngineId === "string" && /^[a-f0-9-]{36}$/iu.test(expectedEngineId), "EXPECTED_ENGINE_ID_REQUIRED");
  const environment = cleanEnvironment(process.env, runtime.directory), docker = join(environment.USERPROFILE, "AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe");
  requireSafe(hash(await regularBytes(docker)) === "17cbf2f5f5f7693bbeda46e35dc930050b40aff06f41f9f5a69e4e2dd7fc12aa", "DOCKER_CLI_CHANGED");
  const operations = [], processes = new Set();
  const context = JSON.parse(await tool(docker, ["context", "inspect"], environment, operations));
  requireSafe(context.length === 1 && context[0].Name === "desktop-linux" && context[0].Endpoints.docker.Host === "npipe:////./pipe/dockerDesktopLinuxEngine", "NON_LOCAL_DOCKER_REJECTED");
  const endpoint = context[0].Endpoints.docker.Host;
  const execute = async (executable, args, env, control) => {
    const startedAt = timestamp(); let result, error;
    try { result = await runInfrastructureProcess(executable, args, { ...control, environment: env, secrets: [env.PGPASSWORD, env.POSTGRES_PASSWORD], onSpawn(child) { processes.add(child); child.once("close", () => processes.delete(child)); control.onSpawn?.(child); } }); return result; }
    catch (caught) { error = caught; throw caught; }
    finally { operations.push({ executable, args: args.map(value => /^(SELECT |BEGIN READ ONLY)/u.test(value) ? "[READ_ONLY_QUERY]" : value), startedAt, endedAt: timestamp(), pid: result?.pid ?? error?.pid ?? null, effectiveTimeoutMs: result?.effectiveTimeoutMs ?? error?.effectiveTimeoutMs ?? null, exitCode: result?.exitCode ?? error?.exitCode ?? null, joined: result?.joined ?? error?.joined ?? false, code: error?.code ?? null, stderr: result?.stderr ?? error?.stderr ?? "", outputSha256: result ? hash(Buffer.from(result.stdout)) : null }); }
  };
  const dockerCall = async (args, extra = {}, control = {}) => {
    try { const result = await execute(docker, ["--host", endpoint, ...args], { ...environment, ...extra }, { timeoutMs: 15_000, ...control }); return control.binary ? result.stdout : result.stdout.trim(); }
    catch (error) { if (error.code === "INFRASTRUCTURE_COMMAND_FAILED" && args.includes("psql") && /connection.*refused|could not connect.*not ready/iu.test(error.stderr)) error.code = "POSTGRESQL_STARTING"; throw error; }
  };
  requireSafe(JSON.parse(await dockerCall(["info", "--format", "{{json .ID}}"])) === expectedEngineId, "DOCKER_ENGINE_IDENTITY_CHANGED");
  return {
    simulation: false, batched: true, engineId: expectedEngineId, docker: dockerCall,
    async verifyEngine(control) {
      const current = JSON.parse((await execute(docker, ["context", "inspect"], environment, control)).stdout);
      return verifyDockerEngine(expectedEngineId, current, control);
    },
    async budget(control = {}) {
      const total = Number(await dockerCall(["info", "--format", "{{json .MemTotal}}"], {}, control)), output = await dockerCall(["stats", "--no-stream", "--format", "{{.MemUsage}}"], {}, control);
      const units = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }; let used = 0;
      for (const line of output.split("\n").filter(Boolean)) { const m = line.match(/^([\d.]+)(B|KiB|MiB|GiB)\s*\//u); requireSafe(m, "MEMORY_CAPACITY_NOT_VERIFIABLE"); used += Number(m[1]) * units[m[2]]; }
      requireSafe(total - used >= D6_PROFILE.pgMemory + D6_PROFILE.proxyMemory + 1024 ** 3, "DOCKER_MEMORY_INSUFFICIENT"); return { total, observedUsed: used, reserve: 1024 ** 3, allocationGuarantee: false };
    },
    async selectPort(control) {
      return new Promise((done, reject) => {
        const server = createServer(); let finished = false;
        const finish = (error, value) => { if (finished) return; finished = true; control.signal?.removeEventListener("abort", abort); error ? reject(error) : done(value); };
        const abort = () => { try { server.close(() => finish(control.signal.reason)); } catch { finish(control.signal.reason); } };
        control.signal?.addEventListener("abort", abort, { once: true }); if (control.signal?.aborted) { abort(); return; }
        server.once("error", error => finish(error)); server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => { const port = server.address().port; server.close(error => finish(error, { port, apiCloseCompleted: true, closedBeforeDockerCreate: true, kernelRaceExcluded: false })); });
      });
    },
    async creationFile(attempt) {
      const path = join(evidenceDirectory, "attempt-" + attempt.nonce + ".cid");
      try { await lstat(path); throw new SafetyError("CIDFILE_ALREADY_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      return path;
    },
    async recoverCreation(attempt, control) {
      if (!attempt.cidfile) return null;
      try { requireSafe((await lstat(attempt.cidfile)).size <= 66, "CIDFILE_INVALID"); const id = (await regularBytes(attempt.cidfile, control.signal)).toString().trim(); return /^[a-f0-9]{64}$/u.test(id) ? { id, source: "OWNED_CREATE_CIDFILE" } : null; }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },
    async config(containerId, content, control) {
      await control.operation("config-file", 15_000, c => writeFile(join(evidenceDirectory, "haproxy.cfg"), content, { mode: 0o444, signal: c.signal }));
      await control.docker(["cp", "-", containerId + ":/usr/local/etc/haproxy"], {}, { input: proxyConfigArchive(content) });
      const buffer = await control.docker(["cp", containerId + ":/usr/local/etc/haproxy/haproxy.cfg", "-"], {}, { binary: true });
      const octal = (start, end) => parseInt(buffer.subarray(start, end).toString().replace(/\0.*$/u, "").trim(), 8);
      const size = octal(124, 136), mode = octal(100, 108), uid = octal(108, 116);
      requireSafe(size === Buffer.byteLength(content) && mode === 0o444 && uid === 0 && buffer[156] === 48 && hash(buffer.subarray(512, 512 + size)) === hash(Buffer.from(content)), "PROXY_CONFIG_BEFORE_START_NOT_VERIFIED");
      return { sha256: hash(Buffer.from(content)), mode: "0444", uid: 0, regular: true };
    },
    async observations(lease, call) {
      const [pg, proxy] = await Promise.all([call(["exec", lease.postgres.id, "sh", "-c", pgObservationScript]), call(["exec", lease.haproxy.id, "sh", "-c", proxyObservationScript])]);
      return { pg: parseObservationSections(pg + "\n", pgObservationNames), proxy: parseObservationSections(proxy + "\n", proxyObservationNames) };
    },
    async monitor(lease, notify) {
      const child = spawn(docker, ["--host", endpoint, "events", "--since", lease.createdAt, "--filter", "label=piccadilly.run=" + lease.runId, "--filter", "label=piccadilly.owner=" + lease.owner, "--format", "{{json .}}"], { env: environment, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      processes.add(child); child.once("close", () => processes.delete(child)); let buffer = "", stopped = false, failed = false; const starts = new Set();
      child.stdout.setEncoding("utf8"); child.stdout.on("data", value => {
        buffer += value; if (buffer.length > 1024 * 1024) { failed = true; notify({ failure: "EVENT_STREAM_LIMIT" }); return; }
        let end; while ((end = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { const e = JSON.parse(line); if (e.Action === "start") starts.add(e.Actor.ID); notify({ id: e.Actor.ID, action: e.Action, type: e.Type }); } catch { failed = true; notify({ failure: "EVENT_STREAM_INVALID" }); } }
      });
      child.on("error", () => { failed = true; if (!stopped) notify({ failure: "EVENT_STREAM_FAILED" }); }); child.on("close", () => { if (!stopped) { failed = true; notify({ failure: "EVENT_STREAM_CLOSED" }); } });
      return { pid: child.pid, async ready(ids, control) { while (!ids.every(id => starts.has(id))) { control.beforeSpawn(); requireSafe(!failed, "EVENT_STREAM_NOT_VERIFIED"); await new Promise((done, reject) => { const timer = setTimeout(finish, 50); const abort = () => { clearTimeout(timer); control.signal.removeEventListener("abort", abort); reject(control.signal.reason); }; function finish() { control.signal.removeEventListener("abort", abort); done(); } control.signal.addEventListener("abort", abort, { once: true }); if (control.signal.aborted) abort(); }); } }, assertLive() { requireSafe(!failed && child.exitCode === null, "EVENT_STREAM_NOT_VERIFIED"); }, async close(control) { stopped = true; if (child.exitCode !== null || child.signalCode !== null) return; await new Promise((done, reject) => { const timer = setTimeout(() => reject(new SafetyError("EVENT_STREAM_JOIN_INCOMPLETE")), Math.min(5_000, control.timeoutMs)); child.once("close", () => { clearTimeout(timer); done(); }); child.kill(); }); } };
    },
    async hostIdentity(lease, control) {
      const env = { ...artifacts.environment, PGPASSWORD: lease.password, PGCONNECT_TIMEOUT: "5", PGSERVICEFILE: join(evidenceDirectory, "empty-pg-service.conf"), PGPASSFILE: join(evidenceDirectory, "empty-pgpass"), PGCLIENTENCODING: "UTF8", LC_ALL: "C" };
      const result = await execute(artifacts.executable, ["-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(lease.port), "-U", lease.role, "-d", lease.database, "-c", d6IdentitySql], env, control); return JSON.parse(result.stdout.trim());
    },
    async sessionCensus(lease, monitorName, control) {
      const output = await dockerCall(["exec", "--env", "PGPASSWORD", "--env", "PGAPPNAME", "--env", "PGOPTIONS", lease.postgres.id, "psql", "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", lease.pgAddress, "-U", lease.role, "-d", lease.database, "-c", d14CensusSql], { PGPASSWORD: lease.password, PGAPPNAME: monitorName, PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=5000" }, control);
      return JSON.parse(output);
    },
    async syntheticConnection(lease, name, control) {
      control.beforeSpawn();
      const env = { ...artifacts.environment, PGPASSWORD: lease.password, PGAPPNAME: name, PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=5000 -c idle_session_timeout=15000", PGCONNECT_TIMEOUT: "5", PGSERVICEFILE: join(evidenceDirectory, "empty-pg-service.conf"), PGPASSFILE: join(evidenceDirectory, "empty-pgpass") };
      const child = spawn(artifacts.executable, ["-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(lease.port), "-U", lease.role, "-d", lease.database], { env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      processes.add(child); let joined = false, failed = false, buffer = "", identity;
      const closed = new Promise(done => child.once("close", code => { joined = true; processes.delete(child); done(code); }));
      child.once("error", () => { failed = true; }); child.stdin.on("error", () => { failed = true; }); child.stderr.on("data", () => { failed = true; });
      const abort = () => { try { child.stdin.end("\\q\n"); child.kill(); } catch { failed = true; } }; control.signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", chunk => { buffer += chunk.toString(); if (buffer.length > 4096) { failed = true; abort(); } });
      child.stdin.write("BEGIN READ ONLY; SELECT json_build_object('pid',pg_backend_pid(),'database',current_database(),'role',current_user,'applicationName',current_setting('application_name'),'readOnly',current_setting('transaction_read_only')); COMMIT;\n");
      try {
        while (!buffer.includes("\n")) { control.beforeSpawn(); requireSafe(!joined && !failed, "SYNTHETIC_SQL_CLIENT_FAILED"); await waitReadinessPoll(control); }
        identity = JSON.parse(buffer.trim()); requireSafe(identity.database === lease.database && identity.role === lease.role && identity.applicationName === name && identity.readOnly === "on" && Number.isInteger(identity.pid), "SYNTHETIC_SQL_IDENTITY_INVALID");
      } catch (error) { abort(); await waitWithSignal(closed, AbortSignal.timeout(5_000)).catch(() => {}); control.signal.removeEventListener("abort", abort); throw error; }
      let closePromise;
      return { pid: identity.pid, applicationName: name, get joined() { return joined; }, close() {
        closePromise ??= (async () => { child.stdin.end("\\q\n"); const watchdog = setTimeout(() => child.kill(), 4_000); try { const code = await waitWithSignal(closed, AbortSignal.timeout(5_000)); requireSafe(joined && code === 0 && !failed, "SYNTHETIC_SQL_JOIN_FAILED"); } finally { clearTimeout(watchdog); control.signal.removeEventListener("abort", abort); } })(); return closePromise;
      } };
    },
    async source(control) {
      const git = join(process.env.ProgramFiles ?? "C:/Program Files", "Git/cmd/git.exe"), result = await execute(git, ["--no-optional-locks", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], environment, control), paths = result.stdout.split("\0").filter(Boolean).sort();
      const items = []; for (const name of paths) items.push({ name, sha256: hash(await regularBytes(join(projectRoot, name), control.signal)) }); return { files: items.length, freeze: hash(JSON.stringify(items)) };
    },
    applicationPort: async () => { for (const host of ["127.0.0.1", "::1"]) await new Promise((done, reject) => { const s = createServer(); s.once("error", () => reject(new SafetyError("APPLICATION_PORT_NOT_FREE"))); s.listen({ host, port: 4000, exclusive: true }, () => s.close(error => error ? reject(error) : done())); }); },
    child: executeChild, toolchain: { docker, endpoint, engineId: expectedEngineId, operations, processes, psql: artifacts.receipt },
  };
}

export async function createProxyRunHarness({ runtime, adapters, evidenceDirectory, artifactDirectory, expectedEngineId, signal: externalSignal, deadlineMs = 1_800_000 }) {
  requireSafe(adapters?.simulation === true || verifiedRuntimes.has(runtime), "VERIFIED_RUNTIME_CAPABILITY_REQUIRED");
  const simulated = Boolean(adapters), artifacts = simulated ? null : await verifyProxyArtifacts(artifactDirectory, runtime);
  const backend = adapters ?? await d6Backend(runtime, artifacts, evidenceDirectory, expectedEngineId);
  const now = backend.now ?? (() => performance.now()), origin = now();
  const runId = randomUUID(), owner = randomBytes(32).toString("hex"), suffix = randomBytes(16).toString("hex");
  const lease = { runId, owner, createdAt: timestamp(), generation: randomUUID(), database: "piccadilly_e2e_" + suffix, role: "m13_p1_" + suffix.slice(0, 16), password: randomBytes(32).toString("base64url") };
  const controller = new AbortController(), signal = controller.signal, events = [], commands = [], attempts = [], children = new Set(), inFlight = new Set(), runnerProcesses = [], sqlOperations = [], syntheticConnections = new Set();
  const secrets = [lease.password]; let activeBudget, bootstrapBudget, bootstrapTiming, closePromise, closed = false, closing = false, revoked = false, armed = false, monitor, firstWriter = false, busy = false, evidenceFailed = false, stoppingChildren, qualificationPending = true;
  if (!simulated) requireSafe(evidenceDirectory && !inside(projectRoot, evidenceDirectory), "ARTIFACTS_MUST_BE_EXTERNAL");
  const event = (kind, fields = {}) => {
    const record = { sequence: events.length + 1, at: timestamp(), monotonicMs: now() - origin, runId, kind, ...fields }; events.push(record);
    if (!simulated) try { appendFileSync(join(evidenceDirectory, "events.jsonl"), JSON.stringify(record) + "\n", { encoding: "utf8", flush: true }); } catch { evidenceFailed = true; }
  };
  const budget = (ms, code, parent = signal) => new MonotonicBudget({ durationMs: ms, code, now, signal: parent, record: event, onTimeout: error => { if (parent === signal) revoke(error); } });
  const revoke = error => { revoked = true; if (!signal.aborted) controller.abort(error instanceof SafetyError ? error : new SafetyError(error.code ?? "LEASE_REVOKED")); event("lease-revoked", { code: error.code ?? "LEASE_REVOKED", generation: lease.generation }); };
  const abort = () => revoke(new SafetyError("RUN_ABORTED")); externalSignal?.addEventListener("abort", abort, { once: true }); if (externalSignal?.aborted) abort();
  const operation = async (name, cap, fn) => {
    requireSafe(activeBudget, "OPERATION_BUDGET_REQUIRED"); const current = activeBudget;
    requireSafe(closing || !revoked, "LEASE_REVOKED"); const work = current.run(name, cap, fn); inFlight.add(work);
    try { return await work; } finally { inFlight.delete(work); }
  };
  const recordCreateResult = (attempt, value, source = "DOCKER_COMMAND_RESULT") => {
    if (value === undefined || value === null) return;
    const id = String(value).trim(); if (!/^[a-f0-9]{64}$/u.test(id)) return;
    requireSafe(!attempt.resourceId || attempt.resourceId === id, "CREATION_RESULT_CONFLICT");
    attempt.resourceId = id; attempt.idSource = source; attempt.resultMonotonicMs = now() - origin; attempt.outcome = "ID_OBSERVED";
    lease[attempt.role] = { ...lease[attempt.role], id, imageId: attempt.imageId, attempt: attempt.nonce };
    event("creation-result-observed", { role: attempt.role, attempt: attempt.nonce, resourceId: id, source });
  };
  const dockerCall = (args, extra = {}, parameters = {}) => operation("docker:" + args[0], parameters.maxMs ?? (args.includes("psql") ? D8_LIMITS.queryMs : D8_LIMITS.commandMs), async control => {
    const attempt = parameters.attempt;
    try {
      if (attempt) { attempt.dispatched = true; attempt.startedMonotonicMs = now() - origin; }
      const value = await backend.docker(args, extra, { ...control, ...parameters, onSpawn: child => { if (attempt) { attempt.pid = child.pid ?? null; attempt.processStarted = Boolean(child.pid); event("creation-cli-spawned", { attempt: attempt.nonce, role: attempt.role, pid: attempt.pid }); } } });
      if (attempt) { attempt.joined = true; recordCreateResult(attempt, value); }
      return value;
    } catch (error) {
      if (attempt) {
        attempt.joined = error.joined === true; attempt.processStarted = error.processStarted ?? attempt.processStarted;
        recordCreateResult(attempt, error.stdout);
        if (!attempt.resourceId && error.requestRejected === true && error.joined === true && error.resourceAbsentConfirmed === true) attempt.outcome = "NO_RESOURCE_CONFIRMED";
        if (!attempt.resourceId && error.processStarted === false) attempt.outcome = "NOT_STARTED";
      }
      throw error;
    }
  });
  const json = async args => JSON.parse(await dockerCall(args));
  const inspect = async id => { const rows = await json(["inspect", id]); requireSafe(rows.length === 1 && rows[0], "INSPECT_AMBIGUOUS"); return rows[0]; };
  const network = async role => { const rows = await json(["network", "inspect", lease[role].id]); requireSafe(rows.length === 1, "INSPECT_AMBIGUOUS"); assertD6Network(lease, rows[0], role); return rows[0]; };
  const check = async (running = true) => {
    requireSafe(!closed && lease.postgres?.created && lease.haproxy?.created, "RUN_CREATED_RESOURCE_REQUIRED");
    if (backend.verifyEngine) event("engine-identity-observed", await operation("engine-context-identity", D8_LIMITS.commandMs, c => backend.verifyEngine(c)));
    else if (backend.engineId) requireSafe(JSON.parse(await dockerCall(["info", "--format", "{{json .ID}}"])) === backend.engineId, "DOCKER_ENGINE_IDENTITY_CHANGED");
    const containerRows = backend.batched ? await json(["inspect", lease.postgres.id, lease.haproxy.id]) : [await inspect(lease.postgres.id), await inspect(lease.haproxy.id)];
    requireSafe(containerRows.length === 2 && new Set(containerRows.map(c => c.Id)).size === 2, "INSPECT_AMBIGUOUS");
    const pg = containerRows.find(c => c.Id === lease.postgres.id), proxy = containerRows.find(c => c.Id === lease.haproxy.id);
    requireSafe(pg && proxy, "OWNERSHIP_MISMATCH");
    assertD6Container(lease, pg, "postgres", running); assertD6Container(lease, proxy, "haproxy", running);
    const networkRows = backend.batched ? await json(["network", "inspect", lease.backend.id, lease.frontend.id]) : [await network("backend"), await network("frontend")];
    requireSafe(networkRows.length === 2 && new Set(networkRows.map(n => n.Id)).size === 2, "INSPECT_AMBIGUOUS");
    const back = networkRows.find(n => n.Id === lease.backend.id), front = networkRows.find(n => n.Id === lease.frontend.id);
    requireSafe(back && front, "NETWORK_OWNERSHIP_MISMATCH"); assertD6Network(lease, back, "backend"); assertD6Network(lease, front, "frontend");
    event("topology-observed", {
      containers: [pg, proxy].map(c => ({ id: c.Id, created: c.Created, image: c.Image, state: c.State, user: c.Config.User, labels: c.Config.Labels, memory: c.HostConfig.Memory, memorySwap: c.HostConfig.MemorySwap, tmpfs: c.HostConfig.Tmpfs, mounts: c.Mounts, capDrop: c.HostConfig.CapDrop, capAdd: c.HostConfig.CapAdd, securityOpt: c.HostConfig.SecurityOpt, sysctls: c.HostConfig.Sysctls, requestedBindings: c.HostConfig.PortBindings, effectiveBindings: c.NetworkSettings.Ports, networks: c.NetworkSettings.Networks })),
      networks: [back, front].map(n => ({ id: n.Id, created: n.Created, labels: n.Labels, internal: n.Internal, enableIPv6: n.EnableIPv6, driver: n.Driver, options: n.Options, members: Object.keys(n.Containers ?? {}) })),
    });
    if (running) {
      requireSafe(JSON.stringify(Object.keys(back.Containers ?? {}).sort()) === JSON.stringify([lease.postgres.id, lease.haproxy.id].sort()) && Object.keys(front.Containers ?? {}).join() === lease.haproxy.id, "NETWORK_MEMBERSHIP_MISMATCH");
      monitor?.assertLive();
    }
    if (running) {
      const pgNet = Object.values(pg.NetworkSettings.Networks)[0];
      const proxyNet = Object.values(proxy.NetworkSettings.Networks).find(n => n.NetworkID === lease.backend.id);
      requireSafe(pgNet.IPAddress === lease.pgAddress && proxyNet.IPAddress === lease.proxyAddress, "RESOURCE_ENDPOINT_CHANGED");
      const published = (await dockerCall(["port", lease.haproxy.id, "15432/tcp"])).trim();
      requireSafe(published === "127.0.0.1:" + lease.port, "PORT_ENDPOINT_MISMATCH");
      event("binding-observed", { containerId: proxy.Id, requested: { host: "127.0.0.1", port: lease.port, target: "15432/tcp" }, effective: proxy.NetworkSettings.Ports, dockerPortOutput: published });
      const observed = backend.observations ? await backend.observations(lease, dockerCall) : null;
      if (observed) event("live-observations", { postgres: observed.pg, proxy: observed.proxy });
      const read = async (role, key, args) => observed ? (role === "postgres" ? observed.pg : observed.proxy)[key] : dockerCall(args);
      const contents = await read("haproxy", "hash",["exec", proxy.Id, "sha256sum", "/usr/local/etc/haproxy/haproxy.cfg"]);
      requireSafe(contents.trim().split(/\s+/u)[0] === lease.configHash, "PROXY_CONFIG_CHANGED");
      const permissions = await read("haproxy", "permissions",["exec", proxy.Id, "stat", "-c", "%u:%g:%a", "/usr/local/etc/haproxy/haproxy.cfg"]);
      requireSafe(permissions.trim() === "0:0:444", "PROXY_CONFIG_PERMISSIONS_INVALID");
      const mounts = await read("postgres", "mounts",["exec", pg.Id, "cat", "/proc/mounts"]);
      requireSafe(mounts.split("\n").some(l => l.split(" ")[1] === "/var/lib/postgresql" && l.split(" ")[2] === "tmpfs"), "ACTUAL_TMPFS_NOT_VERIFIED");
      const route = await read("postgres", "route",["exec", pg.Id, "cat", "/proc/net/route"]);
      requireSafe(!route.split("\n").some(l => l.trim().split(/\s+/u)[1] === "00000000"), "POSTGRESQL_EXTERNAL_ROUTE");
      requireSafe((await read("haproxy", "forward", ["exec", proxy.Id, "cat", "/proc/sys/net/ipv4/ip_forward"])).trim() === "0", "PROXY_FORWARDING_NOT_DISABLED");
      for (const [container, memory] of [[pg, D6_PROFILE.pgMemory], [proxy, D6_PROFILE.proxyMemory]]) {
        requireSafe(Number((await read(container.Id === pg.Id ? "postgres" : "haproxy", "memory", ["exec", container.Id, "cat", "/sys/fs/cgroup/memory.max"])).trim()) === memory && (await read(container.Id === pg.Id ? "postgres" : "haproxy", "swap", ["exec", container.Id, "cat", "/sys/fs/cgroup/memory.swap.max"])).trim() === "0", "CGROUP_BUDGET_NOT_VERIFIED");
      }
      const status = await read("haproxy", "status",["exec", proxy.Id, "cat", "/proc/1/status"]);
      requireSafe(/^Uid:\s+99\s+99\s+99\s+99$/mu.test(status) && /^Gid:\s+99\s+99\s+99\s+99$/mu.test(status) && /^CapEff:\s+0+$/mu.test(status) && /^NoNewPrivs:\s+1$/mu.test(status), "PROXY_EFFECTIVE_PRIVILEGES_NOT_VERIFIED");
      const cmdline = await read("haproxy", "cmdline",["exec", proxy.Id, "cat", "/proc/1/cmdline"]);
      requireSafe(cmdline.includes("haproxy") && cmdline.includes("/usr/local/etc/haproxy/haproxy.cfg") && !cmdline.includes("-S"), "PROXY_PROCESS_MISMATCH");
      const proxyMounts = await read("haproxy", "mounts",["exec", proxy.Id, "cat", "/proc/mounts"]);
      const tmpfsSize = (contents, path) => {
        const line = contents.split("\n").find(l => l.split(" ")[1] === path && l.split(" ")[2] === "tmpfs");
        const option = line?.split(" ")[3].split(",").find(x => x.startsWith("size="));
        const parsed = option?.match(/^size=(\d+)([kKmMgG]?)$/u); return parsed ? Number(parsed[1]) * ({ "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[parsed[2].toLowerCase()]) : 0;
      };
      requireSafe(tmpfsSize(mounts, "/var/lib/postgresql") === D6_PROFILE.pgTmpfs && tmpfsSize(proxyMounts, "/run/haproxy") === D6_PROFILE.proxyTmpfs, "ACTUAL_TMPFS_BUDGET_NOT_VERIFIED");
      let diagnostic;
      if (observed) {
        const value = observed.proxy.diagnostic;
        if (value.startsWith("EXIT=0\n") && !/Permission denied|Unknown command/iu.test(value)) diagnostic = value.slice(7);
        else if (/^EXIT=[01]\n/u.test(value)) event("proxy-diagnostic", { status: "NOT_VERIFIABLE", reason: "level user unavailable; no escalation" });
        else throw new SafetyError("OBSERVATION_FORMAT_INVALID");
      } else {
        try { diagnostic = await dockerCall(["exec", proxy.Id, "sh", "-c", "printf 'show servers state owned_back\\n' | socat - UNIX-CONNECT:/run/haproxy/owned.sock"]); }
        catch (error) {
          if (!["DIAGNOSTIC_UNAVAILABLE", "INFRASTRUCTURE_COMMAND_FAILED"].includes(error.code)) throw error;
          event("proxy-diagnostic", { status: "NOT_VERIFIABLE", code: error.code, reason: "level user unavailable; no escalation" });
        }
      }
      if (diagnostic) {
        const lines = diagnostic.split("\n"), header = lines.find(l => l.startsWith("#"))?.slice(1).trim().split(/\s+/u);
        requireSafe(header?.includes("srv_addr"), "PROXY_DIAGNOSTIC_TARGET_MISMATCH");
        const data = lines.filter(l => l.trim() && !l.startsWith("#") && l.trim() !== "1").map(l => Object.fromEntries(l.trim().split(/\s+/u).map((value, i) => [header[i], value])));
        requireSafe(data.length === 1 && data[0].be_name === "owned_back" && data[0].srv_name === "owned_pg" && data[0].srv_addr === lease.pgAddress, "PROXY_DIAGNOSTIC_TARGET_MISMATCH");
        event("proxy-diagnostic", { status: "PASS_VERIFIED", target: { address: lease.pgAddress, port: 5432 }, managementPrivilege: "user" });
      }
    }
    return { pg, proxy };
  };

  const assertFresh = () => { requireSafe(!closing && !revoked && !signal.aborted, signal.reason?.code ?? "LEASE_REVOKED"); activeBudget.assert(); requireSafe(!evidenceFailed, "EVIDENCE_WRITE_FAILED"); };
  const executionLive = async () => {
    await operation("runtime-executable", 15_000, control => runtime.assertExecutionLive ? runtime.assertExecutionLive(control) : runtime.assertLive(control));
    if (artifacts) await operation("psql-executables", 15_000, control => artifacts.assertExecutableLive(control));
  };
  const internalIdentity = async () => JSON.parse(await dockerCall(["exec", "--env", "PGPASSWORD", lease.postgres.id, "psql", "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", lease.pgAddress, "-p", "5432", "-U", lease.role, "-d", lease.database, "-c", d6IdentitySql], { PGPASSWORD: lease.password }));
  const trackedSql = async (channel, work) => {
    const row = { id: sqlOperations.length + 1, channel, generation: lease.generation, state: "ACTIVE", startedAt: timestamp() }; sqlOperations.push(row); event("sql-operation-start", row);
    try { const result = await work(); row.state = "CLIENT_COMPLETED"; return result; }
    catch (error) { row.state = "SERVER_OUTCOME_NOT_VERIFIED"; row.code = error.code ?? "SQL_CLIENT_FAILED"; throw error; }
    finally { row.endedAt = timestamp(); event("sql-operation-settled", row); }
  };
  const identities = async ({ readiness = false } = {}) => {
    let internal;
    while (true) {
      assertFresh();
      try { internal = await trackedSql("internal-identity", internalIdentity); break; }
      catch (error) {
        if (!readiness || error.code !== "POSTGRESQL_STARTING") throw error;
        event("postgresql-starting", { code: error.code });
        await operation("readiness-poll", D8_LIMITS.commandMs, c => waitReadinessPoll(c, backend.pollSleep));
      }
    }
    event("sql-internal-identity", { status: simulated ? "PASS_REPORTED_ONLY" : "OBSERVED", identity: internal });
    const host = await trackedSql("windows-identity", () => operation("sql-windows-identity", 5_000, control => backend.hostIdentity(lease, control)));
    event("sql-windows-identity", { status: simulated ? "PASS_REPORTED_ONLY" : "OBSERVED", identity: host });
    assertD6Identity(lease, internal, host); return host;
  };
  const preflight = async ({ readiness = false } = {}) => {
    assertFresh();
    const parent = activeBudget, remaining = parent.remaining();
    // Initial cold readiness retains its existing 30s bootstrap deadline. Every
    // subsequent operational proof has one aggregate 15s deadline of its own.
    const guardBudget = readiness ? null : new MonotonicBudget({ durationMs: Math.min(D13_LIMITS.operationalMs, remaining), code: remaining <= D13_LIMITS.operationalMs ? parent.code : "OPERATIONAL_GUARD_TIMEOUT", now, signal: parent.signal, record: event, onTimeout: revoke });
    activeBudget = guardBudget ?? parent;
    if (guardBudget) event("operational-guard-start", { capMs: D13_LIMITS.operationalMs, effectiveTimeoutMs: Math.min(D13_LIMITS.operationalMs, remaining), generation: lease.generation });
    try {
      await executionLive(); await check(); const host = await identities({ readiness }); await check(); assertFresh();
      lease.identity ??= host;
      const proof = { valid: true, generation: lease.generation, checkedAt: timestamp(), monotonicMs: now() - origin, remainingMs: activeBudget.remaining(), status: simulated ? "PASS_REPORTED_ONLY" : "PASS_VERIFIED", containerId: lease.postgres.id, proxyId: lease.haproxy.id, backendId: lease.backend.id, frontendId: lease.frontend.id, binding: { host: "127.0.0.1", port: lease.port }, server: host };
      event("preflight-positive", proof); assertFresh(); return proof;
    } catch (error) { if (parent.remaining() < 1) error = new SafetyError(parent.code); revoke(error); throw error; }
    finally { if (guardBudget) { event("operational-guard-end", { elapsedMs: guardBudget.elapsed(), generation: lease.generation, aborted: guardBudget.signal.aborted }); guardBudget.dispose(); } activeBudget = parent; }
  };
  const registered = child => { const row = { pid: child.pid ?? null, state: child.pid ? "ACTIVE" : "UNKNOWN", startedAt: timestamp() }; runnerProcesses.push(row); children.add(child); event("owned-runner-child-start", row); child.once("close", () => { children.delete(child); row.state = "JOINED"; row.endedAt = timestamp(); event("owned-runner-child-joined", row); }); };
  const stopChildren = async control => {
    let complete = true;
    for (const child of [...children]) {
      if (child.exitCode !== null || child.signalCode !== null) { await waitWithSignal(new Promise(done => child.once("close", done)), control.signal); continue; }
      try {
        control.beforeSpawn();
        if (process.platform === "win32") await exec(join(process.env.SystemRoot, "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: Math.min(5_000, control.effectiveTimeout()), signal: control.signal }); else child.kill("SIGTERM");
        if (child.exitCode === null && child.signalCode === null) await waitWithSignal(new Promise(done => child.once("close", done)), control.signal);
        if (child.exitCode === null && child.signalCode === null) complete = false;
      } catch { complete = false; }
    }
    requireSafe(complete, "PROCESS_JOIN_INCOMPLETE");
  };
  const stopOnAbort = () => { if (children.size) { const cleanup = budget(10_000, "PROCESS_STOP_TIMEOUT", null); stoppingChildren ??= cleanup.run("stop-owned-children", 10_000, stopChildren).finally(() => cleanup.dispose()); stoppingChildren.catch(() => {}); } };
  signal.addEventListener("abort", stopOnAbort, { once: true });
  const census = async (synthetic = null) => {
    requireSafe(!revoked && !signal.aborted, "LEASE_REVOKED");
    await check(); requireSafe(!revoked && !signal.aborted, "LEASE_REVOKED");
    const monitorName = "m13-monitor-" + randomUUID();
    const snapshot = await operation("sql-session-census", D8_LIMITS.queryMs, c => backend.sessionCensus(lease, monitorName, c));
    requireSafe(!revoked && !signal.aborted, "LEASE_REVOKED"); assertD6Identity(lease, snapshot.identity, lease.identity);
    const result = classifySessionCensus(snapshot, { database: lease.database, role: lease.role, monitorName, syntheticPid: synthetic?.pid, syntheticName: synthetic?.applicationName });
    event("session-census", result); event("sql-monitor-closed", { pid: result.monitor.pid, joined: true, transaction: "READ_ONLY_COMMITTED" }); return result;
  };
  const drainSql = async () => {
    const parent = activeBudget, drain = budget(Math.min(5_000, parent.remaining()), "SQL_DRAIN_TIMEOUT", parent.signal); activeBudget = drain;
    let attempts = 0, last;
    event("quiescence-check-started", { maximumDrainMs: 5_000, newApplicationDispatch: "BLOCKED" });
    try {
      while (true) {
        drain.assert(); last = await census(); attempts++;
        event("connection-drain", { attempts, elapsedMs: drain.elapsed(), otherClientSessionsCount: last.otherClientSessionsCount });
        if (last.quiet) { drain.assert(); event("database-clients-drained", { attempts, elapsedMs: drain.elapsed() }); return last; }
        await operation("connection-drain-poll", 5_000, c => waitReadinessPoll(c, backend.pollSleep));
      }
    } finally { event("drain-settled", { attempts, elapsedMs: drain.elapsed(), finalOtherClientSessionsCount: last?.otherClientSessionsCount ?? null }); drain.dispose(); activeBudget = parent; }
  };
  let earlyQuiescence;
  const validateQuiescence = async () => {
    requireSafe(!busy && !closing && !closed && !revoked && !firstWriter && commands.length === 0 && !earlyQuiescence, "EARLY_QUIESCENCE_NOT_AUTHORIZED"); busy = true;
    const scope = budget(15_000, "EARLY_QUIESCENCE_TIMEOUT"); activeBudget = scope; let connection;
    try {
      await preflight();
      connection = await operation("synthetic-client-start", 5_000, c => backend.syntheticConnection(lease, "m13-synthetic-" + randomUUID(), c)); syntheticConnections.add(connection);
      const observed = await census(connection); requireSafe(observed.sessions.some(r => r.pid === connection.pid && r.ownership === "SYNTHETIC_CLIENT_CORRELATED"), "SYNTHETIC_CLIENT_NOT_OBSERVED");
      await operation("synthetic-client-close", 5_000, () => connection.close()); requireSafe(connection.joined, "SYNTHETIC_SQL_JOIN_FAILED"); syntheticConnections.delete(connection);
      await drainSql(); scope.assert(); earlyQuiescence = { status: simulated ? "PASS_REPORTED_ONLY" : "PASS_VERIFIED", detectedPid: connection.pid, syntheticClientClosed: true, noApplicationWriter: !firstWriter, elapsedMs: scope.elapsed() }; event("early-quiescence-validation", earlyQuiescence); return earlyQuiescence;
    } catch (error) { revoke(error); throw error; }
    finally { if (connection && !connection.joined) { try { await connection.close(); syntheticConnections.delete(connection); } catch { event("synthetic-client-close-failed", { pid: connection.pid }); } } scope.dispose(); activeBudget = null; busy = false; }
  };
  const confirmCreated = async attempt => {
    requireSafe(attempt.resourceId && ["DOCKER_COMMAND_RESULT", "OWNED_CREATE_CIDFILE", "SYNTHETIC_COMMAND_RESULT"].includes(attempt.idSource), "CREATION_OUTCOME_UNCERTAIN");
    if (attempt.role === "backend" || attempt.role === "frontend") {
      const rows = await json(["network", "inspect", attempt.resourceId]); requireSafe(rows.length === 1 && rows[0].Labels?.["piccadilly.attempt"] === attempt.nonce, "NETWORK_OWNERSHIP_MISMATCH");
      lease[attempt.role].created ??= rows[0].Created; assertD6Network(lease, rows[0], attempt.role);
    } else {
      const c = await inspect(attempt.resourceId); requireSafe(c.Config?.Labels?.["piccadilly.attempt"] === attempt.nonce, "OWNERSHIP_MISMATCH");
      lease[attempt.role].created ??= c.Created; assertD6Container(lease, c, attempt.role, false);
    }
    attempt.ownershipConfirmed = true;
  };
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true; armed = false;
      if (busy || inFlight.size) { revoked = true; if (!signal.aborted) controller.abort(new SafetyError("RUN_CLOSING")); }
      activeBudget?.dispose();
      const cleanup = budget(D8_LIMITS.teardownMs, "TEARDOWN_TIMEOUT", null); activeBudget = cleanup; let complete = true;
      try {
        const pending = [...inFlight]; if (pending.length) await operation("join-inflight", 5_000, control => waitWithSignal(Promise.allSettled(pending), control.signal));
        try { await stoppingChildren; await operation("stop-owned-children", 10_000, stopChildren); } catch (error) { complete = false; event("teardown-incomplete", { code: error.code }); }
        for (const child of backend.toolchain?.processes ?? []) {
          if (child.pid === monitor?.pid || child.exitCode !== null || child.signalCode !== null) continue;
          try { await operation("infrastructure-stop-join", 5_000, control => new Promise((done, reject) => { const timer = setTimeout(() => reject(new SafetyError("INFRASTRUCTURE_JOIN_INCOMPLETE")), control.timeoutMs); child.once("close", () => { clearTimeout(timer); done(); }); child.kill("SIGKILL"); })); }
          catch (error) { complete = false; event("teardown-incomplete", { code: error.code ?? "INFRASTRUCTURE_JOIN_INCOMPLETE", pid: child.pid }); }
        }
        for (const attempt of attempts) {
          try {
            if (!attempt.resourceId && attempt.dispatched && !["NOT_STARTED", "NO_RESOURCE_CONFIRMED"].includes(attempt.outcome)) {
              const recovered = backend.recoverCreation ? await operation("reconcile-create", 5_000, control => backend.recoverCreation(attempt, control)) : null;
              if (recovered?.id) recordCreateResult(attempt, recovered.id, recovered.source);
              if (!attempt.resourceId) {
                attempt.outcome = "UNCERTAIN"; complete = false;
                const args = attempt.role === "backend" || attempt.role === "frontend" ? ["network", "ls", "-q", "--no-trunc", "--filter", "label=piccadilly.attempt=" + attempt.nonce] : ["ps", "-aq", "--no-trunc", "--filter", "label=piccadilly.attempt=" + attempt.nonce];
                const candidates = await dockerCall(args); event("creation-outcome-uncertain", { attempt: attempt.nonce, role: attempt.role, observedCandidateIds: candidates.trim().split("\n").filter(Boolean), cleanupVerified: false });
              }
            }
            if (attempt.resourceId) await confirmCreated(attempt);
          } catch (error) { complete = false; event("teardown-incomplete", { role: attempt.role, code: error.code ?? "RECONCILIATION_FAILED" }); }
        }
        for (const connection of syntheticConnections) { try { await operation("close-owned-sql-client", 5_000, () => connection.close()); requireSafe(connection.joined, "SYNTHETIC_SQL_JOIN_FAILED"); syntheticConnections.delete(connection); } catch (error) { complete = false; event("teardown-incomplete", { code: error.code }); } }
        const processesJoined = verificationQuiescence().verified && ownedProcessQuiescence().verified && ownedProcessQuiescence(new Set(runnerProcesses)).verified && syntheticConnections.size === 0;
        event("application-children-joined", { verified: processesJoined }); event("database-clients-closed", { ownedSyntheticClients: syntheticConnections.size, applicationChildrenJoined: processesJoined, parentPools: "NONE_CREATED_BY_HARNESS", runnerClients: "withClient finally awaits end; child clients joined" });
        if (lease.identity && !revoked && processesJoined) {
          try { await drainSql(); event("quiescence", { status: "PASS_VERIFIED" }); }
          catch (error) { complete = false; event("quiescence", { status: "FAIL", code: error.code }); }
        } else event("quiescence", { status: "NOT_VERIFIABLE", reason: "No qualified active lease; no SQL cleanup" });
        if (!processesJoined || (lease.identity && !revoked && events.findLast(e => e.kind === "quiescence")?.status !== "PASS_VERIFIED")) complete = false;
        if (!revoked) { revoked = true; controller.abort(new SafetyError("RUN_CLOSED")); event("remaining-access-revoked", { newWriters: "FORBIDDEN", monitoring: "CLOSED" }); }
        for (const role of ["haproxy", "postgres"]) {
          const attempt = attempts.find(a => a.role === role); if (!attempt?.resourceId) continue;
          try {
            requireSafe(attempt.ownershipConfirmed, "OWNERSHIP_NOT_CONFIRMED"); const c = await inspect(attempt.resourceId); assertD6Container(lease, c, role, false);
            const stopMs = role === "postgres" ? D8_LIMITS.postgresStopMs : D8_LIMITS.proxyStopMs;
            if (c.State.Running) await dockerCall(["stop", "--time", String(stopMs / 1000), c.Id], {}, { maxMs: stopMs });
            const stopped = await inspect(c.Id); requireSafe(stopped.State.Running === false, "CONTAINER_STOP_INCOMPLETE"); await dockerCall(["rm", c.Id]);
            requireSafe(!(await dockerCall(["ps", "-aq", "--no-trunc", "--filter", "id=" + c.Id])).trim(), "CONTAINER_TEARDOWN_INCOMPLETE"); attempt.outcome = "ABSENCE_VERIFIED"; event("container-removed", { role, containerId: c.Id });
          } catch (error) { complete = false; event("teardown-incomplete", { role, code: error.code ?? "CLEANUP_FAILED" }); }
        }
        for (const role of ["frontend", "backend"]) {
          const attempt = attempts.find(a => a.role === role); if (!attempt?.resourceId) continue;
          try {
            requireSafe(attempt.ownershipConfirmed, "OWNERSHIP_NOT_CONFIRMED"); const n = await network(role); requireSafe(!Object.keys(n.Containers ?? {}).length, "NETWORK_NOT_EMPTY"); await dockerCall(["network", "rm", n.Id]);
            requireSafe(!(await dockerCall(["network", "ls", "-q", "--no-trunc", "--filter", "id=" + n.Id])).trim(), "NETWORK_TEARDOWN_INCOMPLETE"); attempt.outcome = "ABSENCE_VERIFIED"; event("network-removed", { role, networkId: n.Id });
          } catch (error) { complete = false; event("teardown-incomplete", { role, code: error.code ?? "CLEANUP_FAILED" }); }
        }
        try { if (monitor) await operation("event-stream-stop-join", 5_000, c => monitor.close(c)); } catch (error) { complete = false; event("teardown-incomplete", { code: error.code ?? "EVENT_STREAM_JOIN_INCOMPLETE" }); }
        const verifiers = verificationQuiescence(), applications = ownedProcessQuiescence(), runners = ownedProcessQuiescence(new Set(runnerProcesses));
        const infrastructureActive = [...(backend.toolchain?.processes ?? [])].filter(child => child.exitCode === null && child.signalCode === null).length;
        const pgAttempt = attempts.find(attempt => attempt.role === "postgres");
        const sqlTermination = pgAttempt?.outcome === "ABSENCE_VERIFIED" ? "OWNED_POSTGRESQL_STOPPED_AND_ABSENT" : sqlOperations.length ? "NOT_VERIFIED" : "NOT_RUN";
        const engineApiQuiescence = { requests: [...engineRequests].map(row => ({ ...row })), verified: [...engineRequests].every(row => row.state === "JOINED") };
        event("engine-api-quiescence", engineApiQuiescence);
        if (!verifiers.verified || !applications.verified || !runners.verified || infrastructureActive || !engineApiQuiescence.verified || sqlTermination === "NOT_VERIFIED") complete = false;
        event("task-quiescence", { status: complete ? simulated ? "PASS_REPORTED_ONLY" : "PASS_VERIFIED" : "NOT_VERIFIED", newDispatchBlocked: true, verifiers, applications, runners, infrastructureActive, sqlOperations: sqlOperations.map(row => ({ ...row })), sqlTermination, liveSqlQuiescence: events.findLast(row => row.kind === "quiescence")?.status ?? "NOT_VERIFIABLE" });
      } catch (error) { complete = false; event("teardown-incomplete", { code: error.code ?? "TEARDOWN_FAILED" }); }
      finally {
        cleanup.dispose(); bootstrapBudget?.dispose(); externalSignal?.removeEventListener("abort", abort); signal.removeEventListener("abort", stopOnAbort); closed = true;
        if (attempts.some(a => a.dispatched && !["ABSENCE_VERIFIED", "NOT_STARTED", "NO_RESOURCE_CONFIRMED"].includes(a.outcome))) complete = false;
        const resourceAbsenceVerified = attempts.every(attempt => !attempt.dispatched || ["ABSENCE_VERIFIED", "NOT_STARTED", "NO_RESOURCE_CONFIRMED"].includes(attempt.outcome));
        event("teardown", { complete, resourceAbsenceVerified, elapsedMs: cleanup.elapsed(), primaryRevoked: revoked });
      }
      return complete;
    })(); return closePromise;
  };
  const create = async () => {
    requireSafe(!lease.backend && !closed, "RUN_ALREADY_CREATED"); activeBudget = budget(60_000, "PRE_RESOURCE_PREFLIGHT_TIMEOUT");
    try {
      event("resource-budget", await operation("resource-budget", 15_000, control => backend.budget(control))); requireSafe(!evidenceFailed, "EVIDENCE_WRITE_FAILED");
      const images = {};
      for (const role of ["postgres", "haproxy"]) {
        const pin = D6_PINS[role], rows = await json(["image", "inspect", role + "@" + (role === "postgres" ? pin.index : pin.manifest)]);
        requireSafe(rows.length === 1 && rows[0].Os === "linux" && rows[0].Architecture === "amd64" && [pin.index, pin.config, pin.manifest].includes(rows[0].Id) && rows[0].RepoDigests?.some(d => [role + "@" + pin.index, role + "@" + pin.manifest].includes(d)), "IMAGE_ORIGIN_NOT_VERIFIED"); images[role] = rows[0].Id;
      }
      activeBudget.dispose(); activeBudget = bootstrapBudget = budget(30_000, "TOPOLOGY_BOOTSTRAP_TIMEOUT"); event("bootstrap-start", { budgetMs: 30_000, generation: lease.generation });
      const createResource = async (role, args, name) => {
        const attempt = { nonce: randomUUID(), role, name, imageId: images[role], generation: lease.generation, plannedMonotonicMs: now() - origin, dispatched: false, outcome: "PLANNED" }; attempts.push(attempt);
        for (const [key, value] of Object.entries({ ...d6Labels(lease, role), "piccadilly.attempt": attempt.nonce })) args.push("--label", key + "=" + value);
        if (role === "postgres" || role === "haproxy") {
          if (backend.creationFile) { attempt.cidfile = await operation("create-cidfile-path", 5_000, () => backend.creationFile(attempt)); args.push("--cidfile", attempt.cidfile); }
          args.push(images[role]);
        } else args.push(name);
        attempt.requestSha256 = hash(JSON.stringify(args)); event("creation-attempt", { attempt: attempt.nonce, role, name, requestSha256: attempt.requestSha256, generation: attempt.generation }); requireSafe(!evidenceFailed, "EVIDENCE_WRITE_FAILED");
        await dockerCall(args, role === "postgres" ? { POSTGRES_PASSWORD: lease.password } : {}, { attempt }); requireSafe(attempt.resourceId, "CREATION_OUTCOME_UNCERTAIN"); await confirmCreated(attempt);
      };
      for (const role of ["backend", "frontend"]) {
        const args = ["network", "create", "--driver", "bridge", "--ipv6=false"]; if (role === "backend") args.push("--internal", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated"); await createResource(role, args, "m13-d8-" + role + "-" + suffix);
      }
      await createResource("postgres", ["create", "--pull=never", "--platform", "linux/amd64", "--name", "m13-d8-pg-" + suffix, "--network", lease.backend.id, "--memory", String(D6_PROFILE.pgMemory), "--memory-swap", String(D6_PROFILE.pgMemory), "--tmpfs", "/var/lib/postgresql:rw,noexec,nosuid,size=" + D6_PROFILE.pgTmpfs, "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB=" + lease.database, "--env", "POSTGRES_USER=" + lease.role], "m13-d8-pg-" + suffix);
      await dockerCall(["start", lease.postgres.id]); const pg = await inspect(lease.postgres.id); assertD6Container(lease, pg, "postgres"); lease.pgAddress = Object.values(pg.NetworkSettings.Networks)[0].IPAddress; lease.postgres.started = pg.State.StartedAt; lease.postgres.pid = pg.State.Pid;
      const choice = await operation("port-selection-and-close", 5_000, c => backend.selectPort(c)); requireSafe(choice.apiCloseCompleted === true && choice.closedBeforeDockerCreate === true && Number.isInteger(choice.port) && choice.port >= 1024 && choice.port <= 65535 && choice.port !== 5432, "HOST_PORT_SELECTION_UNSAFE"); lease.port = choice.port; event("port-selection-closed", choice);
      const content = proxyConfiguration(lease.pgAddress); lease.configHash = hash(Buffer.from(content));
      await createResource("haproxy", ["create", "--pull=never", "--platform", "linux/amd64", "--name", "m13-d8-proxy-" + suffix, "--network", "name=" + lease.frontend.id + ",gw-priority=1", "--network", lease.backend.id, "--user", "99:99", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--sysctl", "net.ipv4.ip_forward=0", "--memory", String(D6_PROFILE.proxyMemory), "--memory-swap", String(D6_PROFILE.proxyMemory), "--tmpfs", "/run/haproxy:rw,noexec,nosuid,size=" + D6_PROFILE.proxyTmpfs + ",uid=99,gid=99,mode=0700", "--publish", "127.0.0.1:" + lease.port + ":15432/tcp", "--log-driver", "none"], "m13-d8-proxy-" + suffix);
      const configProof = await backend.config(lease.haproxy.id, content, { operation, docker: dockerCall }); activeBudget.assert(); requireSafe(configProof.sha256 === lease.configHash && configProof.mode === "0444" && configProof.uid === 0 && configProof.regular === true, "PROXY_CONFIG_BEFORE_START_NOT_VERIFIED"); event("proxy-config-before-start", configProof);
      await dockerCall(["start", lease.haproxy.id]); const proxy = await inspect(lease.haproxy.id); assertD6Container(lease, proxy, "haproxy"); lease.proxyAddress = Object.values(proxy.NetworkSettings.Networks).find(n => n.NetworkID === lease.backend.id).IPAddress; lease.haproxy.started = proxy.State.StartedAt; lease.haproxy.pid = proxy.State.Pid;
      const url = new URL(`postgresql://127.0.0.1:${lease.port}/${lease.database}`); url.username = lease.role; url.password = lease.password; lease.url = url.href; secrets.push(lease.url);
      monitor = await operation("event-stream-start", 5_000, () => backend.monitor(lease, value => { if (armed && (value.failure || !["exec_create", "exec_start", "exec_die"].some(action => value.action?.startsWith(action)))) revoke(new SafetyError(value.failure ?? "DOCKER_RESOURCE_EVENT")); }));
      await operation("event-stream-ready", 15_000, c => monitor.ready([lease.postgres.id, lease.haproxy.id], c)); armed = true;
      const proof = await preflight({ readiness: true }); assertFresh(); bootstrapTiming = { status: simulated ? "PASS_REPORTED_ONLY" : "PASS_VERIFIED", elapsedMs: bootstrapBudget.elapsed(), remainingMs: bootstrapBudget.remaining(), budgetMs: 30_000 }; event("bootstrap-complete", bootstrapTiming); bootstrapBudget.dispose(); activeBudget = null; return proof;
    } catch (error) { bootstrapTiming = bootstrapBudget ? { status: "FAIL", elapsedMs: bootstrapBudget.elapsed(), budgetMs: 30_000, code: error.code } : { status: "NOT_RUN", code: error.code }; revoke(error); event("blocked", { code: error.code ?? "CREATE_FAILED" }); await close(); throw error; }
  };
  const run = async role => {
    requireSafe(!busy && !closed && !closing && !revoked, "RUN_BUSY_CLOSED_OR_REVOKED"); requireSafe(simulated || earlyQuiescence?.status === "PASS_VERIFIED", "EARLY_QUIESCENCE_REQUIRED"); const definitions = commandDefinitions(runtime); requireSafe(Object.hasOwn(definitions, role), "COMMAND_NOT_ALLOWLISTED"); busy = true;
    const roleBudget = budget(deadlineMs, "ROLE_DEADLINE"); activeBudget = roleBudget;
    try {
      const before = await operation("source-before", 15_000, control => backend.source(control));
      // npm consumes its full bundle. Other canonical roles execute Node directly;
      // they freshly verify that binary, not an npm bundle they do not execute.
      // Requalify the whole bundle after ci, before any subsequent D2 dispatch.
      if (runtime.assertQualified && (qualificationPending || definitions[role][0] === runtime.npmCli)) {
        await operation("runtime-full-qualification", D13_LIMITS.fullMaximumMs, control => runtime.assertQualified(control));
        qualificationPending = false;
        event("runtime-full-qualified", { role, targetMs: D13_LIMITS.fullTargetMs, maximumMs: D13_LIMITS.fullMaximumMs, reason: "D11 full bundle exceeded 15s; D12 post-ci verifier timed out; maximum applies only to full qualification" });
      }
      await operation("role-runtime-provenance", D13_LIMITS.operationalMs, control => runtime.assertOperationalLive ? runtime.assertOperationalLive(control) : runtime.assertLive(control));
      if (role.startsWith("e2e")) await operation("application-port", 5_000, () => backend.applicationPort()); const proof = await preflight();
      const guard = async context => { assertD6RunnerTarget(lease, context); const result = await preflight(); event("runner-phase-guard", { phase: context.phase, generation: result.generation, checkedAt: result.checkedAt }); return result; };
      assertFresh(); if (!firstWriter) { firstWriter = true; event("first-writer-preflight", { role, generation: proof.generation, checkedAt: proof.checkedAt }); }
      const environment = cleanEnvironment(simulated ? {} : process.env, runtime.directory), generated = Object.fromEntries(["AUTH_RATE_LIMIT_SECRET", "PUBLIC_BOOKING_RATE_LIMIT_SECRET", "PUBLIC_BOOKING_MANAGEMENT_SECRET", "AUTH_DEMO_ADMIN_PASSWORD", "AUTH_DEMO_STAFF_PASSWORD"].map(key => [key, "M13-only-" + randomBytes(32).toString("base64url")])); secrets.push(...Object.values(generated));
      Object.assign(environment, generated, { DATABASE_URL: lease.url, APP_ENV: "development", AUTH_TRUST_PROXY: "false", NEXT_TELEMETRY_DISABLED: "1", RESERVATION_PRIVACY_POLICY_VERSION: "m13-p1-synthetic", RESERVATION_TERMS_VERSION: "m13-p1-synthetic", RESERVATION_IDEMPOTENCY_TTL_HOURS: "24", PUBLIC_BOOKING_RATE_LIMIT_WINDOW_SECONDS: "900", PUBLIC_BOOKING_READ_LIMIT: "10000", PUBLIC_BOOKING_MUTATION_LIMIT: "10000", NPM_CONFIG_CACHE: join(evidenceDirectory, "npm-cache"), NPM_CONFIG_USERCONFIG: join(evidenceDirectory, "empty-user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(evidenceDirectory, "empty-global.npmrc") });
      let result;
      if (!simulated && (role.startsWith("vitest") || role.startsWith("e2e"))) {
        const options = { environment, requireOwnership: true, ownershipGuard: guard, signal: roleBudget.signal, onChild: registered };
        if (role.startsWith("vitest")) { const { runIsolatedVitest } = await import("./run-vitest-isolated.mjs"); result = { exitCode: await runIsolatedVitest({ ...options, vitestArguments: definitions[role].slice(1) }), reason: null, executable: process.execPath }; }
        else { const { runE2e } = await import("./run-e2e.mjs"); result = { exitCode: await runE2e({ ...options, argumentsList: definitions[role].slice(1), stopChild: async () => operation("stop-e2e-children", 10_000, stopChildren), onOutcome: value => event("e2e-outcome", value) }), reason: null, executable: process.execPath }; }
      } else result = await backend.child(definitions[role], environment, { signal: roleBudget.signal, deadlineMs: Math.floor(roleBudget.remaining()), secrets, stdout: out => simulated ? undefined : writeFile(join(evidenceDirectory, role + ".log"), out) });
      if (role === "ci") qualificationPending = true;
      const postflight = await preflight(), after = await operation("source-after", 15_000, control => backend.source(control)); const ok = result.exitCode === 0 && !result.reason;
      const record = { role, ...result, proof, postflight, before, after, result: ok ? simulated ? "PASS_REPORTED_ONLY" : "PASS_VERIFIED" : "FAIL" }; commands.push(record); requireSafe(before.freeze === after.freeze, "SOURCE_CHANGED"); requireSafe(ok, "CHILD_FAILED"); return record;
    } catch (error) { revoke(error); throw error; }
    finally { roleBudget.dispose(); busy = false; if (!closing) activeBudget = null; }
  };
  const verifyLease = async options => {
    if (activeBudget) return preflight(options);
    const verification = budget(30_000, "LEASE_VERIFICATION_TIMEOUT"); activeBudget = verification;
    try { return await preflight(options); } finally { verification.dispose(); if (!closing) activeBudget = null; }
  };
  return Object.freeze({ create, preflight: verifyLease, validateQuiescence, run, close, receipt: () => ({ runId, simulated, earlyQuiescence, runtime: runtime.receipt, artifacts: artifacts?.receipt ?? { status: "PASS_REPORTED_ONLY" }, infrastructureCommands: backend.toolchain?.operations ?? [], events, commands, creationAttempts: attempts.map(a => ({ ...a, imageId: a.imageId })), bootstrapTiming, verification: verificationQuiescence(), taskQuiescence: events.findLast(e => e.kind === "task-quiescence") ?? null, sqlOperations: sqlOperations.map(row => ({ ...row })), positiveOwnership: !simulated && !revoked && events.some(e => e.kind === "preflight-positive"), firstWriterPreflight: firstWriter, teardown: events.findLast(e => e.kind === "teardown") ?? null, proxyEgressRisk: "ACCEPTED_LOCAL_SYNTHETIC_ONLY" }) });
}


if (!isMainThread && workerData?.kind === "m13-runtime-verifier") await runtimeVerifierEntry(workerData);

if (isMainThread && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => {
  console.error(JSON.stringify({ status: "BLOCKED", code: error instanceof SafetyError ? error.code : "UNCLASSIFIED_FAILURE", cleanupStatus: error.cleanupStatus ?? "NOT_RUN", nodePinPass: false })); process.exitCode ||= 2;
});
