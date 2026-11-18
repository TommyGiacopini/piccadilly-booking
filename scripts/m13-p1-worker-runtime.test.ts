import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKER_LIMITS, WorkerRunError, createWorkerPeer, assertWorkerIdentity,
  serialWorkerGuard, joinWorker, reconcileWorkerClaims, reconcileWorkerTree, runWorkerRuntime,
  workerProbeInvocation, runWorkerProcessProbe, PROCESS_PROBE_SCRIPT,
  createWorkerShutdown,
  createLinuxWorkerGroup,
} from "./m13-p1-worker-runtime.mjs";
import { runWorkerConsumer, validateConsumerEnvironment } from "./m13-p1-worker-consumer";
import { PLANS, commandDefinitions, assertD6RunnerTarget } from "./m13-p1-environment.mjs";
import { EXPECTED_STAGING_MIGRATION_NAMES } from "./staging-worker-startup.mjs";

const runId = randomUUID(), generation = randomUUID(), nonce = randomUUID();
const correlation = { runId, generation, slot: "A", nonce };
const identity = { database: "piccadilly_e2e_" + "a".repeat(32), role: "m13_p1_" + "a".repeat(16),
  version: "18.4", dataDirectory: "/var/lib/postgresql/18/docker", systemIdentifier: "1234567890",
  postmasterStart: "2026-11-09 10:00:00+00", serverAddress: "172.20.0.2/32",
  clientAddress: "172.20.0.3/32", serverPort: 5432 };
const environment = {
  NODE_ENV: "test" as const,
  APP_ENV: "development", DATABASE_URL: "postgresql://m13_p1_" + "a".repeat(16) + ":SYNTHETIC_ONLY@127.0.0.1:61000/" + identity.database,
  P1C_RUN_ID: runId, P1C_GENERATION: generation, P1C_SLOT: "A", P1C_NONCE: nonce,
  PGAPPNAME: "m13-p1c-" + runId.replaceAll("-", "").slice(0, 12) + "-A",
};
const proof = () => ({ valid: true, status: "PASS_VERIFIED", generation });
const deferred = <T,>() => {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>(resolve => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
};
const startupFs = vi.hoisted(() => ({
  mkdtemp: null as null | ((prefix: string) => Promise<string>),
  lstat: null as null | ((info: unknown) => Promise<unknown>),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (process.env.P1C_TEST_HELPER_FILE && String(args[0]).replaceAll("\\", "/").endsWith("/node_modules/@esbuild/win32-x64/esbuild.exe")) args[0] = process.env.P1C_TEST_HELPER_FILE;
      return actual.readFile(...args);
    },
    mkdtemp: (...args: Parameters<typeof actual.mkdtemp>) => startupFs.mkdtemp ? startupFs.mkdtemp(String(args[0])) : actual.mkdtemp(...args),
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (process.env.P1C_TEST_HELPER_FILE && String(args[0]).replaceAll("\\", "/").endsWith("/node_modules/@esbuild/win32-x64/esbuild.exe")) args[0] = process.env.P1C_TEST_HELPER_FILE;
      const info = await actual.lstat(...args);
      return startupFs.lstat && String(args[0]).endsWith("tsconfig.json") ? startupFs.lstat(info) : info;
    },
  };
});
afterEach(() => { startupFs.mkdtemp = null; startupFs.lstat = null; vi.useRealTimers(); });

describe("ALT07 Linux logical handles and distributed shutdown", () => {
  function linuxFixture(delayed = false, sharedNamespace = false) {
    const rows = (pid: number, parent: number, executable: string) => ({ pid, parent, executable, executableSha256: "a".repeat(64), commandSha256: "b".repeat(64),
      startTicks: String(pid + 100), state: "S", pidns: "pid:[1]", netns: "net:[2]", mntns: "mnt:[3]", bootId: runId, cgroupSha256: "c".repeat(64) });
    const init = rows(1, 0, "/init"), supervisor = rows(2, 1, "/node"), consumer = rows(3, 2, "/node");
    const profile = { init: { path: "/init", sha256: "a".repeat(64) }, node: { path: "/node", sha256: "a".repeat(64) }, helper: {} };
    const image = { profile }, failures: unknown[] = [], writes: string[] = [];
    const workers = ["A", "B"].map((slot, i) => {
      const id = String(i + 1).repeat(64), attempt = randomUUID(), address = "172.20.0." + (i + 4);
      return { id, slot, attempt, address, dnsProof: { runId, generation, slot, attempt, containerId: id, networkId: "f".repeat(64), engineId: "SYNTHETIC_ENGINE", upstream: ["127.0.0.1"],
        subnet: "172.20.0.0/24", bootId: runId, created: "2026-11-17T10:00:00Z", started: "2026-11-17T10:00:01Z", imageId: "sha256:" + "e".repeat(64) },
        target: { identity: { ...identity, clientAddress: address }, serverAddress: "172.20.0.2" } };
    });
    const engine = { attach: async (id: string, receive: (bytes: Buffer) => void) => {
      const worker = workers.find(value => value.id === id)!; let sequence = 0, registered = false, committed = false;
      const ns = sharedNamespace ? "1" : worker.slot === "A" ? "11" : "12";
      const namespace = { pidns: "pid:[" + ns + "]", netns: "net:[" + ns + "]", mntns: "mnt:[" + ns + "]" };
      const slotInit = { ...init, ...namespace }, slotSupervisor = { ...supervisor, ...namespace }, slotConsumer = { ...consumer, ...namespace };
      const send = (type: string, data: unknown = {}) => receive(Buffer.from(JSON.stringify({ v: 1, runId, generation, slot: worker.slot, attempt: worker.attempt, seq: ++sequence, type, data }) + "\n"));
      return { close: async () => {}, write: (raw: unknown) => {
        const packet = raw as { type: string; data: { type?: string } }; writes.push(worker.slot + ":" + packet.type);
        queueMicrotask(() => {
          if (packet.type === "IDENTIFY") send("IDENTIFIED", { init: slotInit, supervisor: slotSupervisor, rows: [slotInit, slotSupervisor], profileSha256: createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
            dnsObservation: { upstream: "127.0.0.1", netNamespace: slotSupervisor.netns, clientAddress: worker.address, proofSha256: createHash("sha256").update(JSON.stringify(worker.dnsProof)).digest("hex") } });
          if (packet.type === "START") { committed = true; if (!delayed) { registered = true; send("CHILD_REGISTERED", { consumer: slotConsumer }); } }
          if (packet.type === "STOP" || packet.type === "PACKET" && packet.data.type === "STOP") {
            if (!registered && committed) { registered = true; send("CHILD_REGISTERED", { consumer: slotConsumer }); }
            if (!committed) send("DORMANT_JOINED");
            else send("CHILD_JOINED", { pid: 3, exitCode: 0, exitObserved: true, closeObserved: true, databaseClosed: true, helperAbsence: true, rows: [slotInit, slotSupervisor] });
          }
          if (packet.type === "STATUS") send("SNAPSHOT", { rows: [slotInit, slotSupervisor] });
          if (packet.type === "RELEASE") send("RELEASED");
        });
      } };
    } };
    const controllerNamespaces = { pidns: "pid:[999]", netns: "net:[999]", mntns: "mnt:[999]", bootId: runId };
    const group = createLinuxWorkerGroup({ engine, workers, image, runId, generation, controllerNamespaces, timeoutMs: 2000, onFailure: (error: unknown) => failures.push(error) });
    return { group, writes, failures };
  }
  it("registers a valid independent child and coordinates duplicate STOP without native calls", async () => {
    const f = linuxFixture();
    try {
      await f.group.ready(); const child = await f.group.launch("A", { nonce, environment: {}, target: {} });
      f.group.assertHandle(child); expect(child.pid).toBe(3);
      f.group.track(child, { graceful: () => child.send({ type: "STOP" }) });
      const stopped = f.group.stopAll(); expect(f.group.stopAll()).toBe(stopped); await stopped;
      expect(f.group.records().every((value: { joined: boolean }) => value.joined)).toBe(true);
      await f.group.release(); expect(f.failures).toEqual([]);
      expect(f.writes.filter(value => value === "A:PACKET")).toHaveLength(1);
      await expect(f.group.launch("B", { nonce, environment: {}, target: {} })).rejects.toMatchObject({ code: "P1C_LATE_PROCESS_REGISTRATION" });
    } finally { f.group.dispose(); }
  });
  it("reconciles an already-committed START arriving during controller closing", async () => {
    const f = linuxFixture(true);
    try {
      await f.group.ready(); const pending = f.group.launch("A", { nonce, environment: {}, target: {} });
      await new Promise(done => setTimeout(done, 0)); const stopped = f.group.stopAll();
      const child = await pending; await stopped; f.group.assertHandle(child);
      expect(child.exitCode).toBe(0); expect(f.group.records()[0].joined).toBe(true); expect(f.failures).toEqual([]);
      await f.group.release();
    } finally { f.group.dispose(); }
  });
  it("rejects two workers reporting a shared PID or network namespace before dispatch", async () => {
    const f = linuxFixture(false, true);
    try { await expect(f.group.ready()).rejects.toMatchObject({ code: "LINUX_WORKER_NAMESPACE_SHARED" }); expect(f.writes.some(value => value.endsWith(":START"))).toBe(false); }
    finally { f.group.dispose(); }
  });
  it("rejects a forged Linux group and an unattested backend target on the real entrypoints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "p1c-alt07-negative-"));
    try {
      await expect(runWorkerRuntime({ requireOwnership: true, ownershipGuard: async () => proof(), onChild: () => {}, environment, generation, runId,
        expectedIdentity: identity, evidenceDirectory: dir, timeoutMs: 1000, signal: new AbortController().signal, linuxGroup: {} })).rejects.toMatchObject({ code: "LINUX_GROUP_CAPABILITY_REQUIRED" });
      expect(() => validateConsumerEnvironment({ ...environment, DATABASE_URL: environment.DATABASE_URL.replace("127.0.0.1", "172.20.0.2") }, { serverAddress: "172.20.0.2", runId, generation, slot: "A" })).toThrow("P1C_DATABASE_TARGET_REJECTED");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("the real runtime owns a valid Linux child before abort and preserves primary abort through join", async () => {
    const f = linuxFixture(), dir = await mkdtemp(join(tmpdir(), "p1c-alt07-orchestrator-")), controller = new AbortController(), registered = vi.fn(() => controller.abort());
    const ended = vi.fn(async () => {});
    const client = () => ({ on: () => {}, connect: async () => {}, end: ended, query: async (text: string) => text.includes("_prisma_migrations")
      ? { rows: EXPECTED_STAGING_MIGRATION_NAMES.map(migration_name => ({ migration_name, finished_at: new Date(), rolled_back_at: null, logs: null })), rowCount: 16 }
      : text.startsWith("SELECT") ? { rows: [{ outbox: 0, attempts: 0, receipts: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 } });
    try {
      await f.group.ready();
      await expect(runWorkerRuntime({ requireOwnership: true, ownershipGuard: async () => proof(), onChild: registered, environment, generation, runId,
        expectedIdentity: identity, evidenceDirectory: dir, timeoutMs: 2000, signal: controller.signal, linuxGroup: f.group }, { client })).rejects.toMatchObject({ code: "P1C_ABORTED" });
      const receipt = JSON.parse(await readFile(join(dir, "worker-runtime.json"), "utf8"));
      expect(registered).toHaveBeenCalledTimes(1); expect(ended).toHaveBeenCalledTimes(1);
      expect(receipt.primaryFailure).toBe("P1C_ABORTED"); expect(receipt.processes[0].joined).toBe(true);
      expect(f.writes.filter(value => value.endsWith(":START"))).toEqual(["A:START"]);
    } finally { f.group.dispose(); await rm(dir, { recursive: true, force: true }); }
  });
});

describe("P1-C D6 START01 real orchestrator startup fencing", () => {
  function startupFixture(directory: string, now?: () => number) {
    const controller = new AbortController(), children: Array<ReturnType<typeof d5Child>> = [], events: Array<Record<string, unknown>> = [];
    const parent = vi.fn(), ended = vi.fn(async () => {}), stopped = deferred<void>(), messages: string[] = [];
    let stop!: (control?: unknown) => Promise<unknown>;
    const client = () => ({ on: () => {}, connect: async () => {}, end: ended,
      query: async (text: string) => text.includes("_prisma_migrations")
        ? { rows: EXPECTED_STAGING_MIGRATION_NAMES.map(migration_name => ({ migration_name, finished_at: new Date(), rolled_back_at: null, logs: null })), rowCount: 16 }
        : text.startsWith("SELECT") ? { rows: [{ outbox: 0, attempts: 0, receipts: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 } });
    const spawnFake = vi.fn((_exe: string, _args: string[], options: { env: Record<string, string> }) => {
      const f = d5Child(800 + children.length); children.push(f);
      const peer = createWorkerPeer({ runId, generation, slot: options.env.P1C_SLOT, nonce: options.env.P1C_NONCE },
        (p: unknown) => queueMicrotask(() => f.child.emit("message", p)));
      Object.assign(f.child, { connected: true, stdout: new PassThrough(), stderr: new PassThrough(),
        send(p: unknown, callback: () => void) {
          const packet = peer.receive(p); messages.push(packet.type); callback();
          if (packet.type === "STOP") {
            peer.send("EVENT", { event: "abort-observed" }); peer.send("STOPPED", { exitCode: 0, databaseClosed: true, aborted: true });
            queueMicrotask(() => { f.close(); stopped.resolve(); });
          }
        } });
      // A post-shutdown spawn in D5 deliberately stays an observable in-memory orphan.
      return f.child;
    });
    const run = () => runWorkerRuntime({ requireOwnership: true, ownershipGuard: async () => proof(), environment, generation, runId,
      expectedIdentity: identity, evidenceDirectory: directory, timeoutMs: 2000, signal: controller.signal,
      onChild: parent, record: (value: Record<string, unknown>) => events.push(value), onShutdownReady: (value: typeof stop) => { stop = value; },
    }, { client, spawn: spawnFake, snapshot: async () => [], ...(now ? { now } : {}) });
    return { controller, children, events, parent, ended, stopped, messages, spawnFake, run, shutdown: () => stop() };
  }

  it("START01 abort while mkdtemp is pending, with empty shutdown already settled, prevents every late spawn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m13-p1c-d6-start01-")), entered = deferred<void>(), release = deferred<string>();
    const f = startupFixture(directory);
    startupFs.mkdtemp = async prefix => { expect(prefix).toContain("consumer-A-"); entered.resolve(); return release.promise; };
    const pending = f.run(), result = pending.catch(error => error);
    try {
      await entered.promise; expect(f.spawnFake).not.toHaveBeenCalled();
      f.controller.abort(); await expect(f.shutdown()).resolves.toMatchObject({ joined: true, processes: 0 });
      expect(f.events.some(v => v.event === "group-joined")).toBe(true);
      release.resolve(directory); const error = await result;
      const receipt = JSON.parse(await readFile(join(directory, "worker-runtime.json"), "utf8"));
      const evidence = { case: "START01_SETTLED_BEFORE_MKDTEMP_RELEASE", primary: error.code,
        emptyShutdownSettled: true, lateSpawns: f.spawnFake.mock.calls.length, parentRegistrations: f.parent.mock.calls.length,
        stopCalls: f.children.reduce((n, c) => n + c.child.kill.mock.calls.length, 0),
        activeUnjoinedChildren: receipt.processes.filter((p: { joined: boolean }) => !p.joined).length, nativeCalls: 0 };
      console.log("D6_START01_EVIDENCE", JSON.stringify(evidence));
      expect(error).toMatchObject({ code: "P1C_ABORTED" }); expect(f.spawnFake.mock.calls.length).toBe(0);
      expect(f.children).toHaveLength(0); expect(f.parent).not.toHaveBeenCalled(); expect(receipt.processes).toEqual([]);
      expect(f.ended).toHaveBeenCalled(); expect(JSON.stringify(receipt)).not.toContain("SYNTHETIC_ONLY");
    } finally { release.resolve(directory); startupFs.mkdtemp = null; await result; await rm(directory, { recursive: true, force: true }); }
  });

  it("R02 settled shutdown without an abort signal still forbids a new child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m13-p1c-d6-closed-")), entered = deferred<void>(), release = deferred<string>();
    const f = startupFixture(directory); startupFs.mkdtemp = async () => { entered.resolve(); return release.promise; };
    const pending = f.run(), result = pending.catch(error => error);
    try {
      await entered.promise; await expect(f.shutdown()).resolves.toMatchObject({ joined: true, processes: 0 });
      expect(f.controller.signal.aborted).toBe(false); release.resolve(directory);
      expect(await result).toMatchObject({ code: "P1C_DISPATCH_AFTER_SHUTDOWN" });
      expect(f.spawnFake.mock.calls.length).toBe(0); expect(f.parent.mock.calls.length).toBe(0);
    } finally { release.resolve(directory); startupFs.mkdtemp = null; await result; await rm(directory, { recursive: true, force: true }); }
  });

  it("R01 abort during the last artifact wait is rechecked before dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m13-p1c-d6-artifact-")), entered = deferred<void>(), release = deferred<void>();
    const f = startupFixture(directory); let calls = 0;
    startupFs.lstat = async info => { if (++calls === 2) { entered.resolve(); await release.promise; } return info; };
    const pending = f.run(), result = pending.catch(error => error);
    try {
      await entered.promise; expect(f.spawnFake.mock.calls.length).toBe(0);
      f.controller.abort(); await expect(f.shutdown()).resolves.toMatchObject({ joined: true, processes: 0 }); release.resolve();
      expect(await result).toMatchObject({ code: "P1C_ABORTED" });
      expect(f.spawnFake.mock.calls.length).toBe(0); expect(f.parent.mock.calls.length).toBe(0);
      expect(calls).toBe(2);
    } finally { release.resolve(); startupFs.lstat = null; await result; await rm(directory, { recursive: true, force: true }); }
  });

  it("R03 an expired role deadline after the final await forbids spawn without resetting the cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m13-p1c-d6-deadline-")), entered = deferred<void>(), release = deferred<void>();
    let clock = 0, calls = 0; const f = startupFixture(directory, () => clock);
    startupFs.lstat = async info => { if (++calls === 2) { entered.resolve(); await release.promise; } return info; };
    const pending = f.run(), result = pending.catch(error => error);
    try {
      await entered.promise; clock = 2001; release.resolve();
      expect(await result).toMatchObject({ code: "P1C_ROLE_TIMEOUT" });
      expect(f.spawnFake.mock.calls.length).toBe(0); expect(f.parent.mock.calls.length).toBe(0);
      const receipt = JSON.parse(await readFile(join(directory, "worker-runtime.json"), "utf8"));
      expect(receipt.processes).toEqual([]); expect(receipt.primaryFailure).toBe("P1C_ROLE_TIMEOUT");
    } finally { release.resolve(); startupFs.lstat = null; await result; await rm(directory, { recursive: true, force: true }); }
  });

  it("R04/R05 valid startup registers its handle before abort or a parent-registration failure, then joins it", async () => {
    for (const mode of ["abort", "registration-error"]) {
      const directory = await mkdtemp(join(tmpdir(), "m13-p1c-d6-owned-")), f = startupFixture(directory);
      const primary = new WorkerRunError("P1C_PARENT_REGISTRATION_FAILED");
      f.parent.mockImplementation(() => { if (mode === "abort") f.controller.abort(); else throw primary; });
      try {
        const result = f.run().catch(error => error), error = await result;
        if (mode === "abort") expect(error).toMatchObject({ code: "P1C_ABORTED" }); else expect(error).toBe(primary);
        expect(f.spawnFake.mock.calls.length).toBe(1); expect(f.parent.mock.calls.length).toBe(1);
        expect(f.messages).toEqual(["STOP"]); expect(f.children[0].child.kill.mock.calls.length).toBe(0);
        const receipt = JSON.parse(await readFile(join(directory, "worker-runtime.json"), "utf8"));
        expect(receipt.processes).toHaveLength(1); expect(receipt.processes[0]).toMatchObject({ pid: 800, joined: true, stopped: true, aborted: true });
        expect(receipt.shutdownFailure).toBe("P1C_TREE_NEVER_QUALIFIED");
        expect(receipt.processQuiescence).not.toBe("PASS_VERIFIED"); expect(f.ended).toHaveBeenCalled();
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });

  it("R06 primary abort survives a separately recorded database-client cleanup failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m13-p1c-d6-primary-")), entered = deferred<void>(), release = deferred<string>();
    const f = startupFixture(directory), marker = "SYNTHETIC_D6_CLEANUP_SECRET_NOT_FOR_OUTPUT";
    startupFs.mkdtemp = async () => { entered.resolve(); return release.promise; };
    const pending = f.run(), result = pending.catch(error => error);
    try {
      await entered.promise; f.controller.abort(); await f.shutdown();
      f.ended.mockRejectedValueOnce(new Error(marker)); release.resolve(directory);
      const error = await result, receipt = JSON.parse(await readFile(join(directory, "worker-runtime.json"), "utf8"));
      expect(error).toMatchObject({ code: "P1C_ABORTED" });
      expect(receipt.primaryFailure).toBe("P1C_ABORTED"); expect(receipt.sqlJoinFailure).toBe("P1C_SQL_JOIN_UNKNOWN");
      expect(f.spawnFake.mock.calls.length).toBe(0); expect(f.parent.mock.calls.length).toBe(0);
      expect(JSON.stringify(receipt)).not.toContain(marker); expect(String(error)).not.toContain(marker);
    } finally { release.resolve(directory); startupFs.mkdtemp = null; await result; await rm(directory, { recursive: true, force: true }); }
  });
});

describe("P1-C closed protocol and fresh authority", () => {
  it("allows exactly the versioned worker role and closed phases on the original target", () => {
    expect(PLANS.worker).toEqual(["ci", "generate", "validate", "migrate", "worker-runtime"]);
    expect(commandDefinitions({ npmCli: "npm" })["worker-runtime"]).toEqual(["scripts/m13-p1-worker-consumer.ts"]);
    const lease = { url: environment.DATABASE_URL };
    expect(() => assertD6RunnerTarget(lease, { phase: "worker:start:A", environment })).not.toThrow();
    for (const context of [
      { phase: "worker:arbitrary", environment },
      { phase: "worker:start:A", environment: { DATABASE_URL: environment.DATABASE_URL + "?changed=1" } },
      { phase: "worker:start:A", environment, plan: {} },
    ]) expect(() => assertD6RunnerTarget(lease, context)).toThrow();
    expect(WORKER_LIMITS).toMatchObject({ role: 600000, guard: 15000, lease: 120000, stop: 10000, join: 5000 });
  });

  it("binds sequenced packets to run generation slot and nonce", () => {
    const packets: unknown[] = [], sender = createWorkerPeer(correlation, (p: unknown) => packets.push(p));
    const receiver = createWorkerPeer(correlation, () => undefined);
    sender.send("HELLO", { pid: 123, node: "24.14.1", execPath: "C:/qualified/node.exe" });
    sender.send("REQUEST", { id: 1, point: "batch" });
    expect(receiver.receive(packets[0]).type).toBe("HELLO");
    expect(receiver.receive(packets[1]).data.id).toBe(1);
    expect(() => receiver.receive(packets[1])).toThrow("P1C_PACKET_REJECTED");
  });

  it("rejects wrong authority unknown data and sensitive sentinel without echo", () => {
    const packets: Record<string, unknown>[] = [];
    createWorkerPeer(correlation, (p: Record<string, unknown>) => packets.push(p)).send("REQUEST", { id: 1, point: "claim" });
    const sentinel = "SYNTHETIC_PRIVATE_SENTINEL_DO_NOT_EXPORT";
    for (const altered of [
      { ...packets[0], nonce: randomUUID() }, { ...packets[0], generation: randomUUID() },
      { ...packets[0], slot: "B" }, { ...packets[0], seq: 0 },
      { ...packets[0], data: { id: 1, point: "arbitrary", value: sentinel } },
      { ...packets[0], secret: sentinel },
    ]) {
      try { createWorkerPeer(correlation, () => undefined).receive(altered); throw new Error("unexpected-pass"); }
      catch (error) { expect(error).toBeInstanceOf(WorkerRunError); expect(String(error)).not.toContain(sentinel); }
    }
  });

  it("rechecks identity and accepts only the same valid IPv4 host representation", () => {
    expect(() => assertWorkerIdentity(identity, { ...identity, serverAddress: "172.20.0.2" })).not.toThrow();
    for (const change of [
      { systemIdentifier: "999" }, { role: "wrong" }, { database: "persistent" },
      { serverAddress: "172.20.0.4" }, { serverAddress: "172.20.0.2/24" },
      { clientAddress: "::1" }, { postmasterStart: "restarted" }, { serverPort: 9999 },
    ]) expect(() => assertWorkerIdentity(identity, { ...identity, ...change })).toThrow("P1C_IDENTITY_MISMATCH");
    expect(() => assertWorkerIdentity(identity, { ...identity, unexpected: true })).toThrow();
  });

  it("serializes two fresh guards rather than sharing a prior positive proof", async () => {
    const first = deferred<void>(), entered: string[] = [];
    const owner = vi.fn(async ({ phase }: { phase: string }) => { entered.push(phase); if (entered.length === 1) await first.promise; return proof(); });
    const guard = serialWorkerGuard({ ownershipGuard: owner, environment, generation, signal: new AbortController().signal });
    const a = guard("worker:start:A"), b = guard("worker:start:B");
    await Promise.resolve(); expect(entered).toEqual(["worker:start:A"]); first.resolve();
    await Promise.all([a, b]); await guard.drain();
    expect(entered).toEqual(["worker:start:A", "worker:start:B"]); expect(owner).toHaveBeenCalledTimes(2);
  });

  it("queue time consumes the guard deadline and prevents expired dispatch", async () => {
    let clock = 0; const first = deferred<void>(), controller = new AbortController();
    const owner = vi.fn(async () => { await first.promise; return proof(); });
    const guard = serialWorkerGuard({ ownershipGuard: owner, environment, generation, signal: controller.signal,
      now: () => clock, onAbort: (error: Error) => controller.abort(error) });
    const a = guard("worker:start:A"), b = guard("worker:start:B");
    const results = Promise.allSettled([a, b]); await Promise.resolve(); clock = 15001; first.resolve();
    expect((await results).every(r => r.status === "rejected")).toBe(true);
    await guard.drain(); expect(owner).toHaveBeenCalledTimes(1); expect(controller.signal.aborted).toBe(true);
  });

  it("propagates abort during an active guard and joins cooperative work", async () => {
    const controller = new AbortController(), active = deferred<void>();
    const owner = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
      active.resolve(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const guard = serialWorkerGuard({ ownershipGuard: owner, environment, generation, signal: controller.signal });
    const promise = guard("worker:batch:A"); const failure = expect(promise).rejects.toThrow("PRIMARY_TIMEOUT");
    await active.promise; controller.abort(new Error("PRIMARY_TIMEOUT")); await failure; await guard.drain();
    await expect(guard("worker:batch:B")).rejects.toThrow(); expect(owner).toHaveBeenCalledTimes(1);
  });

  it("a non-cooperative guard cannot settle as PASS and its unjoined state stays explicit", async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const guard = serialWorkerGuard({ ownershipGuard: () => new Promise(() => {}), environment, generation,
      signal: controller.signal, onAbort: (error: Error) => controller.abort(error) });
    const promise = guard("worker:batch:A"), rejected = expect(promise).rejects.toThrow("P1C_GUARD_TIMEOUT");
    await vi.advanceTimersByTimeAsync(15000); await rejected;
    const drain = guard.drain(), failed = expect(drain).rejects.toThrow("P1C_GUARD_JOIN_UNKNOWN");
    await vi.advanceTimersByTimeAsync(5000); await failed;
  });

  it("rejects stale or non-positive proofs and preserves the primary error", async () => {
    const primary = new WorkerRunError("P1C_PRIMARY_FAILURE");
    for (const answer of [null, { ...proof(), valid: false }, { ...proof(), generation: randomUUID() }, { ...proof(), status: "PASS_REPORTED_ONLY" }]) {
      const guard = serialWorkerGuard({ ownershipGuard: async () => answer, environment, generation, signal: new AbortController().signal });
      await expect(guard("worker:fixture")).rejects.toThrow("P1C_OWNERSHIP_NOT_VERIFIED");
    }
    const onAbort = vi.fn(), guard = serialWorkerGuard({ ownershipGuard: async () => { throw primary; }, environment, generation, signal: new AbortController().signal, onAbort });
    await expect(guard("worker:fixture")).rejects.toBe(primary); expect(onAbort).toHaveBeenCalledWith(primary);
  });
});

function d5Child(pid: number, cooperative = true) {
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn(() => { if (cooperative) queueMicrotask(close); return true; }) });
  function close() { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); }
  return { child, close };
}
function d5Control(milliseconds = 1000) {
  const controller = new AbortController(), deadline = performance.now() + milliseconds;
  return { controller, signal: controller.signal, effectiveTimeout: () => Math.max(0, deadline - performance.now()),
    beforeSpawn() { if (controller.signal.aborted) throw controller.signal.reason; if (performance.now() >= deadline) throw new WorkerRunError("P1C_SHUTDOWN_TIMEOUT"); } };
}

describe("P1-C D5 identity evidence without authorization changes", () => {
  const helper = resolve("node_modules/@esbuild/win32-x64/esbuild.exe").toLowerCase();
  const birth = "2026-11-09T10:00:00Z";
  const rows = () => [{ pid: 100, parent: process.pid, birth, path: process.execPath }, { pid: 101, parent: 100, birth, path: helper }];
  it("IDENTITY_VALID_OWNED_CHILD and DESCENDANT correlate the snapshot, registration and predicate", () => {
    const observations: Array<Record<string, unknown>> = [], root = { pid: 100, parentPid: process.pid, joined: false };
    const snapshotId = randomUUID(), tracked = reconcileWorkerTree([root], rows(), new Map(), new Set([helper]), {
      runId, generation, phase: "STARTUP", snapshotId, startedMs: 10, endedMs: 12, helperDigest: "a".repeat(64),
      record: (value: Record<string, unknown>) => observations.push(value),
    });
    expect([...tracked.keys()]).toEqual([100, 101]);
    expect(observations.map(v => v.status)).toEqual(["KNOWN_OWNED_PROCESS", "KNOWN_OWNED_DESCENDANT"]);
    expect(observations[1]).toMatchObject({ runCorrelationId: runId, generation, observationPhase: "STARTUP", snapshotId,
      process: { pid: 101, parentPid: 100, creationTime: "2026-11-09T10:00:00.000Z", executable: { category: "FIXED_ALLOWED_HELPER" } },
      expected: { pid: 100 }, expectedHelperArtifactSha256: "a".repeat(64), failedPredicate: null });
    expect(JSON.stringify(observations)).not.toContain(helper);
  });

  it("IDENTITY_UNKNOWN/MISSING/REUSED/PARENT_MISMATCH record the precise failed predicate without content", () => {
    const marker = "SYNTHETIC_PROCESS_PATH_OR_BIRTH_DO_NOT_EXPORT";
    const cases = [
      { change: { birth: "" }, predicate: "DESCENDANT_CREATION_TIME_MISSING" },
      { change: { path: null }, predicate: "DESCENDANT_EXECUTABLE_UNAVAILABLE" },
      { change: { path: "C:/" + marker + ".exe" }, predicate: "DESCENDANT_EXECUTABLE_NOT_ALLOWED" },
      { change: { birth: marker }, predicate: "DESCENDANT_CREATION_TIME_UNPARSABLE" },
      { change: { birth: "2000-01-01T00:00:00Z" }, predicate: "DESCENDANT_PREDATES_PARENT" },
    ];
    for (const { change, predicate } of cases) {
      const observations: unknown[] = [], input = rows(); Object.assign(input[1], change);
      let failure;
      try { reconcileWorkerTree([{ pid: 100, joined: false }], input, new Map(), new Set([helper]), { phase: "STARTUP", record: (v: unknown) => observations.push(v) }); }
      catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: "P1C_UNKNOWN_DESCENDANT", processObservation: { status: "REJECTED", failedPredicate: predicate, process: { pid: 101, parentPid: 100 } } });
      expect(JSON.stringify({ failure, observations })).not.toContain(marker);
    }
    const root = { pid: 100, parentPid: process.pid, joined: false }, tracked = reconcileWorkerTree([root], rows(), new Map(), new Set([helper]));
    expect(() => reconcileWorkerTree([root], [{ ...rows()[0], parent: process.pid + 1 }, rows()[1]], tracked, new Set([helper])))
      .toThrow("P1C_PROCESS_IDENTITY_MISMATCH");
    try { reconcileWorkerTree([root], [rows()[0], { ...rows()[1], birth: "2026-11-09T10:00:01Z" }], tracked, new Set([helper])); }
    catch (error) { expect(error).toMatchObject({ code: "P1C_PROCESS_REPLACED", processObservation: { failedPredicate: "TRACKED_INSTANCE_CHANGED" } }); return; }
    throw new Error("PID reuse accepted");
  });

  it("IDENTITY_EXIT_BEFORE_SNAPSHOT and PARENT_EXIT do not certify a surviving helper", () => {
    const root = { pid: 100, joined: false }, tracked = reconcileWorkerTree([root], rows(), new Map(), new Set([helper]));
    root.joined = true;
    const events: Array<Record<string, unknown>> = [];
    reconcileWorkerTree([root], [rows()[1]], tracked, new Set([helper]), { phase: "SHUTDOWN", record: (v: Record<string, unknown>) => events.push(v) });
    expect(events.some(v => v.status === "ALREADY_EXITED_PROCESS")).toBe(true);
    expect([...tracked.values()].filter(p => [rows()[1]].some(r => r.pid === p.pid))).toHaveLength(1);
    const late = { ...rows()[1], pid: 102 };
    expect(() => reconcileWorkerTree([root], [late], tracked, new Set([helper]))).toThrow("P1C_UNKNOWN_DESCENDANT");
    const absent: unknown[] = [];
    reconcileWorkerTree([root], [], tracked, new Set([helper]), { record: (v: unknown) => absent.push(v) });
    expect(absent).toHaveLength(3);
  });

  it("IDENTITY_OBSERVATION_RACE, late control and diagnostic failure stay fail closed", () => {
    const root = { pid: 100, joined: false }, input = rows();
    const unobserved = { pid: 99, parent: process.pid, birth, path: process.execPath };
    const previous = new Map([[99, unobserved]]);
    const late = { ...input[1], parent: 99 };
    let failure;
    try { reconcileWorkerTree([], [late], previous, new Set([helper]), { phase: "SHUTDOWN" }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "P1C_UNKNOWN_DESCENDANT", processObservation: { failedPredicate: "DESCENDANT_PARENT_NOT_OBSERVED" } });
    expect(() => reconcileWorkerTree([root], input, new Map(), new Set([helper]), { control: { beforeSpawn() { throw new WorkerRunError("P1C_ABORTED"); } } })).toThrow("P1C_ABORTED");
    expect(previous.size).toBe(1);
    try { reconcileWorkerTree([root], [input[0], { ...input[1], path: null }], new Map(), new Set([helper]), { record: (v: { status: string }) => { if (v.status === "REJECTED") throw new Error("SYNTHETIC_LOG_FAILURE"); } }); }
    catch (error) { expect(error).toMatchObject({ code: "P1C_UNKNOWN_DESCENDANT", secondaryDiagnosticFailure: "P1C_TREE_EVIDENCE_FAILED" }); return; }
    throw new Error("unknown accepted");
  });
});

describe("P1-C D5 one bounded shutdown owner", () => {
  it("STOP_CONCURRENT_REQUESTS share one operation for both registered consumers", async () => {
    const events: unknown[] = [], joined = vi.fn(async () => {}), owner = createWorkerShutdown({ runId, generation, afterJoin: joined, record: (v: unknown) => events.push(v) });
    const a = d5Child(201), b = d5Child(202), stopA = vi.fn(a.close), stopB = vi.fn(b.close);
    owner.track(a.child, { role: "CONSUMER_A", graceful: stopA }); owner.track(b.child, { role: "CONSUMER_B", graceful: stopB });
    const left = owner.stopAll(), right = owner.stopAll(d5Control());
    expect(right).toBe(left); await left;
    expect(stopA).toHaveBeenCalledOnce(); expect(stopB).toHaveBeenCalledOnce(); expect(joined).toHaveBeenCalledOnce();
    expect(a.child.kill).not.toHaveBeenCalled(); expect(b.child.kill).not.toHaveBeenCalled();
    expect(owner.records().every(r => r.closeObserved && r.exitObserved)).toBe(true);
    expect(JSON.stringify(events)).toContain("group-joined");
  });

  it("STOP_SINGLE_OWNER reconciles an intentional crash and later group abort without duplicate stop", async () => {
    const owner = createWorkerShutdown({ runId, generation }), a = d5Child(211), b = d5Child(212);
    owner.track(a.child, { role: "CONSUMER_A" }); owner.track(b.child, { role: "CONSUMER_B" });
    const crash = owner.stopOne(a.child, { force: true }), group = owner.stopAll();
    await Promise.all([crash, group]);
    expect(a.child.kill).toHaveBeenCalledOnce(); expect(b.child.kill).toHaveBeenCalledOnce();
    expect(owner.stopOne(a.child)).toBe(crash);
  });

  it("STOP_UNKNOWN_PROCESS and PID reuse never invoke a foreign or mutated handle", async () => {
    const owner = createWorkerShutdown({ runId, generation }), a = d5Child(221), foreign = d5Child(221);
    owner.track(a.child, { role: "CONSUMER_A" });
    await expect(owner.stopOne(foreign.child)).rejects.toThrow("P1C_UNOWNED_STOP_FORBIDDEN");
    a.child.pid = 999;
    await expect(owner.stopOne(a.child)).rejects.toThrow("P1C_UNOWNED_STOP_FORBIDDEN");
    expect(foreign.child.kill).not.toHaveBeenCalled(); expect(a.child.kill).not.toHaveBeenCalled();
    a.child.pid = 221; a.close(); await owner.stopAll();
  });

  it("STOP_ALREADY_EXITED and CLOSE_EVENT_RACE require the actual close event", async () => {
    const owner = createWorkerShutdown({ runId, generation }), f = d5Child(231);
    owner.track(f.child, { role: "CONSUMER_A" }); f.child.exitCode = 0; f.child.emit("exit", 0);
    let settled = false; const pending = owner.stopAll().then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false); expect(f.child.kill).not.toHaveBeenCalled();
    f.child.emit("close", 0); await pending; expect(settled).toBe(true);
    const before = d5Child(232), other = createWorkerShutdown({ runId, generation });
    other.track(before.child, { role: "CONSUMER_B" }); before.close();
    await other.stopAll(); expect(before.child.kill).not.toHaveBeenCalled();
  });

  it("STOP_ABORT_DURING_STARTUP joins a late registration under the existing group deadline", async () => {
    const owner = createWorkerShutdown({ runId, generation }), a = d5Child(241), late = d5Child(242);
    const entered = deferred<void>(), release = deferred<void>();
    owner.track(a.child, { role: "CONSUMER_A", graceful: async () => { entered.resolve(); await release.promise; a.close(); } });
    const pending = owner.stopAll(d5Control()); await entered.promise;
    owner.track(late.child, { role: "CONSUMER_B" });
    await new Promise(done => setImmediate(done)); expect(late.child.kill).toHaveBeenCalledOnce();
    release.resolve(); await pending; expect(owner.records()).toHaveLength(2);
    expect(() => owner.track(d5Child(243).child, { role: "CONSUMER_B" })).toThrow("P1C_LATE_PROCESS_REGISTRATION");
  });

  it("STOP_ABORT_DURING_PROBE reconciles only its registered handle and preserves abort", async () => {
    const owner = createWorkerShutdown({ runId, generation }), f = d5Child(251), control = d5Control();
    owner.track(f.child, { role: "PROCESS_PROBE" });
    const pending = owner.stopOne(f.child, { force: true, control }), failed = expect(pending).rejects.toThrow("P1C_PROBE_ABORTED");
    control.controller.abort(new WorkerRunError("P1C_PROBE_ABORTED")); await failed;
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(owner.records()[0].failure).toBe("P1C_PROBE_ABORTED");
  });

  it("STOP_ABORT_DURING_JOIN and late close cannot erase the original failed result", async () => {
    const owner = createWorkerShutdown({ runId, generation }), f = d5Child(261, false), control = d5Control();
    owner.track(f.child, { role: "CONSUMER_A" });
    const pending = owner.stopAll(control), failed = expect(pending).rejects.toThrow("P1C_PRIMARY_TIMEOUT");
    await new Promise(done => setImmediate(done)); expect(f.child.kill).toHaveBeenCalledOnce();
    control.controller.abort(new WorkerRunError("P1C_PRIMARY_TIMEOUT")); await failed;
    expect(owner.records()[0].closeObserved).toBe(false);
    f.close(); await expect(owner.stopAll()).rejects.toThrow("P1C_PRIMARY_TIMEOUT");
    expect(owner.records()[0].failure).toBe("P1C_PRIMARY_TIMEOUT");
  });

  it("STOP_TIMEOUT never renews the group budget and a stricter parent narrows an existing stop", async () => {
    vi.useFakeTimers(); const owner = createWorkerShutdown({ runId, generation }), f = d5Child(271, false);
    owner.track(f.child, { role: "CONSUMER_A", graceful: () => new Promise(() => {}) });
    const pending = owner.stopAll(), failed = expect(pending).rejects.toBeInstanceOf(WorkerRunError);
    await vi.advanceTimersByTimeAsync(10);
    expect(owner.stopAll(d5Control(25))).toBe(pending);
    await vi.advanceTimersByTimeAsync(26); await failed;
    expect(f.child.kill).toHaveBeenCalledOnce(); expect(owner.records()[0].closeObserved).toBe(false);
    f.close(); await expect(owner.stopAll(d5Control(10000))).rejects.toBeInstanceOf(WorkerRunError);
  });

  it("STOP_CLOSE_EVENT already lost before registration remains UNKNOWN rather than fabricated PASS", async () => {
    vi.useFakeTimers(); const f = d5Child(281), owner = createWorkerShutdown({ runId, generation });
    f.close(); owner.track(f.child, { role: "CONSUMER_A" });
    const pending = owner.stopAll(d5Control(20)), fail = expect(pending).rejects.toBeInstanceOf(WorkerRunError);
    await vi.advanceTimersByTimeAsync(21); await fail;
    expect(f.child.kill).not.toHaveBeenCalled(); expect(owner.records()[0].closeObserved).toBe(false);
  });

  it("STOP_RECONCILIATION runs a bounded read-only probe without killing it at registration", async () => {
    const probe = d5Child(291), active = deferred<void>(), complete = deferred<void>();
    const owner = createWorkerShutdown({ runId, generation, afterJoin: async control => {
      owner.track(probe.child, { role: "PROCESS_PROBE", reconciliationControl: control }); active.resolve();
      await complete.promise; control.beforeSpawn();
    } });
    const pending = owner.stopAll(); await active.promise;
    expect(probe.child.kill).not.toHaveBeenCalled(); probe.close(); complete.resolve(); await pending;
    expect(owner.records()[0].closeObserved).toBe(true);
  });

  it("STOP_RECONCILIATION abort terminates an active owned probe and never reports late PASS", async () => {
    const control = d5Control(), probe = d5Child(301), active = deferred<void>(), complete = deferred<void>();
    const owner = createWorkerShutdown({ runId, generation, afterJoin: async c => {
      owner.track(probe.child, { role: "PROCESS_PROBE", reconciliationControl: c }); active.resolve(); await complete.promise;
    } });
    const pending = owner.stopAll(control), fail = expect(pending).rejects.toThrow("P1C_SHUTDOWN_TIMEOUT"); await active.promise;
    control.controller.abort(new WorkerRunError("P1C_SHUTDOWN_TIMEOUT")); await fail; complete.resolve();
    await new Promise(done => setImmediate(done)); expect(probe.child.kill).toHaveBeenCalledOnce();
    expect(owner.records()[0].closeObserved).toBe(true);
    await expect(owner.stopAll()).rejects.toThrow("P1C_SHUTDOWN_TIMEOUT");
  });

  it("STOP_PRIMARY_ERROR and diagnostic failures remain separate and sanitized", async () => {
    const marker = "SYNTHETIC_SHUTDOWN_SECRET_NOT_FOR_OUTPUT", f = d5Child(311);
    const owner = createWorkerShutdown({ runId, generation,
      record: () => { throw new Error(marker); }, afterJoin: async () => { throw new Error(marker); } });
    owner.track(f.child, { role: "CONSUMER_A" });
    try { await owner.stopAll(); } catch (error) {
      expect(error).toMatchObject({ code: "P1C_SHUTDOWN_EVIDENCE_FAILED", reconciliationFailure: "P1C_SHUTDOWN_FAILED" });
      expect(String(error)).not.toContain(marker); expect(JSON.stringify(error)).not.toContain(marker); return;
    }
    throw new Error("diagnostic failure accepted");
  });

  it("STOP_FINAL_RECEIPT failure cannot produce PASS after every handle has closed", async () => {
    const owner = createWorkerShutdown({ runId, generation, record: (value: { event: string }) => {
      if (value.event === "group-joined") throw new Error("SYNTHETIC_FINAL_RECEIPT_FAILURE");
    } });
    const f = d5Child(312); owner.track(f.child, { role: "CONSUMER_A" }); f.close();
    await expect(owner.stopAll()).rejects.toThrow("P1C_SHUTDOWN_EVIDENCE_FAILED");
    expect(owner.records()[0].closeObserved).toBe(true);
  });

  it("TREE01 failure survives correlated STOP acknowledgements, empty final census and shutdown failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m13-p1c-d5-tree-"));
    const children: Array<ReturnType<typeof d5Child> & { connected: boolean; birth: string }> = [], packets: string[] = [], events: unknown[] = [];
    const ended = vi.fn(async () => {}), clients = () => ({ on: () => {}, connect: async () => {}, end: ended,
      query: async (text: string) => text.includes("_prisma_migrations")
        ? { rows: EXPECTED_STAGING_MIGRATION_NAMES.map(migration_name => ({ migration_name, finished_at: new Date(), rolled_back_at: null, logs: null })), rowCount: 16 }
        : text.startsWith("SELECT") ? { rows: [{ outbox: 0, attempts: 0, receipts: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 } });
    const spawnFake = vi.fn((_exe: string, _args: string[], options: { env: Record<string, string> }) => {
      const f = Object.assign(d5Child(400 + children.length), { connected: true, birth: new Date().toISOString() });
      children.push(f);
      const peer = createWorkerPeer({ runId, generation, slot: options.env.P1C_SLOT, nonce: options.env.P1C_NONCE },
        (p: unknown) => queueMicrotask(() => f.child.emit("message", p)));
      Object.assign(f.child, { connected: true, stdout: new PassThrough(), stderr: new PassThrough(),
        send(p: unknown, callback: () => void) {
          const packet = peer.receive(p); packets.push(packet.type); callback();
          if (packet.type === "INIT") peer.send("READY", { identity });
          if (packet.type === "STOP") {
            peer.send("EVENT", { event: "abort-observed" });
            peer.send("STOPPED", { exitCode: 0, databaseClosed: true, aborted: true });
            queueMicrotask(() => { f.connected = false; f.close(); });
          }
        } });
      queueMicrotask(() => peer.send("HELLO", { pid: f.child.pid, node: process.versions.node, execPath: process.execPath }));
      return f.child;
    });
    try {
      await expect(runWorkerRuntime({ requireOwnership: true, ownershipGuard: async () => proof(),
        onChild: () => {}, record: (v: unknown) => events.push(v), environment, generation, runId,
        expectedIdentity: identity, evidenceDirectory: directory, signal: new AbortController().signal, timeoutMs: 3000 },
      { client: clients, spawn: spawnFake, snapshot: async () => {
        const roots = children.filter(c => c.connected).map(c => ({ pid: c.child.pid, parent: process.pid, birth: c.birth, path: process.execPath }));
        return roots.length ? [...roots, { pid: 9999, parent: roots[0].pid, birth: roots[0].birth, path: "C:/SYNTHETIC_FORBIDDEN_PATH.exe" }] : [];
      } })).rejects.toThrow("P1C_UNKNOWN_DESCENDANT");
      const receipt = JSON.parse(await readFile(join(directory, "worker-runtime.json"), "utf8"));
      expect(receipt.primaryFailure).toBe("P1C_UNKNOWN_DESCENDANT");
      expect(receipt.treeObservations.some((v: { failedPredicate: string }) => v.failedPredicate === "DESCENDANT_EXECUTABLE_NOT_ALLOWED")).toBe(true);
      expect(receipt.processes.every((p: { joined: boolean; stopped: boolean; aborted: boolean }) => p.joined && p.stopped && p.aborted)).toBe(true);
      expect(receipt.shutdownFailure).toBe("P1C_TREE_NEVER_QUALIFIED");
      expect(receipt.processQuiescence).not.toBe("PASS_VERIFIED");
      expect(packets).toEqual(["INIT", "INIT", "STOP", "STOP"]);
      expect(children.every(c => c.child.kill.mock.calls.length === 0)).toBe(true);
      expect(ended).toHaveBeenCalled(); expect(JSON.stringify(events)).not.toContain("SYNTHETIC_FORBIDDEN_PATH");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("P1-C claim and process reconciliation", () => {
  it("accepts disjoint claims and rejects overlapping claim ownership", () => {
    const active = new Map(), id = randomUUID(), other = randomUUID();
    reconcileWorkerClaims(active, "A", [{ id, lease: "1" }]);
    reconcileWorkerClaims(active, "B", [{ id: other, lease: "2" }]);
    expect(active.size).toBe(2);
    expect(() => reconcileWorkerClaims(active, "B", [{ id, lease: "3" }])).toThrow("P1C_CLAIM_DUPLICATE");
    expect(() => reconcileWorkerClaims(new Map(), "A", [{ id, lease: "1" }, { id, lease: "1" }])).toThrow();
  });

  it("permits only expired joined interrupted A to be recovered with a new token by B", () => {
    const id = randomUUID();
    for (const proof of [{ recovery: true }, { recovery: true, crashedJoined: true }, { recovery: true, leaseExpired: true }]) {
      const active = new Map([[id, { slot: "A", lease: "old" }]]);
      expect(() => reconcileWorkerClaims(active, "B", [{ id, lease: "new" }], proof)).toThrow();
    }
    const active = new Map([[id, { slot: "A", lease: "old" }]]);
    reconcileWorkerClaims(active, "B", [{ id, lease: "new" }], { recovery: true, crashedJoined: true, leaseExpired: true });
    expect(active.get(id)).toEqual({ slot: "B", lease: "new" });
  });

  it("distinguishes actual close from a resolved work promise and bounds join", async () => {
    await expect(joinWorker({ joined: false, closed: Promise.resolve() }, 20)).rejects.toThrow("P1C_JOIN_UNKNOWN");
    await expect(joinWorker({ joined: true }, 20)).resolves.toBeUndefined();
    vi.useFakeTimers();
    const pending = joinWorker({ joined: false, closed: new Promise(() => {}) }, 20);
    const fail = expect(pending).rejects.toThrow("P1C_JOIN_UNKNOWN"); await vi.advanceTimersByTimeAsync(20); await fail;
  });

  it("tracks only attributed helpers and rejects replacement or unknown descendants", () => {
    const birth = "2026-11-09T10:00:00Z", root = { pid: 12, joined: false };
    const helperPath = resolve("node_modules/@esbuild/win32-x64/esbuild.exe");
    const snapshot = [{ pid: 12, parent: 1, birth, path: process.execPath },
      { pid: 13, parent: 12, birth, path: helperPath }];
    const tracked = reconcileWorkerTree([root], snapshot, new Map(), new Set([helperPath.toLowerCase()]));
    expect(tracked.size).toBe(2);
    expect(() => reconcileWorkerTree([root], [{ ...snapshot[0], birth: "later" }], tracked)).toThrow("P1C_PROCESS_REPLACED");
    expect(() => reconcileWorkerTree([root], [...snapshot, { pid: 14, parent: 12, birth, path: "C:/unknown.exe" }], tracked)).toThrow("P1C_UNKNOWN_DESCENDANT");
  });

  it("blocks all consumers and SQL on non-positive initial ownership and records sanitized failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m13-p1c-negative-"));
    const primary = new WorkerRunError("P1C_OWNERSHIP_NOT_VERIFIED"), onChild = vi.fn(), client = vi.fn();
    try {
      await expect(runWorkerRuntime({ requireOwnership: true, ownershipGuard: async () => { throw primary; }, onChild,
        environment, generation, runId, expectedIdentity: identity, evidenceDirectory: directory,
        signal: new AbortController().signal, timeoutMs: 1000 }, { client })).rejects.toBe(primary);
      expect(onChild).not.toHaveBeenCalled(); expect(client).not.toHaveBeenCalled();
      const receipt = JSON.parse(await readFile(join(directory, "worker-runtime.json"), "utf8"));
      expect(receipt.primaryFailure).toBe(primary.code); expect(receipt.workers).toEqual([]);
      expect(JSON.stringify(receipt)).not.toContain("SYNTHETIC_ONLY");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("P1-C two-process ownership on partial failure", () => {

  it("joins both owned roots and preserves unexpected child failure when its sibling stops cleanly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m13-p1c-pair-"));
    const children: Array<EventEmitter & { pid: number; birth: string; connected: boolean; stdout: PassThrough; stderr: PassThrough }> = [];
    const onChild = vi.fn(), onAbort = vi.fn(), ended = vi.fn(async () => undefined);
    const client = () => ({ on: () => {}, connect: async () => {}, end: ended,
      query: async (sql: string) => {
        if (sql.includes("_prisma_migrations")) return { rows: EXPECTED_STAGING_MIGRATION_NAMES.map(migration_name => ({ migration_name, finished_at: new Date(), rolled_back_at: null, logs: null })), rowCount: 16 };
        if (sql.startsWith("SELECT")) return { rows: [{ outbox: 0, attempts: 0, receipts: 0 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      } });
    const spawnFake = (_executable: string, _args: string[], options: { env: Record<string, string> }) => {
      const child = Object.assign(new EventEmitter(), { pid: 101 + children.length, birth: new Date().toISOString(), connected: true, stdout: new PassThrough(), stderr: new PassThrough() });
      child.once("close", () => { child.connected = false; });
      children.push(child);
      const c = options.env;
      const peer = createWorkerPeer({ runId: c.P1C_RUN_ID, generation: c.P1C_GENERATION, slot: c.P1C_SLOT, nonce: c.P1C_NONCE },
        (p: unknown) => queueMicrotask(() => child.emit("message", p)));
      Object.assign(child, { send(p: unknown, callback: (error?: Error) => void) {
        const packet = peer.receive(p); callback?.();
        if (packet.type === "INIT") peer.send("READY", { identity });
        if (packet.type === "FIXTURE") queueMicrotask(() => children[1].emit("close", 1, null));
        if (packet.type === "STOP") { child.connected = false; queueMicrotask(() => child.emit("close", 0, null)); }
      } });
      queueMicrotask(() => peer.send("HELLO", { pid: child.pid, node: process.versions.node, execPath: process.execPath }));
      return child;
    };
    try {
      await expect(runWorkerRuntime({ requireOwnership: true, ownershipGuard: async () => proof(), onChild, onAbort,
        environment, generation, runId, expectedIdentity: identity, evidenceDirectory: directory,
        signal: new AbortController().signal, timeoutMs: 2000 }, { client, spawn: spawnFake,
        snapshot: async () => children.filter(c => c.connected).map(c => ({ pid: c.pid, parent: process.pid, birth: c.birth, path: process.execPath })),
      })).rejects.toThrow("P1C_UNEXPECTED_CHILD_EXIT");
      expect(onChild).toHaveBeenCalledTimes(2); expect(onAbort).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalled();
      const receipt = JSON.parse(await readFile(join(directory, "worker-runtime.json"), "utf8"));
      expect(receipt.processes).toHaveLength(2);
      expect(receipt.processes.every((p: { joined: boolean }) => p.joined)).toBe(true);
      expect(receipt.primaryFailure).toBe("P1C_UNEXPECTED_CHILD_EXIT");
      expect(receipt.processQuiescence).not.toBe("PASS_VERIFIED");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("P1-C actual consumer entry wiring with in-memory dependencies", () => {
  it("rejects inherited Render/PG overrides and a persistent target before module load", () => {
    expect(validateConsumerEnvironment(environment)).toMatchObject(correlation);
    for (const extra of [{ RENDER: "true" }, { NODE_OPTIONS: "--bad" }, { PGOPTIONS: "-c anything" },
      { DATABASE_URL: "postgresql://synthetic@127.0.0.1:5432/persistent" }, { P1C_SLOT: "C" }]) {
      expect(() => validateConsumerEnvironment({ ...environment, ...extra })).toThrow();
    }
  });

  it("invokes the real consumer entry, delegates the batch, propagates STOP and closes clients", async () => {
    const packets: unknown[] = [], callbacks = new Set<() => void>();
    let listener: (p: unknown) => void = () => undefined;
    const expire = vi.fn(async () => 0), disconnect = vi.fn(async () => undefined);
    const stopped = deferred<void>();
    const parent = createWorkerPeer(correlation, (p: unknown) => queueMicrotask(() => listener(p)));
    const runtime = { timestamp: () => new Date().toISOString(), emit: () => {}, classifyFailure: () => ({ classification: "RUNTIME_FATAL", code: "WORKER_RUNTIME_UNCLASSIFIED" }), backoffMilliseconds: () => 1000 };
    const deps = { repository: { expirePending: expire }, runtime, whatsappProvider: {}, emailProvider: {} };
    const cli = vi.fn(async (options: { createDependencies: () => { repository: { expirePending: (input: { now: Date; limit: number }) => Promise<number> } }; addSignalListener: (signal: string, callback: () => void) => void; disconnect: () => Promise<void> }) => {
      const d = options.createDependencies();
      options.addSignalListener("SIGTERM", () => stopped.resolve());
      await d.repository.expirePending({ now: new Date(), limit: 100 });
      parent.send("STOP"); await stopped.promise; await options.disconnect();
      return 0;
    });
    const load = vi.fn(async () => ({
      db: { prisma: { $queryRaw: async () => [{ identity }], $disconnect: disconnect } },
      composition: { createNotificationWorkerDependencies: () => deps },
      providers: { SimulatedWhatsAppProvider: class {} }, cli: { runNotificationWorkerCli: cli }, policy: {},
    }));
    const exit = await runWorkerConsumer({ environment,
      load: load as unknown as NonNullable<Parameters<typeof runWorkerConsumer>[0]>["load"],
      transport: {
        send(p) {
          packets.push(p); const packet = parent.receive(p);
          if (packet.type === "HELLO") parent.send("INIT", { identity });
          else if (packet.type === "READY") parent.send("START");
          else if (packet.type === "REQUEST") parent.send("REPLY", { id: packet.data.id });
        },
        subscribe(fn) { listener = fn; return () => { listener = () => {}; }; },
        disconnected(fn) { callbacks.add(fn); return () => callbacks.delete(fn); },
      } });
    expect(exit).toBe(0); expect(cli).toHaveBeenCalledOnce(); expect(expire).toHaveBeenCalledOnce(); expect(disconnect).toHaveBeenCalled();
    const result = packets.map(p => (p as { type: string }).type);
    expect(result).toEqual(["HELLO", "READY", "REQUEST", "EVENT", "STOPPED"]);
    expect(JSON.stringify(packets)).not.toContain("SYNTHETIC_ONLY");
    expect(callbacks.size).toBe(0);
  });
});
const d2ProbeEnvironment = Object.fromEntries(
  ["SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME", "PATH"].map(key =>
    [key, process.env[key] ?? (key === "SystemRoot" ? "C:/Windows" : key === "PATH" ? "C:/qualified" : tmpdir())]),
);
function d2Probe(options: { timeoutMs?: number; cooperative?: boolean; onRegisterAbort?: boolean } = {}) {
  const controller = new AbortController(), directory = tmpdir();
  const invocation = workerProbeInvocation(d2ProbeEnvironment, directory);
  const child = Object.assign(new EventEmitter(), { pid: 42424, stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { if (options.cooperative !== false) queueMicrotask(() => child.emit("close", 1)); return true; }) });
  const events: Array<Record<string, unknown>> = [], registered = vi.fn(() => { if (options.onRegisterAbort) controller.abort(); });
  const spawn = vi.fn(() => child);
  const run = () => runWorkerProcessProbe({ environment: d2ProbeEnvironment, evidenceDirectory: directory,
    signal: controller.signal, onChild: registered, timeoutMs: options.timeoutMs ?? 5000,
    record: (r: Record<string, unknown>) => events.push(r),
  }, { spawn, executableHash: "a".repeat(64) });
  const rows = () => [{ pid: child.pid, parent: process.pid, birth: new Date().toISOString(), path: invocation.executable }];
  const complete = (value: unknown = rows(), code = 0, stderr = "") => {
    child.stdout.emit("data", Buffer.from(JSON.stringify(value)));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", code);
  };
  return { controller, child, events, registered, spawn, run, rows, complete };
}

describe("P1-C D2 qualified read-only probe", () => {
  it("JOIN_ABORT_DURING_ROOT_REGISTRATION cannot lose an immediate close or start its sibling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "m13-p1c-register-"));
    const ended = vi.fn(async () => undefined), spawnFake = vi.fn(() => Object.assign(new EventEmitter(), {
      pid: 303, connected: false, stdout: new PassThrough(), stderr: new PassThrough(), send: vi.fn(),
    }));
    const onChild = vi.fn((child: EventEmitter) => { child.emit("close", 1, null); });
    const client = () => ({ on: () => {}, connect: async () => {}, end: ended,
      query: async (sql: string) => {
        if (sql.includes("_prisma_migrations")) return { rows: EXPECTED_STAGING_MIGRATION_NAMES.map(migration_name => ({ migration_name, finished_at: new Date(), rolled_back_at: null, logs: null })), rowCount: 16 };
        if (sql.startsWith("SELECT")) return { rows: [{ outbox: 0, attempts: 0, receipts: 0 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      } });
    try {
      await expect(runWorkerRuntime({ requireOwnership: true, ownershipGuard: async () => proof(), onChild,
        environment, generation, runId, expectedIdentity: identity, evidenceDirectory: directory,
        signal: new AbortController().signal, timeoutMs: 1000,
      }, { client, spawn: spawnFake, snapshot: async () => [] })).rejects.toThrow("P1C_UNEXPECTED_CHILD_EXIT");
      expect(spawnFake).toHaveBeenCalledOnce(); expect(onChild).toHaveBeenCalledOnce(); expect(ended).toHaveBeenCalled();
      const receipt = JSON.parse(await readFile(join(directory, "worker-runtime.json"), "utf8"));
      expect(receipt.processes).toHaveLength(1); expect(receipt.processes[0].joined).toBe(true);
      expect(receipt.primaryFailure).toBe("P1C_UNEXPECTED_CHILD_EXIT"); expect(receipt.processQuiescence).not.toBe("PASS_VERIFIED");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("PROBE_VALID_PROCESS uses the OS allowlist, fixed modules and observed close", async () => {
    const invocation = workerProbeInvocation({ ...d2ProbeEnvironment, NODE_OPTIONS: "forbidden", DATABASE_URL: "SYNTHETIC_NOT_EXPORTED",
      PSModulePath: "C:/untrusted", SECRET_TOKEN: "SYNTHETIC_SECRET_SENTINEL" }, tmpdir());
    expect(invocation.environment.USERPROFILE).toBe(d2ProbeEnvironment.USERPROFILE);
    expect(invocation.environment.NODE_OPTIONS).toBeUndefined(); expect(invocation.environment.SECRET_TOKEN).toBeUndefined();
    expect(invocation.environment.PSModulePath).toMatch(/WindowsPowerShell[/\\]v1\.0[/\\]Modules$/u);
    expect(Buffer.from(invocation.args.at(-1)!, "base64").toString("utf16le")).toBe(PROCESS_PROBE_SCRIPT);
    const f = d2Probe(), promise = f.run();
    expect(f.registered).toHaveBeenCalledWith(f.child); f.complete();
    await expect(promise).resolves.toHaveLength(1);
    expect(f.events[0]).toMatchObject({ closeObserved: true, exitCode: 0, primaryFailure: null });
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("PROBE_WRONG_IDENTITY and MISSING_PROCESS remain fail closed", async () => {
    for (const change of [{ parent: process.pid + 1 }, { path: "C:/foreign.exe" }, { birth: "2000-01-01T00:00:00Z" }, { pid: 42 }]) {
      const f = d2Probe(), promise = f.run(), fail = expect(promise).rejects.toThrow("P1C_PROBE_IDENTITY_NOT_VERIFIED");
      f.complete([{ ...f.rows()[0], ...change }]); await fail;
      expect(f.events[0].primaryFailure).toBe("P1C_PROBE_IDENTITY_NOT_VERIFIED");
    }
  });

  it("PROBE_UNKNOWN_STRUCTURE, nonzero exit and stderr cannot produce PASS or leak values", async () => {
    const marker = "SYNTHETIC_INTERNAL_VALUE_NOT_FOR_RECEIPT";
    for (const mode of ["shape", "exit", "stderr"]) {
      const f = d2Probe(), promise = f.run(), rejected = expect(promise).rejects.toBeInstanceOf(WorkerRunError);
      if (mode === "shape") f.complete({ secret: marker });
      else f.complete(f.rows(), mode === "exit" ? 1 : 0, mode === "stderr" ? marker : "");
      await rejected;
      expect(JSON.stringify(f.events).includes(marker)).toBe(false);
      expect(f.events[0].primaryFailure).not.toBeNull();
    }
    const invalid = d2ProbeEnvironment;
    expect(() => workerProbeInvocation({ ...invalid, USERPROFILE: "" }, tmpdir())).toThrow("P1C_PROBE_ENVIRONMENT_INVALID");
  });

  it("PROBE_LATE_RESULT is rejected even when the process subsequently closes successfully", async () => {
    vi.useFakeTimers(); const f = d2Probe({ timeoutMs: 20, cooperative: false }), promise = f.run();
    const rejected = expect(promise).rejects.toThrow("P1C_PROCESS_PROBE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(21); f.complete(); await rejected;
    expect(f.events[0]).toMatchObject({ closeObserved: true, primaryFailure: "P1C_PROCESS_PROBE_TIMEOUT" });
    expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it("PROBE_TIMEOUT independently records an unknown join and never changes it into late PASS", async () => {
    vi.useFakeTimers(); const f = d2Probe({ timeoutMs: 20, cooperative: false }), promise = f.run();
    const rejected = expect(promise).rejects.toMatchObject({ code: "P1C_PROCESS_PROBE_TIMEOUT", joinFailure: "P1C_PROBE_JOIN_UNKNOWN" });
    await vi.advanceTimersByTimeAsync(5021); await rejected;
    expect(f.events[0]).toMatchObject({ closeObserved: false, joinFailure: "P1C_PROBE_JOIN_UNKNOWN" });
    f.complete(); expect(f.events).toHaveLength(1); expect(f.events[0].closeObserved).toBe(false);
  });

  it("PROBE_ABORT reaches an active owned operation and joins its close", async () => {
    const f = d2Probe(), promise = f.run(), rejected = expect(promise).rejects.toThrow("P1C_PROCESS_PROBE_ABORTED");
    expect(f.spawn).toHaveBeenCalledOnce(); f.controller.abort(); await rejected;
    expect(f.child.kill).toHaveBeenCalledOnce();
    expect(f.events[0]).toMatchObject({ closeObserved: true, primaryFailure: "P1C_PROCESS_PROBE_ABORTED" });
    const before = d2Probe(); before.controller.abort();
    await expect(before.run()).rejects.toThrow("P1C_PROCESS_PROBE_ABORTED"); expect(before.spawn).not.toHaveBeenCalled();
  });

  it("JOIN_ABORT_DURING_STARTUP observes close even when abort happens inside child registration", async () => {
    const f = d2Probe({ onRegisterAbort: true });
    await expect(f.run()).rejects.toThrow("P1C_PROCESS_PROBE_ABORTED");
    expect(f.events[0]).toMatchObject({ closeObserved: true, joinFailure: null });
    expect(f.child.kill).toHaveBeenCalledOnce();
  });

  it("JOIN_PARENT_AND_HELPERS does not infer descendant quiescence from a closed parent", () => {
    const birth = new Date().toISOString(), helper = resolve("node_modules/@esbuild/win32-x64/esbuild.exe");
    const root = { pid: 100, parentPid: process.pid, joined: false, spawnStartedAt: Date.now(), spawnReturnedAt: Date.now() };
    const initial = [{ pid: 100, parent: process.pid, birth, path: process.execPath }, { pid: 101, parent: 100, birth, path: helper }];
    const tracked = reconcileWorkerTree([root], initial, new Map(), new Set([helper.toLowerCase()]));
    root.joined = true;
    reconcileWorkerTree([root], [initial[1]], tracked);
    expect([...tracked].filter(([pid]) => [initial[1]].some(p => p.pid === pid))).toHaveLength(1);
    expect(() => reconcileWorkerTree([root], [{ ...initial[1], birth: new Date(Date.now() + 10000).toISOString() }], tracked)).toThrow("P1C_PROCESS_REPLACED");
    expect(() => reconcileWorkerTree([{ ...root, joined: false }], [{ ...initial[0], parent: process.pid + 1 }], new Map())).toThrow("P1C_PROCESS_IDENTITY_MISMATCH");
    reconcileWorkerTree([root], [], tracked); // Only now are all tracked IDs absent.
  });
});


