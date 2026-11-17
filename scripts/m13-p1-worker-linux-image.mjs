import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { get as httpsGet } from "node:https";
import { spawn } from "node:child_process";
import { lstat, readFile, writeFile, mkdir, mkdtemp, cp, readdir, realpath, statfs } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { performance } from "node:perf_hooks";
import { gunzipSync } from "node:zlib";
import { linuxAssert, linuxExact, LinuxSafetyError, linuxBounded, readLinuxProcess, parseLinuxStat } from "./m13-p1-worker-linux-entry.mjs";

export const LINUX_NODE_ARCHIVE_SHA256 = "84d38715d449447117d05c3e71acd78daa49d5b1bfa8aacf610303920c3322be";
export const LINUX_PROFILE = Object.freeze({ admissionMiB: 3840, hardLimitsMiB: 2816, reserveMiB: 1024, workerMemory: 512 * 1024 ** 2, workerTmpfs: 64 * 1024 ** 2 });
const digest = data => createHash("sha256").update(data).digest("hex");
const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const image = value => typeof value === "string" && /^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/u.test(value);
const qualifiedLinuxImages = new WeakSet(), qualifiedLinuxEngines = new WeakSet();
export const isQualifiedLinuxImage = value => qualifiedLinuxImages.has(value);
export const isQualifiedLinuxEngine = value => qualifiedLinuxEngines.has(value);
const toolProcesses = new Set(), artifactTransfers = new Set();
export function linuxToolQuiescence() {
  return { verified: [...toolProcesses].every(row => row.joined && row.treeVerified && !row.failure) && [...artifactTransfers].every(row => row.joined && !row.failure),
    artifactTransfers: [...artifactTransfers].map(row => ({ joined: row.joined, failure: row.failure })),
    processes: [...toolProcesses].map(row => ({ pid: row.pid, executableSha256: row.executableSha256, birth: row.birth, joined: row.joined, treeVerified: row.treeVerified, failure: row.failure, failureObservation: row.failureObservation ?? null })) };
}
export function handoffLinuxRuntime({ node, args, environment, quiescence = linuxToolQuiescence(), execute = process.execve }) {
  linuxAssert(quiescence.verified === true && typeof execute === "function" && isAbsolute(node) && Array.isArray(args)
    && args[0] === fileURLToPath(import.meta.url) && args[1] === "--qualified-job" && Object.values(environment).every(value => typeof value === "string"), "LINUX_RUNTIME_HANDOFF_NOT_SAFE");
  // This is PREPARATION ONLY: no PostgreSQL, worker or application authority
  // exists. POSIX execve replaces the bootstrap; it is not a second controller.
  execute(node, [node, ...args], environment);
  throw new LinuxSafetyError("LINUX_RUNTIME_HANDOFF_RETURNED");
}

async function observeToolTree(child, row, closed, stopObserving, profiles = []) {
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
      const valid = profiles.some(helper => observed.executable === helper.path && observed.executableSha256 === helper.sha256 && observed.commandSha256 === helper.commandSha256)
        && observed.pidns === root.pidns && observed.netns === root.netns && observed.bootId === root.bootId && !["Z", "X"].includes(observed.state)
        && (!old ? !closed() && observed.parent === root.pid : old.startTicks === observed.startTicks && [root.pid, 1].includes(observed.parent));
      if (!valid) row.failureObservation ??= { processId: observed.pid, parentProcessId: observed.parent, startTicks: observed.startTicks, executableSha256: observed.executableSha256,
        failedPredicate: "TOOL_DESCENDANT_IDENTITY_OR_PARENT_NOT_ALLOWED", rejectionReasonCode: "LINUX_UNKNOWN_TOOL_DESCENDANT" };
      linuxAssert(valid, "LINUX_UNKNOWN_TOOL_DESCENDANT");
      helpers.set(observed.pid, observed);
    }
    if (closed()) {
      const residual = [...helpers.values()].some(known => stats.some(current => current.pid === known.pid && current.startTicks === known.startTicks));
      if (!residual) { row.treeVerified = true; return; }
      drainStarted ??= performance.now(); linuxAssert(performance.now() - drainStarted < 5000, "LINUX_TOOL_HELPER_JOIN_FAILED");
    }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new LinuxSafetyError("LINUX_TOOL_JOIN_FAILED");
}
export function assertLinuxArtifactPlan(value, bytes, approvalSha256) {
  linuxAssert(hex(approvalSha256) && digest(bytes) === approvalSha256, "LINUX_ARTIFACT_APPROVAL_MISSING");
  linuxAssert(JSON.stringify(value) === JSON.stringify(JSON.parse(bytes)), "LINUX_ARTIFACT_PLAN_INVALID");
  linuxAssert(linuxExact(value, ["v", "platform", "nodeVersion", "nodeArchiveSha256", "nodeSha256", "sourceFreeze", "baseReference", "baseConfig", "init", "tools", "osFiles", "workerSeccomp", "prisma", "diskAdmissionMiB"])
    && value.v === 1 && value.platform === "linux/amd64" && value.nodeVersion === "24.14.1" && value.nodeArchiveSha256 === LINUX_NODE_ARCHIVE_SHA256
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
  return value;
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
  const check = async () => {
    const current = await inspectSocket(socket);
    linuxAssert(current.isSocket() && current.dev === original.dev && current.ino === original.ino && current.uid === original.uid, "LINUX_ENGINE_SOCKET_CHANGED");
  };
  const call = async (method, path, body, { timeoutMs = 15000, signal, binary = false, headers = {}, beforeDispatch = () => {} } = {}) => {
    linuxAssert(["GET", "POST", "PUT", "DELETE"].includes(method) && path.startsWith("/") && !path.includes("\n"), "LINUX_ENGINE_REQUEST_INVALID");
    await check();
    const row = { method, state: "NOT_DISPATCHED" }; requests.add(row);
    const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return new Promise((done, reject) => {
      let finished = false, response, bytes = 0; const chunks = [];
      const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); if (error) reject(error); else done(value); };
      beforeDispatch();
      const req = request({ socketPath: socket, path: "/v1.47" + path, method, headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}), ...headers } });
      row.state = "ACTIVE";
      const abort = () => { req.destroy(); response?.destroy(); finish(new LinuxSafetyError(signal?.aborted ? "P1C_ABORTED" : "LINUX_ENGINE_TIMEOUT")); };
      row.abort = abort;
      const timer = setTimeout(abort, Math.max(1, Math.min(timeoutMs, 30000)));
      signal?.addEventListener("abort", abort, { once: true });
      req.once("close", () => { row.state = "JOINED"; });
      req.once("error", () => finish(new LinuxSafetyError("LINUX_ENGINE_REQUEST_FAILED")));
      req.once("response", res => {
        response = res;
        res.on("data", chunk => { bytes += chunk.length; if (bytes > 4 * 1024 ** 2) { res.destroy(); finish(new LinuxSafetyError("LINUX_ENGINE_OUTPUT_LIMIT")); } else chunks.push(chunk); });
        res.once("error", () => finish(new LinuxSafetyError("LINUX_ENGINE_RESPONSE_FAILED")));
        res.once("end", () => {
          try {
            linuxAssert(res.statusCode >= 200 && res.statusCode < 300, "LINUX_ENGINE_HTTP_" + res.statusCode);
            const data = Buffer.concat(chunks); finish(null, binary ? data : data.length ? JSON.parse(data) : null);
          } catch (error) { finish(error instanceof LinuxSafetyError ? error : new LinuxSafetyError("LINUX_ENGINE_RESPONSE_INVALID")); }
        });
      });
      if (signal?.aborted) abort(); else req.end(payload);
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
    async watch(runId, receive, failure) {
      linuxAssert(/^[a-f0-9-]{36}$/u.test(runId), "LINUX_EVENT_CONTEXT_INVALID"); await check();
      return new Promise((done, reject) => {
        const filters = encodeURIComponent(JSON.stringify({ label: ["piccadilly.run=" + runId] }));
        let released = false, stream, buffer = "", count = 0;
        const row = { method: "EVENTS", state: "ACTIVE" }; requests.add(row);
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
    async attach(id, receive, failure) {
      linuxAssert(hex(id), "LINUX_CONTAINER_IDENTITY"); await check();
      return new Promise((done, reject) => {
        const req = request({ socketPath: socket, method: "POST", path: `/v1.47/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1`, headers: { Connection: "Upgrade", Upgrade: "tcp" } });
        let socketHandle, released = false; const row = { method: "ATTACH", state: "ACTIVE" }; requests.add(row);
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
export async function downloadLinuxArtifact(url, maximum, { request = httpsGet, timeoutMs = 60000 } = {}) {
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
        settled = true; transfer.joined = true; clearTimeout(timer); clearTimeout(joinTimer);
        if (transfer.failure) reject(new LinuxSafetyError(transfer.failure));
        else if (ended) done(value); else { transfer.failure = "LINUX_DOWNLOAD_TRUNCATED"; reject(new LinuxSafetyError(transfer.failure)); }
      };
      const fail = code => {
        transfer.failure ??= code; req?.destroy(); response?.destroy();
        joinTimer ??= setTimeout(() => { if (!settled) { settled = true; clearTimeout(timer); reject(new LinuxSafetyError(transfer.failure)); } }, 5000);
        finish();
      };
      const timer = setTimeout(() => fail("LINUX_DOWNLOAD_TIMEOUT"), Math.max(1, deadline - performance.now()));
      try {
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
        req.setTimeout(Math.min(15000, timeoutMs), () => fail("LINUX_DOWNLOAD_TIMEOUT"));
      } catch { requestClosed = true; fail("LINUX_DOWNLOAD_FAILED"); }
    });
    if (result.data) return result.data; current = new URL(result.location, current);
  }
  throw new LinuxSafetyError("LINUX_DOWNLOAD_REDIRECT_LIMIT");
}
const download = downloadLinuxArtifact;

export async function runLinuxTool(executable, args, { cwd, environment, timeoutMs = 60000, expectedSha256, beforeSpawn = () => {}, signal, allowedHelpers = [] } = {}) {
  linuxAssert(isAbsolute(executable) && hex(expectedSha256) && digest(await readFile(executable)) === expectedSha256, "LINUX_TOOL_NOT_QUALIFIED");
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
    beforeSpawn(); linuxAssert(!signal?.aborted, "P1C_ABORTED");
    const child = spawn(executable, args, { cwd, env: environment, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0, primary, timer, closed = false, stopObserving = false;
    const row = { pid: child.pid, executableSha256: expectedSha256, birth: null, joined: false, treeVerified: false, failure: null }; toolProcesses.add(row);
    const stopOwned = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
    const aborted = () => { primary ??= new LinuxSafetyError("P1C_ABORTED"); stopOwned(); };
    signal?.addEventListener("abort", aborted, { once: true });
    const collect = data => { bytes += data.length; if (bytes > 4 * 1024 ** 2) { primary ??= new LinuxSafetyError("LINUX_TOOL_OUTPUT_LIMIT"); stopOwned(); } };
    for (const pipe of [child.stdout, child.stderr]) pipe.on("data", collect);
    child.once("error", () => { primary ??= new LinuxSafetyError("LINUX_TOOL_SPAWN_FAILED"); });
    const observation = observeToolTree(child, row, () => closed, () => stopObserving, profiles).catch(error => {
      primary ??= error instanceof LinuxSafetyError ? error : new LinuxSafetyError("LINUX_TOOL_TREE_NOT_VERIFIED"); row.failure = primary.code; stopOwned();
    });
    timer = setTimeout(() => { primary ??= new LinuxSafetyError("LINUX_TOOL_TIMEOUT"); stopOwned(); }, timeoutMs);
    const joined = setTimeout(() => { stopObserving = true; row.failure = primary?.code ?? "LINUX_TOOL_JOIN_FAILED"; reject(primary ?? new LinuxSafetyError("LINUX_TOOL_JOIN_FAILED")); }, timeoutMs + 5000);
    child.once("close", code => {
      closed = true; row.joined = true; clearTimeout(timer); clearTimeout(joined); signal?.removeEventListener("abort", aborted);
      void linuxBounded(() => observation, 5000, "LINUX_TOOL_HELPER_JOIN_FAILED").then(() => {
        row.failure = primary?.code ?? (code !== 0 ? "LINUX_TOOL_FAILED" : null);
        if (primary || code !== 0 || !row.treeVerified) reject(primary ?? new LinuxSafetyError(code !== 0 ? "LINUX_TOOL_FAILED" : "LINUX_TOOL_TREE_NOT_VERIFIED")); else done({ exitCode: code, joined: true });
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

export async function prepareLinuxImage({ root, evidenceDirectory, manifestPath, approvalSha256, sourceNames }) {
  linuxAssert(process.platform === "linux" && process.arch === "x64", "LINUX_CONTROLLER_PLATFORM");
  const bytes = await readFile(manifestPath); linuxAssert(bytes.length <= 512 * 1024, "LINUX_ARTIFACT_PLAN_INVALID");
  const plan = assertLinuxArtifactPlan(JSON.parse(bytes), bytes, approvalSha256);
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
  const artifactResources = async () => {
    const [containers, networks, volumes] = await Promise.all([engine.call("GET", "/containers/json?all=1"), engine.call("GET", "/networks"), engine.call("GET", "/volumes")]);
    return { containers: containers.map(value => value.Id).sort(), networks: networks.map(value => value.Id).sort(), volumes: (volumes.Volumes ?? []).map(value => value.Name).sort() };
  };
  const resourcesBeforeBuild = await artifactResources();
  const dockerHome = await mkdtemp(join(tmpdir(), "p1c-docker-config-")), dockerEnvironment = { PATH: "/usr/bin:/bin", HOME: dockerHome, DOCKER_CONFIG: dockerHome, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_BUILDKIT: "0" };
  await runLinuxTool("/usr/bin/docker", ["build", "--network=none", "--pull=false", "--tag", tag, context], {
    expectedSha256: plan.tools.docker, environment: dockerEnvironment, timeoutMs: 600000 });
  const built = await engine.call("GET", "/images/" + encodeURIComponent(tag) + "/json");
  const resourcesAfterBuild = await artifactResources();
  linuxAssert(JSON.stringify(resourcesAfterBuild) === JSON.stringify(resourcesBeforeBuild), "LINUX_ARTIFACT_RESIDUAL_RESOURCES");
  linuxAssert(/^sha256:[a-f0-9]{64}$/u.test(built.Id) && built.Os === "linux" && built.Architecture === "amd64" && built.Config.User === "10001:10001"
    && !built.Config.Cmd?.length && !built.Config.Healthcheck && !Object.keys(built.Config.Volumes ?? {}).length && !Object.keys(built.Config.ExposedPorts ?? {}).length
    && JSON.stringify(built.Config.Entrypoint) === JSON.stringify([nodePath, "/app/scripts/m13-p1-worker-linux-entry.mjs"]), "LINUX_IMAGE_ATTESTATION_FAILED");
  const archivePath = join(evidenceDirectory, "linux-worker-image.tar");
  linuxAssert(!await lstat(archivePath).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), "LINUX_IMAGE_ARCHIVE_COLLISION");
  await runLinuxTool("/usr/bin/docker", ["save", "--output", archivePath, built.Id], { expectedSha256: plan.tools.docker, environment: dockerEnvironment, timeoutMs: 60000 });
  const archiveInfo = await lstat(archivePath); linuxAssert(archiveInfo.isFile() && !archiveInfo.isSymbolicLink() && archiveInfo.size <= plan.diskAdmissionMiB * 1024 ** 2, "LINUX_IMAGE_ARCHIVE_BUDGET");
  const archiveHash = createHash("sha256"); for await (const block of createReadStream(archivePath, { highWaterMark: 65536 })) archiveHash.update(block);
  const schemaEnginePath = join(root, "node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x");
  linuxAssert(digest(await readFile(schemaEnginePath)) === plan.prisma.binarySha256, "LINUX_PRISMA_EXECUTABLE_CHANGED");
  const hostPrisma = { schemaEnginePath, sha256: plan.prisma.binarySha256, helpers: await prismaHelpers(plan, "migrate", root, process.execPath, join(root, "prisma.config.ts")) };
  const result = { kind: "BUILT_LOCAL_ATTESTED", sourceFreeze: source.freeze, artifactAttempt, localTag: tag, artifactResourceAbsence: "PASS_VERIFIED_NO_ADDED_CONTAINER_NETWORK_VOLUME",
    imageId: built.Id, diffIds: built.RootFS.Layers, profile, hostPrisma, imageArchiveSha256: archiveHash.digest("hex"), imageArchiveBytes: archiveInfo.size,
    specificationSha256: digest(specification), approvalSha256, runtimeNodeSha256: plan.nodeSha256, diskAdmissionMiB: plan.diskAdmissionMiB };
  await writeFile(join(evidenceDirectory, "linux-image.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  await measureLinuxPreparation(engine, evidenceDirectory, "after-build", { root, evidence: evidenceDirectory, buildContext: context }, { buildContext: context, dependencies: rootModules, imageArchive: archivePath });
  qualifiedLinuxImages.add(result); return result;
}

async function bootstrapLinuxJob(manifestPath, approvalSha256, sourceListPath, evidenceDirectory) {
  linuxAssert(process.platform === "linux" && process.arch === "x64" && process.env.GITHUB_REPOSITORY === "TommyGiacopini/piccadilly-booking"
    && process.env.GITHUB_EVENT_NAME === "workflow_dispatch", "LINUX_WORKFLOW_CONTEXT_REJECTED");
  const root = fileURLToPath(new URL("../", import.meta.url)), bytes = await readFile(manifestPath), plan = assertLinuxArtifactPlan(JSON.parse(bytes), bytes, approvalSha256);
  const sourceNames = (await readFile(sourceListPath, "utf8")).split("\0").filter(Boolean);
  linuxAssert((await linuxSourceInventory(root, sourceNames)).freeze === plan.sourceFreeze, "LINUX_SOURCE_CHANGED");
  linuxAssert(!(await readdir(root)).some(name => name === ".npmrc" || name.startsWith(".env") && name !== ".env.example"), "LINUX_LOCAL_CONFIGURATION_REJECTED");
  const disk = await statfs(root), memory = await readFile("/proc/meminfo", "utf8");
  linuxAssert(disk.bavail * disk.bsize / 1024 ** 2 >= plan.diskAdmissionMiB
    && Number(/^MemAvailable:\s+(\d+) kB$/mu.exec(memory)?.[1]) / 1024 >= LINUX_PROFILE.admissionMiB, "LINUX_RESOURCE_ADMISSION_FAILED");
  await mkdir(evidenceDirectory, { recursive: true });
  const engine = await createLinuxEngine();
  await measureLinuxPreparation(engine, evidenceDirectory, "before-dependencies", { root, evidence: evidenceDirectory });
  const distribution = await mkdtemp(join(tmpdir(), "p1c-node-"));
  const archive = await download("https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-x64.tar.xz", 60 * 1024 ** 2);
  linuxAssert(digest(archive) === LINUX_NODE_ARCHIVE_SHA256, "LINUX_NODE_ARCHIVE_MISMATCH");
  const archivePath = join(distribution, "node.tar.xz"); await writeFile(archivePath, archive, { flag: "wx" });
  await runLinuxTool("/usr/bin/tar", ["-xJf", archivePath, "--directory", distribution], { expectedSha256: plan.tools.tar, environment: { PATH: "/usr/bin:/bin" } });
  const runtime = join(distribution, "node-v24.14.1-linux-x64"), node = join(runtime, "bin/node");
  linuxAssert(digest(await readFile(node)) === plan.nodeSha256, "LINUX_NODE_UNQUALIFIED");
  const environment = { PATH: join(runtime, "bin") + ":/usr/bin:/bin", HOME: distribution, TMPDIR: tmpdir(),
    NPM_CONFIG_USERCONFIG: join(distribution, "empty-user.npmrc"), NPM_CONFIG_GLOBALCONFIG: join(distribution, "empty-global.npmrc"),
    NPM_CONFIG_CACHE: join(distribution, "npm-cache"), NEXT_TELEMETRY_DISABLED: "1", GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY, GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME };
  for (const file of [environment.NPM_CONFIG_USERCONFIG, environment.NPM_CONFIG_GLOBALCONFIG]) await writeFile(file, "", { flag: "wx" });
  await runLinuxTool(node, [join(runtime, "lib/node_modules/npm/bin/npm-cli.js"), "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, environment, expectedSha256: plan.nodeSha256, timeoutMs: 600000 });
  const engineVersion = JSON.parse(await readFile(join(root, "node_modules/@prisma/engines-version/package.json"), "utf8")).prisma.enginesVersion;
  linuxAssert(engineVersion === plan.prisma.engineCommit && JSON.parse(await readFile(join(root, "node_modules/prisma/package.json"), "utf8")).version === "7.9.1", "LINUX_PRISMA_VERSION_MISMATCH");
  const compressedEngine = await download(`https://binaries.prisma.sh/all_commits/${engineVersion}/debian-openssl-3.0.x/schema-engine.gz`, 64 * 1024 ** 2);
  linuxAssert(digest(compressedEngine) === plan.prisma.gzipSha256, "LINUX_PRISMA_ARCHIVE_MISMATCH");
  const engineBytes = gunzipSync(compressedEngine, { maxOutputLength: 128 * 1024 ** 2 }); linuxAssert(digest(engineBytes) === plan.prisma.binarySha256
    && engineBytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && engineBytes[4] === 2 && engineBytes[5] === 1 && engineBytes.readUInt16LE(18) === 62, "LINUX_PRISMA_EXECUTABLE_CHANGED");
  const enginePath = join(root, "node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x");
  try { linuxAssert(digest(await readFile(enginePath)) === plan.prisma.binarySha256, "LINUX_PRISMA_EXECUTABLE_CHANGED"); }
  catch (error) { if (error.code !== "ENOENT") throw error; await writeFile(enginePath, engineBytes, { flag: "wx", mode: 0o555 }); }
  environment.PRISMA_SCHEMA_ENGINE_BINARY = enginePath; environment.CHECKPOINT_DISABLE = "1"; environment.PRISMA_HIDE_UPDATE_MESSAGE = "1"; environment.PRISMA_GENERATE_SKIP_AUTOINSTALL = "true";
  // Canonical prisma.config.ts deliberately requires DATABASE_URL. Code
  // generation runs before any database exists: use the SAME frozen schema
  // through a temporary data-only config without a datasource or credentials.
  const generationConfig = join(distribution, "prisma-generate.config.mjs");
  await writeFile(generationConfig, "export default " + JSON.stringify({ schema: join(root, "prisma/schema.prisma") }) + ";\n", { flag: "wx", mode: 0o600 });
  await runLinuxTool(node, [join(root, "node_modules/prisma/build/index.js"), "generate", "--config", generationConfig], { cwd: root, environment, expectedSha256: plan.nodeSha256, timeoutMs: 60000,
    allowedHelpers: await prismaHelpers(plan, "generate", root, node, generationConfig) });
  await measureLinuxPreparation(engine, evidenceDirectory, "after-dependencies", { root, evidence: evidenceDirectory, distribution }, { dependencies: join(root, "node_modules"), distribution });
  // Pulls are confined to this future, authorized preparation lane. No workload
  // or database exists yet. The qualified identities are rechecked before use.
  const references = [plan.baseReference,
    "postgres@sha256:b6a16ed0eb96e2c362811f7eeb951eac8b459e7b40be4149ea5444aa7c65569b",
    "haproxy@sha256:3c2931ee7070f321b0bde9cbf5c27227d72b43f5862b9f028516fbeff4644fbf"];
  const dockerHome = await mkdtemp(join(tmpdir(), "p1c-docker-pull-"));
  for (const reference of references) await runLinuxTool("/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", "pull", "--platform", "linux/amd64", reference], {
    expectedSha256: plan.tools.docker, environment: { PATH: "/usr/bin:/bin", HOME: dockerHome, DOCKER_CONFIG: dockerHome }, timeoutMs: 600000 });
  await measureLinuxPreparation(engine, evidenceDirectory, "after-pulls", { root, evidence: evidenceDirectory, distribution });
  environment.P1C_JOB_STARTED_UPTIME_MS = process.env.P1C_JOB_STARTED_UPTIME_MS;
  const quiescence = linuxToolQuiescence(); linuxAssert(quiescence.verified, "LINUX_PREPARATION_JOIN_NOT_VERIFIED");
  for (let i = 0; i < 20 && !engine.joined(); i++) await new Promise(done => setTimeout(done, 10));
  linuxAssert(engine.joined() && digest(await readFile(node)) === plan.nodeSha256 && (await linuxSourceInventory(root, sourceNames)).freeze === plan.sourceFreeze, "LINUX_RUNTIME_HANDOFF_NOT_SAFE");
  const handoff = { sourceFreeze: plan.sourceFreeze, nodeSha256: plan.nodeSha256, preparationTools: quiescence, engineId: engine.id, applicationResourcesCreated: false,
    controllerPid: process.pid, controllerStartTicks: parseLinuxStat(await readFile("/proc/self/stat", "utf8")).startTicks, bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() };
  await writeFile(join(evidenceDirectory, "preparation-handoff.json"), JSON.stringify(handoff, null, 2) + "\n", { mode: 0o600 });
  handoffLinuxRuntime({ node, args: [fileURLToPath(import.meta.url), "--qualified-job", manifestPath, approvalSha256, sourceListPath, evidenceDirectory], environment, quiescence });
}

async function qualifiedLinuxJob(manifestPath, approvalSha256, sourceListPath, evidenceDirectory) {
  const uptime = Number((await readFile("/proc/uptime", "utf8")).split(" ")[0]) * 1000, started = Number(process.env.P1C_JOB_STARTED_UPTIME_MS);
  // 30-minute job, reserving the existing component caps plus delivery/report
  // margin. This is admission to the job, never an extension of a role budget.
  const requiredRemaining = 600000 + 30000 + 2 * (15000 + 60000 + 15000) + 15000 + 600000 + 70000 + 30000 + 120000;
  linuxAssert(Number.isFinite(started) && started > 0 && 30 * 60000 - (uptime - started) >= requiredRemaining, "LINUX_JOB_TEARDOWN_RESERVE_UNAVAILABLE");
  const approvedBytes = await readFile(manifestPath), approved = assertLinuxArtifactPlan(JSON.parse(approvedBytes), approvedBytes, approvalSha256);
  const handoff = JSON.parse(await readFile(join(evidenceDirectory, "preparation-handoff.json"), "utf8"));
  linuxAssert(process.versions.node === "24.14.1" && digest(await readFile(process.execPath)) === approved.nodeSha256 && handoff.nodeSha256 === approved.nodeSha256
    && handoff.sourceFreeze === approved.sourceFreeze && handoff.preparationTools?.verified === true && handoff.applicationResourcesCreated === false
    && handoff.controllerPid === process.pid && handoff.controllerStartTicks === parseLinuxStat(await readFile("/proc/self/stat", "utf8")).startTicks
    && handoff.bootId === (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(), "LINUX_RUNTIME_HANDOFF_NOT_VERIFIED");
  const root = fileURLToPath(new URL("../", import.meta.url)), sourceNames = (await readFile(sourceListPath, "utf8")).split("\0").filter(Boolean);
  const image = await linuxBounded(() => prepareLinuxImage({ root, sourceNames, manifestPath, approvalSha256, evidenceDirectory }), 600000, "LINUX_IMAGE_PREPARATION_TIMEOUT");
  const { createLinuxQualificationHarness, linuxStorageSnapshot } = await import("./m13-p1-environment.mjs");
  const engine = await createLinuxEngine(), plan = JSON.parse(await readFile(manifestPath, "utf8"));
  linuxAssert(engine.id === handoff.engineId, "LINUX_ENGINE_CHANGED");
  const abort = new AbortController(), interrupted = () => abort.abort(new LinuxSafetyError("LINUX_CONTROLLER_INTERRUPTED"));
  process.on("SIGTERM", interrupted); process.on("SIGINT", interrupted);
  const harness = await createLinuxQualificationHarness({ engine, image, sourceNames, evidenceDirectory, toolHashes: plan.tools, signal: abort.signal });
  let primary, teardown, worker, workerEntered = false;
  try { await harness.create(); await harness.run("migrate"); await harness.run("seed"); workerEntered = true; worker = await harness.run("worker-runtime"); }
  catch (error) { primary = /^[A-Z][A-Z0-9_]{2,79}$/u.test(error?.code ?? "") ? error.code : "LINUX_QUALIFICATION_FAILED"; }
  finally { try { teardown = await harness.close(); } catch { primary ??= "LINUX_TEARDOWN_FAILED"; } process.off("SIGTERM", interrupted); process.off("SIGINT", interrupted); }
  const observationFailures = []; let sourceAfter, storage;
  try { sourceAfter = await linuxSourceInventory(root, sourceNames); linuxAssert(sourceAfter.freeze === image.sourceFreeze, "LINUX_SOURCE_CHANGED"); }
  catch (error) { observationFailures.push(error.code ?? "LINUX_SOURCE_OBSERVATION_FAILED"); primary ??= observationFailures.at(-1); }
  try { storage = await linuxStorageSnapshot(engine, { root, evidence: evidenceDirectory }); await measureLinuxPreparation(engine, evidenceDirectory, "after-teardown", { root, evidence: evidenceDirectory }); }
  catch (error) { observationFailures.push(error.code ?? "LINUX_STORAGE_OBSERVATION_FAILED"); primary ??= observationFailures.at(-1); }
  const scenarios = Object.fromEntries(Array.from({ length: 10 }, (_, index) => ["C" + String(index + 1).padStart(2, "0"), workerEntered ? "NOT_VERIFIABLE" : "NOT_RUN"]));
  let partial = worker?.workerReceipt;
  if (workerEntered && !partial) {
    try {
      const path = join(evidenceDirectory, "worker-runtime.json"), info = await lstat(path);
      linuxAssert(info.isFile() && !info.isSymbolicLink() && info.size <= 4 * 1024 ** 2, "LINUX_PARTIAL_RECEIPT_INVALID");
      const candidate = JSON.parse(await readFile(path, "utf8")), current = harness.receipt();
      linuxAssert(candidate.runId === current.runId && candidate.generation === current.generation, "LINUX_PARTIAL_RECEIPT_INVALID"); partial = candidate;
    } catch { observationFailures.push("LINUX_PARTIAL_RECEIPT_NOT_VERIFIABLE"); }
  }
  for (const key of Object.keys(scenarios)) if (["PASS_VERIFIED", "FAIL", "NOT_RUN", "NOT_VERIFIABLE"].includes(partial?.scenarios?.[key])) scenarios[key] = partial.scenarios[key];
  if (workerEntered) scenarios.C10 = worker && !primary && teardown?.complete && teardown.processesJoined ? "PASS_VERIFIED" : "NOT_VERIFIABLE";
  const result = { status: !primary && teardown?.complete ? "PASS_VERIFIED" : "FAIL", primary, teardown,
    sourceFreeze: sourceAfter?.freeze ?? null, scenarios, observationFailures, storage, tools: linuxToolQuiescence(), receipt: harness.receipt() };
  await writeFile(join(evidenceDirectory, "linux-qualification.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  // Only this aggregate summary goes to the public job log. Evidence stays in
  // RUNNER_TEMP and is never uploaded automatically.
  console.log(JSON.stringify({ status: result.status, primary, processJoin: teardown?.processesJoined ?? false, sqlQuiescence: teardown?.sqlQuiescence ?? "NOT_VERIFIABLE",
    teardown: teardown?.complete ?? false, scenarios: result.scenarios, sourceFreeze: result.sourceFreeze }));
  linuxAssert(result.status === "PASS_VERIFIED", primary ?? "LINUX_TEARDOWN_FAILED");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // Artifact approval/download is separate from workload authorization. This
  // entry point never creates a container or starts a worker.
  void (async () => {
    if (process.argv[2] === "--fetch-approval" && process.argv.length === 6) await fetchLinuxApproval(process.argv[3], process.argv[4], process.argv[5]);
    else if (process.argv[2] === "--prepare-job" && process.argv.length === 7) await bootstrapLinuxJob(...process.argv.slice(3));
    else if (process.argv[2] === "--qualified-job" && process.argv.length === 7) await qualifiedLinuxJob(...process.argv.slice(3));
    else throw new LinuxSafetyError("LINUX_IMAGE_COMMAND_REJECTED");
  })().catch(error => { console.error(JSON.stringify({ code: error instanceof LinuxSafetyError ? error.code : "LINUX_IMAGE_FAILED" })); process.exitCode = 2; });
}
