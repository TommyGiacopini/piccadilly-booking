import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, readlink, open, mkdir, lstat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

export class LinuxSafetyError extends Error {
  constructor(code) { super(code); this.name = "LinuxSafetyError"; this.code = code; }
}
export function linuxAssert(value, code) { if (!value) throw new LinuxSafetyError(code); }
const sha = value => createHash("sha256").update(value).digest("hex");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);
const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
export const linuxExact = (value, keys) => object(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const ownedDatabaseTargets = new WeakSet();
export const isLinuxOwnedDatabaseTarget = target => ownedDatabaseTargets.has(target);
export function assertLinuxTargetShape(target, context) {
  linuxAssert(linuxExact(target, ["runId", "generation", "slot", "containerId", "networkId", "postgresId", "serverAddress", "database", "role", "identity"])
    && target.runId === context.runId && target.generation === context.generation && target.slot === context.slot
    && [target.containerId, target.networkId, target.postgresId].every(value => /^[a-f0-9]{64}$/u.test(value))
    && isIPv4(target.serverAddress) && !target.serverAddress.startsWith("127.") && /^piccadilly_e2e_[a-f0-9]{32}$/u.test(target.database)
    && /^m13_p1_[a-f0-9]{16}$/u.test(target.role) && linuxExact(target.identity, ["database", "role", "version", "dataDirectory", "systemIdentifier", "postmasterStart", "serverAddress", "clientAddress", "serverPort"])
    && target.identity.database === target.database && target.identity.role === target.role && target.identity.serverPort === 5432
    && typeof target.identity.serverAddress === "string" && typeof target.identity.clientAddress === "string" && isIPv4(target.identity.clientAddress.replace(/\/32$/u, ""))
    && target.identity.serverAddress.replace(/\/32$/u, "") === target.serverAddress, "LINUX_DATABASE_TARGET_INVALID");
}
export function assertLinuxDnsIsolation(observed, proof, context) {
  linuxAssert(linuxExact(proof, ["runId", "generation", "slot", "attempt", "containerId", "networkId", "engineId", "upstream", "subnet", "bootId", "created", "started", "imageId"])
    && ["runId", "generation", "slot", "attempt"].every(key => proof[key] === context[key])
    && [proof.containerId, proof.networkId].every(value => /^[a-f0-9]{64}$/u.test(value)) && /^sha256:[a-f0-9]{64}$/u.test(proof.imageId)
    && typeof proof.engineId === "string" && /^[A-Za-z0-9:_-]{5,128}$/u.test(proof.engineId) && uuid(proof.bootId)
    && Number.isFinite(Date.parse(proof.created)) && Date.parse(proof.started) >= Date.parse(proof.created)
    && Array.isArray(proof.upstream) && proof.upstream.length === 1 && proof.upstream[0] === "127.0.0.1", "LINUX_DNS_UPSTREAM_NOT_OWNED");
  linuxAssert(observed && observed.bootId === proof.bootId && /^pid:\[\d+\]$/u.test(observed.pidNamespace) && /^net:\[\d+\]$/u.test(observed.netNamespace)
    && observed.pidNamespace === context.pidNamespace && observed.netNamespace === context.netNamespace && typeof observed.route === "string" && typeof observed.route6 === "string"
    && Array.isArray(observed.resolvers) && observed.resolvers.length === 1 && ["127.0.0.1", "127.0.0.11"].includes(observed.resolvers[0])
    && Array.isArray(observed.addresses) && observed.addresses.length === 1 && isIPv4(observed.addresses[0]), "LINUX_DNS_NAMESPACE_MISMATCH");
  const subnet = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/u.exec(proof.subnet);
  linuxAssert(subnet && isIPv4(subnet[1]) && Number(subnet[2]) >= 1 && Number(subnet[2]) <= 29, "LINUX_BACKEND_SUBNET_INVALID");
  const number = value => value.split(".").reduce((result, part) => (result * 256 + Number(part)) >>> 0, 0);
  const mask = (0xffffffff << (32 - Number(subnet[2]))) >>> 0, destination = (number(subnet[1]) & mask) >>> 0;
  linuxAssert(((number(observed.addresses[0]) & mask) >>> 0) === destination, "LINUX_DNS_NAMESPACE_MISMATCH");
  const decode = value => { linuxAssert(/^[a-f0-9]{8}$/iu.test(value), "LINUX_ROUTE_UNVERIFIABLE"); return Number.parseInt(value.match(/../gu).reverse().join(""), 16) >>> 0; };
  let backendRoute = false;
  for (const line of observed.route.split("\n").slice(1).filter(value => value.trim())) {
    const fields = line.trim().split(/\s+/u); linuxAssert(fields.length >= 8 && decode(fields[2]) === 0, "LINUX_EXTERNAL_ROUTE");
    const target = decode(fields[1]), routeMask = decode(fields[7]);
    if (fields[0] === "lo" && (target >>> 24) === 127) continue;
    linuxAssert(target === destination && routeMask === mask && routeMask !== 0, "LINUX_EXTERNAL_ROUTE"); backendRoute = true;
  }
  linuxAssert(backendRoute, "LINUX_BACKEND_ROUTE_NOT_OBSERVED");
  for (const line of observed.route6.split("\n").filter(value => value.trim())) {
    const fields = line.trim().split(/\s+/u);
    linuxAssert(fields.length === 10 && fields[9] === "lo" && (fields[0] === "0".repeat(31) + "1" && fields[1] === "80" || (Number.parseInt(fields[8], 16) & 0x200) !== 0), "LINUX_IPV6_EXTERNAL_ROUTE");
  }
  return { resolver: observed.resolvers[0], upstream: "127.0.0.1", netNamespace: observed.netNamespace, clientAddress: observed.addresses[0], proofSha256: sha(JSON.stringify(proof)) };
}
export async function receiveLinuxDatabaseBinding() {
  linuxAssert(process.platform === "linux" && process.arch === "x64" && process.connected, "LINUX_PRIVATE_BINDING_REQUIRED");
  const binding = await linuxBounded(() => new Promise((done, reject) => {
    const receive = value => { process.off("disconnect", lost); done(value); };
    const lost = () => { process.off("message", receive); reject(new LinuxSafetyError("LINUX_PRIVATE_BINDING_LOST")); };
    process.once("message", receive); process.once("disconnect", lost);
    process.send({ type: "LINUX_BINDING_REQUEST" });
  }), 5000, "LINUX_PRIVATE_BINDING_TIMEOUT");
  linuxAssert(linuxExact(binding, ["type", "target", "supervisor"]) && binding.type === "LINUX_BINDING", "LINUX_PRIVATE_BINDING_INVALID");
  const [parent, self, bytes] = await Promise.all([readLinuxProcess(process.ppid), readLinuxProcess(process.pid), readFile("/app/p1c-artifact.json", "utf8")]);
  const profile = JSON.parse(bytes), target = binding.target;
  assertLinuxTargetShape(target, { runId: process.env.P1C_RUN_ID, generation: process.env.P1C_GENERATION, slot: process.env.P1C_SLOT });
  linuxAssert(parent.pid === binding.supervisor.pid && parent.startTicks === binding.supervisor.startTicks && parent.executableSha256 === profile.node.sha256
    && parent.executable === profile.node.path && parent.pidns === self.pidns && parent.netns === self.netns && parent.mntns === self.mntns
    && parent.parent === 1 && target?.runId === process.env.P1C_RUN_ID && target.generation === process.env.P1C_GENERATION && target.slot === process.env.P1C_SLOT
    && /^[a-f0-9]{64}$/u.test(target.containerId) && /^[a-f0-9]{64}$/u.test(target.networkId), "LINUX_PRIVATE_BINDING_INVALID");
  ownedDatabaseTargets.add(target); return target;
}

// Controller commit and supervisor spawn use separate, irreversible local fences.
// A command committed before the controller fence can still be in flight (D15 §7.3).
export function createLinuxAuthority({ runId, generation, slot, attempt, now = () => performance.now(), durationMs, send = () => {} }) {
  linuxAssert(uuid(runId) && uuid(generation) && uuid(attempt) && ["A", "B"].includes(slot), "LINUX_AUTHORITY_IDENTITY");
  linuxAssert(durationMs > 0 && durationMs <= 600_000, "LINUX_AUTHORITY_DEADLINE");
  const deadline = now() + durationMs, operations = [];
  let closing = false, settled = false, sequence = 0, childEver = false;
  const assert = () => { linuxAssert(!closing && !settled && now() < deadline, "P1C_ABORTED"); };
  return Object.freeze({
    assert,
    get closing() { return closing; },
    get remaining() { return Math.max(0, deadline - now()); },
    fence(reason = "P1C_ABORTED") { if (!closing) { closing = true; operations.push({ phase: "FENCE", sequence, reason }); } },
    settle() { closing = true; settled = true; },
    commit(type, data) {
      assert();
      const packet = { v: 1, runId, generation, slot, attempt, seq: ++sequence, type, data };
      operations.push({ phase: "COMMITTED", sequence, type });
      // No await between the final authority check and the actual transport write.
      send(packet); return packet;
    },
    reconcile(type, data = {}) {
      linuxAssert(["STOP", "STATUS", "RELEASE"].includes(type) || type === "PACKET" && data?.type === "STOP", "LINUX_RECONCILIATION_CANNOT_DISPATCH");
      const packet = { v: 1, runId, generation, slot, attempt, seq: ++sequence, type, data };
      operations.push({ phase: "RECONCILIATION", sequence, type }); send(packet); return packet;
    },
    spawnOnce(create, track) {
      assert(); linuxAssert(!childEver, "LINUX_RESTART_FORBIDDEN"); childEver = true;
      const child = create();
      // A returned handle is owned even if notification/registration later fails.
      track(child); return child;
    },
    records: () => operations.map(value => ({ ...value })),
  });
}

export async function linuxBounded(work, milliseconds, code, signal) {
  linuxAssert(Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds <= 600_000, "LINUX_UNBOUNDED_OPERATION");
  let timer, aborted;
  const stop = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new LinuxSafetyError(code)), milliseconds);
    aborted = () => reject(new LinuxSafetyError(/^[A-Z][A-Z0-9_]{2,79}$/u.test(signal?.reason?.code ?? "") ? signal.reason.code : "P1C_ABORTED"));
    signal?.addEventListener("abort", aborted, { once: true }); if (signal?.aborted) aborted();
  });
  try { return await Promise.race([Promise.resolve().then(work), stop]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", aborted); }
}

// comm can contain spaces and parentheses. Fields after the LAST ')' start at field 3.
export function parseLinuxStat(text) {
  const match = /^(\d+) \((.*)\) ([A-Z]) (.*)$/su.exec(text.trim());
  linuxAssert(match, "LINUX_PROC_STAT_INVALID");
  const fields = match[4].trim().split(/\s+/u);
  linuxAssert(fields.length >= 19 && /^\d+$/u.test(fields[0]) && /^\d+$/u.test(fields[18]), "LINUX_PROC_STAT_INVALID");
  return { pid: Number(match[1]), state: match[3], parent: Number(fields[0]), startTicks: fields[18] };
}

export async function readLinuxProcess(pid, io = { readFile, readlink, open }) {
  linuxAssert(Number.isSafeInteger(pid) && pid > 0, "LINUX_PROCESS_IDENTITY");
  const root = `/proc/${pid}`, before = parseLinuxStat(await io.readFile(root + "/stat", "utf8"));
  linuxAssert(before.pid === pid && !["Z", "X"].includes(before.state), "LINUX_ZOMBIE_OR_EXIT_RACE");
  const [executable, pidns, netns, mntns, cgroup, boot, command] = await Promise.all([
    io.readlink(root + "/exe"), io.readlink(root + "/ns/pid"), io.readlink(root + "/ns/net"), io.readlink(root + "/ns/mnt"),
    io.readFile(root + "/cgroup", "utf8"), io.readFile("/proc/sys/kernel/random/boot_id", "utf8"), io.readFile(root + "/cmdline"),
  ]);
  linuxAssert(executable.startsWith("/") && !executable.endsWith(" (deleted)") && uuid(boot.trim()), "LINUX_EXECUTABLE_UNVERIFIABLE");
  const file = await io.open(root + "/exe", "r"); let executableSha256;
  try {
    const info = await file.stat(); linuxAssert(info.isFile() && info.size > 0 && info.size <= 150 * 1024 ** 2, "LINUX_EXECUTABLE_UNVERIFIABLE");
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let position = 0;
    while (position < info.size) { const { bytesRead } = await file.read(buffer, 0, buffer.length, position); linuxAssert(bytesRead > 0, "LINUX_EXECUTABLE_UNVERIFIABLE"); digest.update(buffer.subarray(0, bytesRead)); position += bytesRead; }
    executableSha256 = digest.digest("hex");
  } finally { await file.close(); }
  const after = parseLinuxStat(await io.readFile(root + "/stat", "utf8"));
  linuxAssert(before.startTicks === after.startTicks && before.parent === after.parent && !["Z", "X"].includes(after.state)
    && await io.readlink(root + "/exe") === executable, "LINUX_PROCESS_INSTANCE_CHANGED");
  return { ...after, executable, executableSha256, commandSha256: sha(command), pidns, netns, mntns, cgroupSha256: sha(cgroup), bootId: boot.trim() };
}

function rejectLinuxProcess(row, code, failedPredicate, phase) {
  const error = new LinuxSafetyError(code);
  error.observation = { processId: Number.isSafeInteger(row?.pid) ? row.pid : null, parentProcessId: Number.isSafeInteger(row?.parent) ? row.parent : null,
    startTicks: /^\d+$/u.test(row?.startTicks ?? "") ? row.startTicks : null, executableCategory: "UNVERIFIED_OR_UNAUTHORIZED",
    executableSha256: /^[a-f0-9]{64}$/u.test(row?.executableSha256 ?? "") ? row.executableSha256 : null,
    observationPhase: phase, failedPredicate, rejectionReasonCode: code, clockDomain: "LINUX_BOOT_START_TICKS" };
  throw error;
}
export function reconcileLinuxProcesses(rows, { init, supervisor, consumer = null, helpers = new Map(), helper, phase = "OBSERVATION" }) {
  linuxAssert(Array.isArray(rows) && rows.length >= 2 && rows.length <= 16 && new Set(rows.map(r => r.pid)).size === rows.length, "LINUX_PROCESS_CENSUS_INVALID");
  const same = (a, b) => ["pid", "startTicks", "executable", "executableSha256", "commandSha256", "pidns", "netns", "mntns", "bootId", "cgroupSha256"].every(k => a?.[k] && a[k] === b?.[k]);
  for (const expected of [init, supervisor, consumer].filter(Boolean)) if (!rows.some(row => same(row, expected))) rejectLinuxProcess(rows.find(row => row.pid === expected.pid) ?? expected, "LINUX_PROCESS_IDENTITY_MISMATCH", "PROCESS_INSTANCE_IDENTITY_MISMATCH", phase);
  for (const row of rows) {
    if (!(row.pidns === supervisor.pidns && row.netns === supervisor.netns && row.mntns === supervisor.mntns && row.bootId === supervisor.bootId
      && !["Z", "X"].includes(row.state))) rejectLinuxProcess(row, "LINUX_NAMESPACE_OR_STATE_MISMATCH", "NAMESPACE_OR_PROCESS_STATE_MISMATCH", phase);
    if (same(row, init)) { if (row.pid !== 1) rejectLinuxProcess(row, "LINUX_INIT_IDENTITY", "PROCESS_INSTANCE_IDENTITY_MISMATCH", phase); continue; }
    if (same(row, supervisor)) { if (row.parent !== init.pid) rejectLinuxProcess(row, "LINUX_SUPERVISOR_PARENT", "PARENT_INSTANCE_MISMATCH", phase); continue; }
    if (consumer && same(row, consumer)) { if (row.parent !== supervisor.pid) rejectLinuxProcess(row, "LINUX_CONSUMER_PARENT", "PARENT_INSTANCE_MISMATCH", phase); continue; }
    if (!consumer) rejectLinuxProcess(row, "P1C_UNKNOWN_DESCENDANT", "HELPER_WITHOUT_LIVE_OWNER", phase);
    if (row.executable !== helper.path || row.executableSha256 !== helper.sha256) rejectLinuxProcess(row, "P1C_UNKNOWN_DESCENDANT", "DESCENDANT_EXECUTABLE_NOT_ALLOWED", phase);
    if (row.parent !== consumer.pid) rejectLinuxProcess(row, "P1C_UNKNOWN_DESCENDANT", "PARENT_INSTANCE_MISMATCH", phase);
    if (row.commandSha256 !== helper.commandSha256) rejectLinuxProcess(row, "P1C_UNKNOWN_DESCENDANT", "DESCENDANT_ARGUMENTS_NOT_ALLOWED", phase);
    const old = helpers.get(row.pid); if (old && !same(row, old)) rejectLinuxProcess(row, "LINUX_PID_REUSE", "HELPER_PROCESS_INSTANCE_CHANGED", phase); helpers.set(row.pid, row);
  }
  return { status: "PASS_VERIFIED", count: rows.length, helpers: [...helpers.values()] };
}

export function reconcileLinuxDrain(rows, { init, supervisor, consumer, helpers }) {
  const roots = rows.filter(row => row.pid === init.pid || row.pid === supervisor.pid);
  reconcileLinuxProcesses(roots, { init, supervisor, helpers: new Map(), helper: {} });
  for (const row of rows.filter(value => !roots.includes(value))) {
    const known = helpers.get(row.pid);
    linuxAssert(known && ["startTicks", "executable", "executableSha256", "commandSha256", "pidns", "netns", "mntns", "bootId", "cgroupSha256"].every(key => known[key] && known[key] === row[key])
      && [consumer.pid, 1].includes(row.parent) && !["Z", "X"].includes(row.state), "LINUX_UNKNOWN_DRAIN_PROCESS");
  }
  return { complete: rows.length === 2 };
}

export function createLinuxLineReader(onPacket, failure) {
  let buffer = "", count = 0, failed = false;
  return {
    push(bytes) {
      if (failed) return;
      try {
        buffer += bytes.toString("utf8"); linuxAssert(Buffer.byteLength(buffer) <= 65536, "LINUX_CHANNEL_LIMIT");
        let end; while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          linuxAssert(line.length > 0 && ++count <= 8192, "LINUX_CHANNEL_LIMIT"); onPacket(JSON.parse(line));
        }
      } catch (error) { failed = true; failure(error instanceof LinuxSafetyError ? error : new LinuxSafetyError("LINUX_CHANNEL_INVALID")); }
    },
    end() { if (buffer.length) failure(new LinuxSafetyError("LINUX_CHANNEL_TRUNCATED")); },
  };
}

export async function runLinuxSupervisor(profile, adapters = {}) {
  const { validateWorkerData } = await import("./m13-p1-worker-runtime.mjs");
  linuxAssert(adapters.synthetic === true || process.platform === "linux" && process.arch === "x64" && process.versions.node === "24.14.1", "LINUX_RUNTIME_NOT_QUALIFIED");
  const env = adapters.environment ?? process.env, input = adapters.input ?? process.stdin, output = adapters.output ?? process.stdout;
  for (const name of Object.keys(env)) linuxAssert(!/^(DATABASE_URL|PGPASSWORD|NODE_OPTIONS|NODE_PATH|RENDER.*|DOTENV_CONFIG_.*)$/u.test(name), "LINUX_CONTAINER_ENVIRONMENT_REJECTED");
  const context = { runId: env.P1C_RUN_ID, generation: env.P1C_GENERATION, slot: env.P1C_SLOT, attempt: env.P1C_ATTEMPT };
  const now = adapters.now ?? (() => performance.now()), authority = createLinuxAuthority({ ...context, now, durationMs: 600_000 });
  const processReader = adapters.readProcess ?? readLinuxProcess;
  const init = await processReader(1), supervisor = await processReader(adapters.pid ?? process.pid);
  let networkObservation = adapters.networkObservation, dnsProof, dnsObservation;
  const supervisorArgs = [profile.node.path, "/app/scripts/m13-p1-worker-linux-entry.mjs"];
  linuxAssert(init.executable === profile.init.path && init.executableSha256 === profile.init.sha256 && init.commandSha256 === sha(Buffer.from([profile.init.path, "--", ...supervisorArgs].join("\0") + "\0"))
    && supervisor.executable === profile.node.path && supervisor.executableSha256 === profile.node.sha256 && supervisor.parent === 1
    && supervisor.commandSha256 === sha(Buffer.from(supervisorArgs.join("\0") + "\0")), "LINUX_ROOT_IDENTITY_MISMATCH");
  if (!adapters.synthetic) {
    const [status, memory, swap, route, route6, resolver, mounts] = await Promise.all([readFile("/proc/self/status", "utf8"), readFile("/sys/fs/cgroup/memory.max", "utf8"),
      readFile("/sys/fs/cgroup/memory.swap.max", "utf8"), readFile("/proc/net/route", "utf8"), readFile("/proc/net/ipv6_route", "utf8"), readFile("/etc/resolv.conf", "utf8"), readFile("/proc/mounts", "utf8")]);
    linuxAssert(/^Uid:\s+10001\s+10001\s+10001\s+10001$/mu.test(status) && /^Gid:\s+10001\s+10001\s+10001\s+10001$/mu.test(status)
      && /^CapEff:\s+0+$/mu.test(status) && /^NoNewPrivs:\s+1$/mu.test(status) && /^Seccomp:\s+2$/mu.test(status), "LINUX_EFFECTIVE_SECURITY_MISMATCH");
    linuxAssert(Number(memory.trim()) === 512 * 1024 ** 2 && swap.trim() === "0", "LINUX_EFFECTIVE_MEMORY_MISMATCH");
    linuxAssert((await readFile("/proc/sys/net/ipv6/conf/all/disable_ipv6", "utf8")).trim() === "1"
      && (await readFile("/proc/sys/net/ipv4/ip_forward", "utf8")).trim() === "0", "LINUX_EGRESS_NOT_ISOLATED");
    networkObservation = { route, route6, resolvers: resolver.split("\n").filter(line => /^nameserver\s/u.test(line)).map(line => line.trim().split(/\s+/u)[1]),
      addresses: Object.values(networkInterfaces()).flat().filter(value => value?.family === "IPv4" && !value.internal).map(value => value.address),
      bootId: supervisor.bootId, pidNamespace: supervisor.pidns, netNamespace: supervisor.netns };
    linuxAssert(mounts.split("\n").some(line => { const fields = line.split(" "); return fields[1] === "/" && fields[3].split(",").includes("ro"); }), "LINUX_ROOT_NOT_READONLY");
    const temporary = mounts.split("\n").find(line => line.split(" ")[1] === "/run/p1c")?.split(" "), temporaryInfo = await lstat("/run/p1c");
    const options = temporary?.[3].split(",") ?? [], size = options.find(value => value.startsWith("size="))?.match(/^size=(\d+)([kKmM]?)$/u);
    linuxAssert(temporary?.[2] === "tmpfs" && ["noexec", "nosuid"].every(value => options.includes(value)) && size
      && Number(size[1]) * ({ "": 1, k: 1024, m: 1024 ** 2 }[size[2].toLowerCase()]) === 64 * 1024 ** 2
      && temporaryInfo.uid === 10001 && temporaryInfo.gid === 10001, "LINUX_EFFECTIVE_TMPFS_MISMATCH");
    for (const [path, expected] of Object.entries(profile.osFiles)) linuxAssert(sha(await readFile(path)) === expected, "LINUX_OS_IDENTITY_CHANGED");
  }
  let sequence = 0, received = 0, child, consumer, nonce, lastChildSeq = 0, childSequence = 0, bindingSent = false, dormantJoined = false, primary, stopped = false, released = false, closed = false, exitObserved = false, crashArmed = false, receiptBarrier = false, databaseClosed = false, censusTimer, livenessTimer;
  const helpers = new Map(), owned = new Set(), errors = [];
  const send = (type, data = {}) => {
    const packet = { v: 1, ...context, seq: ++sequence, type, data };
    linuxAssert(Buffer.byteLength(JSON.stringify(packet)) <= 65536, "LINUX_CHANNEL_LIMIT");
    output.write(JSON.stringify(packet) + "\n");
  };
  const fence = () => authority.fence();
  const localStop = () => {
    fence();
    if (stopped) return;
    stopped = true;
    if (child?.connected && !closed) child.send({ v: 1, runId: context.runId, generation: context.generation, slot: context.slot, nonce, seq: ++lastChildSeq, type: "STOP", data: {} });
  };
  const fail = error => {
    const code = error instanceof LinuxSafetyError ? error.code : "LINUX_SUPERVISOR_FAILED";
    primary ??= code; errors.push(code); localStop();
    try { send("FAILURE", { code, ...(error.observation ? { observation: error.observation } : {}) }); } catch { /* Preserve the first failure when the transport is lost. */ }
  };
  const census = async (joined = false) => {
    const names = await (adapters.readdir ?? readdir)("/proc");
    const pids = names.filter(name => /^[1-9][0-9]*$/u.test(name)).map(Number);
    linuxAssert(pids.length <= 16, "P1C_UNKNOWN_DESCENDANT");
    const rows = (await Promise.all(pids.map(async pid => {
      try { return await processReader(pid); }
      catch (error) { if (joined && helpers.has(pid) && error.code === "ENOENT") return null; throw error; }
    }))).filter(Boolean);
    if (joined && consumer) reconcileLinuxDrain(rows, { init, supervisor, consumer, helpers });
    else reconcileLinuxProcesses(rows, { init, supervisor, consumer, helpers, helper: profile.helper, phase: consumer ? "LIVE" : "STARTUP" });
    return rows;
  };
  let linuxTarget;
  const joined = new Promise(resolveJoin => {
    const track = handle => {
      child = handle; owned.add(handle);
      // Tracking precedes IPC setup and every subsequent fallible registration.
      child.once("exit", (code, signal) => { exitObserved = true; child.observedExit = { code, signal }; });
      child.once("close", () => {
        closed = true;
        void (async () => {
          linuxAssert(exitObserved && (crashArmed ? child.observedExit.code === 86 : stopped && databaseClosed && child.observedExit.code === 0), "LINUX_CHILD_EXIT_UNEXPECTED");
          const rows = await linuxBounded(async () => {
            const deadline = now() + 5000; let rows;
            do { rows = await census(true); if (rows.length === 2) return rows; linuxAssert(now() < deadline, "LINUX_HELPER_RECONCILIATION_FAILED"); await new Promise(done => setTimeout(done, 25)); } while (true);
          }, 5000, "LINUX_JOIN_CENSUS_TIMEOUT");
          send("CHILD_JOINED", { pid: child.pid, exitCode: child.observedExit.code, exitObserved: true, closeObserved: true, databaseClosed, helperAbsence: true, rows }); resolveJoin();
        })().catch(error => { fail(error); resolveJoin(); });
      });
      child.on("error", () => fail(new LinuxSafetyError("LINUX_CHILD_SPAWN_FAILED")));
      child.on("message", packet => {
        try {
          if (linuxExact(packet, ["type"]) && packet.type === "LINUX_BINDING_REQUEST") {
            linuxAssert(linuxTarget && !stopped && !bindingSent, "LINUX_PRIVATE_BINDING_INVALID"); bindingSent = true;
            child.send({ type: "LINUX_BINDING", target: linuxTarget, supervisor }); return;
          }
          linuxAssert(linuxExact(packet, ["v", "runId", "generation", "slot", "nonce", "seq", "type", "data"]) && packet.v === 1
            && packet.runId === context.runId && packet.generation === context.generation && packet.slot === context.slot && packet.nonce === nonce && packet.seq === ++childSequence
            && ["HELLO", "READY", "FIXTURE_DONE", "CONFIGURED", "REQUEST", "STOPPED", "EVENT", "ERROR"].includes(packet.type) && validateWorkerData(packet.type, packet.data), "LINUX_CHILD_CORRELATION");
          if (packet.type === "REQUEST" && packet.data?.point === "receipt") receiptBarrier = true;
          if (packet.type === "STOPPED") databaseClosed = packet.data?.databaseClosed === true;
          send("CHILD_PACKET", packet);
        } catch (error) { fail(error); }
      });
      for (const pipe of [child.stdout, child.stderr]) pipe.on("data", () => fail(new LinuxSafetyError("LINUX_UNEXPECTED_CHILD_OUTPUT")));
    };
    let handling = Promise.resolve();
    const handle = async packet => {
      linuxAssert(linuxExact(packet, ["v", "runId", "generation", "slot", "attempt", "seq", "type", "data"])
        && packet.v === 1 && Object.entries(context).every(([key, value]) => packet[key] === value) && packet.seq === received + 1, "LINUX_CONTROL_PACKET_INVALID");
      received++; clearTimeout(livenessTimer);
      livenessTimer = setTimeout(() => fail(new LinuxSafetyError("LINUX_CONTROLLER_LOST")), 15000);
      if (["STOP", "STATUS", "RELEASE"].includes(packet.type)) linuxAssert(linuxExact(packet.data, []), "LINUX_CONTROL_PACKET_INVALID");
      if (packet.type === "IDENTIFY") {
        authority.assert(); linuxAssert(received === 1 && linuxExact(packet.data, ["dnsProof"]), "LINUX_DUPLICATE_IDENTIFY");
        dnsProof = packet.data.dnsProof; dnsObservation = assertLinuxDnsIsolation(networkObservation, dnsProof, { ...context, pidNamespace: supervisor.pidns, netNamespace: supervisor.netns });
        send("IDENTIFIED", { init, supervisor, rows: await census(), profileSha256: sha(JSON.stringify(profile)), dnsObservation }); return;
      }
      if (packet.type === "STOP") { localStop(); if (!child) { authority.settle(); if (!dormantJoined) { dormantJoined = true; send("DORMANT_JOINED"); } } return; }
      if (packet.type === "STATUS") { if (closed) await linuxBounded(() => joined, 5000, "LINUX_JOIN_CENSUS_TIMEOUT"); send("SNAPSHOT", { rows: await census(closed) }); return; }
      if (packet.type === "RELEASE") { linuxAssert((closed || !child) && stopped && !primary && (await census(true)).length === 2, "LINUX_RELEASE_BEFORE_JOIN"); authority.settle(); released = true; send("RELEASED"); input.pause(); resolveJoin(); return; }
      if (packet.type === "PACKET" && packet.data?.type === "STOP") {
        linuxAssert(child?.connected && linuxExact(packet.data, ["v", "runId", "generation", "slot", "nonce", "seq", "type", "data"]) && packet.data.v === 1
          && packet.data.runId === context.runId && packet.data.generation === context.generation && packet.data.slot === context.slot && linuxExact(packet.data.data, [])
          && packet.data.nonce === nonce && packet.data.seq === lastChildSeq + 1, "LINUX_CHILD_PACKET_INVALID");
        localStop(); return;
      }
      authority.assert();
      if (packet.type === "START") {
        const data = packet.data;
        linuxAssert(linuxExact(data, ["nonce", "environment", "target"]) && uuid(data.nonce) && linuxExact(data.environment, ["DATABASE_URL", "APP_ENV", "NODE_ENV", "PGAPPNAME"])
          && data.environment.APP_ENV === "development" && data.environment.NODE_ENV === "test", "LINUX_START_TARGET_INVALID");
        assertLinuxTargetShape(data.target, context);
        linuxAssert(dnsProof && data.target.containerId === dnsProof.containerId && data.target.networkId === dnsProof.networkId
          && data.target.identity.clientAddress.replace(/\/32$/u, "") === dnsObservation.clientAddress, "LINUX_DATABASE_NAMESPACE_MISMATCH");
        const databaseUrl = new URL(data.environment.DATABASE_URL);
        linuxAssert(databaseUrl.protocol === "postgresql:" && databaseUrl.hostname === data.target.serverAddress && databaseUrl.port === "5432"
          && databaseUrl.pathname === "/" + data.target.database && databaseUrl.username === data.target.role && databaseUrl.password && !databaseUrl.search && !databaseUrl.hash
          && data.environment.PGAPPNAME === "m13-p1c-" + context.runId.replaceAll("-", "").slice(0, 12) + "-" + context.slot, "LINUX_DATABASE_TARGET_INVALID");
        nonce = data.nonce;
        await (adapters.mkdir ?? mkdir)("/run/p1c/consumer", { recursive: true }); authority.assert();
        for (const [path, expected] of Object.entries(profile.files)) { linuxAssert(sha(await readFile(path)) === expected, "LINUX_SOURCE_CHANGED"); authority.assert(); }
        await census(); authority.assert();
        linuxTarget = data.target;
        const childEnvironment = { ...data.environment, P1C_RUN_ID: context.runId, P1C_GENERATION: context.generation, P1C_SLOT: context.slot, P1C_NONCE: nonce,
          TSX_TSCONFIG_PATH: "/app/tsconfig.json", TMPDIR: "/run/p1c" };
        linuxAssert(!Object.keys(childEnvironment).some(key => /^(NODE_OPTIONS|NODE_PATH|RENDER.*|DOTENV_CONFIG_.*)$/u.test(key)), "LINUX_CHILD_ENVIRONMENT_REJECTED");
        authority.spawnOnce(() => (adapters.spawn ?? spawn)(profile.node.path, ["--conditions=react-server", "--import", "/app/node_modules/tsx/dist/loader.mjs", "/app/scripts/m13-p1-worker-consumer.ts"],
          { cwd: "/run/p1c/consumer", env: childEnvironment, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe", "ipc"] }), track);
        linuxAssert(Number.isInteger(child.pid) && owned.has(child), "P1C_LATE_PROCESS_REGISTRATION");
        consumer = await processReader(child.pid);
        const consumerArgs = [profile.node.path, "--conditions=react-server", "--import", "/app/node_modules/tsx/dist/loader.mjs", "/app/scripts/m13-p1-worker-consumer.ts"];
        linuxAssert(consumer.executableSha256 === profile.node.sha256 && consumer.parent === supervisor.pid && consumer.commandSha256 === sha(Buffer.from(consumerArgs.join("\0") + "\0")), "LINUX_CHILD_IDENTITY_MISMATCH");
        send("CHILD_REGISTERED", { consumer });
        censusTimer = setInterval(() => { void linuxBounded(() => census(closed), 5000, "LINUX_CENSUS_TIMEOUT").catch(fail); }, 1000);
        return;
      }
      linuxAssert(packet.type === "PACKET" && child?.connected && !closed, "LINUX_CONTROL_STATE");
      const value = packet.data;
      linuxAssert(linuxExact(value, ["v", "runId", "generation", "slot", "nonce", "seq", "type", "data"]) && value.v === 1 && value.nonce === nonce && value.runId === context.runId
        && value.generation === context.generation && value.slot === context.slot && value.seq === lastChildSeq + 1
        && ["INIT", "START", "FIXTURE", "CONFIGURE", "REPLY", "INTERRUPT"].includes(value.type) && validateWorkerData(value.type, value.data), "LINUX_CHILD_PACKET_INVALID");
      if (value.type === "INTERRUPT") { linuxAssert(context.slot === "A" && receiptBarrier, "LINUX_CRASH_NOT_ARMED"); crashArmed = true; }
      if (value.type === "STOP") { stopped = true; fence(); }
      lastChildSeq = value.seq; child.send(value);
    };
    const reader = createLinuxLineReader(packet => {
      // STOP must revoke local authority immediately, even while START awaits fs.
      if (packet?.runId === context.runId && packet.generation === context.generation && packet.attempt === context.attempt && packet.slot === context.slot
        && (packet.type === "STOP" || packet.type === "PACKET" && packet.data?.type === "STOP")) fence();
      if (!child && packet?.type === "STOP" && packet.v === 1 && packet.runId === context.runId && packet.generation === context.generation && packet.attempt === context.attempt
        && packet.slot === context.slot && packet.seq === received + 1 && linuxExact(packet.data, []) && linuxExact(packet, ["v", "runId", "generation", "slot", "attempt", "seq", "type", "data"])) {
        localStop(); if (!dormantJoined) { dormantJoined = true; send("DORMANT_JOINED"); }
      }
      handling = handling.then(() => linuxBounded(() => handle(packet), 15000, "LINUX_CONTROL_TIMEOUT")).catch(error => {
        if (error?.code === "P1C_ABORTED" && authority.closing && !child && stopped) return;
        fail(error);
      });
    }, fail);
    input.on("data", bytes => reader.push(bytes)); input.on("end", () => { reader.end(); if (!released) fail(new LinuxSafetyError("LINUX_CONTROLLER_LOST")); });
    input.on("error", () => fail(new LinuxSafetyError("LINUX_CHANNEL_FAILED")));
  });
  const interrupted = () => fail(new LinuxSafetyError("LINUX_SUPERVISOR_SIGNAL"));
  process.on("SIGTERM", interrupted); process.on("SIGINT", interrupted);
  let quarantined = false;
  try {
    await linuxBounded(async () => { while (!released && !primary) await new Promise(done => setTimeout(done, 20)); }, 600_000, "LINUX_ROLE_DEADLINE");
  } catch (error) { fail(error); }
  finally {
    clearInterval(censusTimer); clearTimeout(livenessTimer); localStop();
    if (child && !closed) { try { await linuxBounded(() => joined, 5000, "LINUX_CHILD_JOIN_FAILED"); } catch (error) { errors.push(error.code); primary ??= error.code; } }
    try { const rows = await linuxBounded(() => census(closed || !child), 5000, "LINUX_FINAL_CENSUS_TIMEOUT"); linuxAssert(rows.length === 2 && (!child || closed), "LINUX_FINAL_PROCESS_RECONCILIATION_FAILED"); }
    catch (error) { primary ??= error.code ?? "LINUX_FINAL_PROCESS_RECONCILIATION_FAILED"; errors.push(error.code ?? "LINUX_FINAL_PROCESS_RECONCILIATION_FAILED"); quarantined = true; }
    if (!quarantined) { process.off("SIGTERM", interrupted); process.off("SIGINT", interrupted); }
    else if (adapters.synthetic && adapters.onQuarantine) { process.off("SIGTERM", interrupted); process.off("SIGINT", interrupted); adapters.onQuarantine(); }
    else {
      // Returning a bounded FAILURE is not permission to kill an unknown member:
      // exiting PID 1's child would implicitly kill the entire PID namespace.
      // Retain a fenced, inert supervisor as an explicit residual resource.
      // The controller never waits indefinitely for it or calls docker stop.
      setInterval(() => {}, 60000);
    }
  }
  return { exitCode: primary ? 2 : 0, primary, errors, quarantined };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void (async () => {
    const profile = JSON.parse(await readFile("/app/p1c-artifact.json", "utf8"));
    const result = await runLinuxSupervisor(profile); process.exitCode = result.exitCode;
  })().catch(() => {
    process.exitCode = 2;
    // Initialization did not establish a safe namespace census. Preserve the
    // resource for reconciliation rather than implicitly killing unknown PIDs.
    process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); setInterval(() => {}, 60000);
  });
}
