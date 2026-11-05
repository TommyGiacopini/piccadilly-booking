import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanEnvironment, redact, zipMembers, checkBundledFiles, verifyRuntime, createRunHarness, commandDefinitions, lifecycleProbe, SafetyError, main, PLANS, inspectDockerBinding, finishOwnedRun } from "./m13-p1-environment.mjs";
import { createProxyRunHarness, proxyConfiguration, proxyConfigArchive, assertD6RunnerTarget, D6_PINS, D6_PROFILE } from "./m13-p1-environment.mjs";
import { MonotonicBudget, runInfrastructureProcess, parseObservationSections, D8_LIMITS } from "./m13-p1-environment.mjs";
import { canonicalIdentityIPv4, assertD6Identity, waitReadinessPoll } from "./m13-p1-environment.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Worker } from "node:worker_threads";
import { verifyFilesBounded, verificationQuiescence, ownedProcessQuiescence } from "./m13-p1-environment.mjs";
import { D13_LIMITS } from "./m13-p1-environment.mjs";
import { classifySessionCensus } from "./m13-p1-environment.mjs";
import { D15_ENGINE_ENDPOINT, assertDockerTarget, verifyDockerEngine, readLocalEngineIdentity } from "./m13-p1-environment.mjs";

// The protected Vitest configuration includes every *.test.mjs. Keep the same
// assertions executable both there and under Node's dependency-free test runner.
const { test } = process.env.VITEST ? await import("vitest") : await import("node:test");
const fail = code => error => error instanceof SafetyError && error.code === code;
function fixture() {
  const state = { calls: [], children: [], exists: false, networkExists: false, sourceCalls: 0 };
  const id = "c".repeat(64), net = "d".repeat(64), image = "sha256:" + "e".repeat(64);
  const labels = args => Object.fromEntries(args.flatMap((value, i) => value === "--label" ? [args[i + 1].split("=")] : []));
  const runtime = { directory: dirname(process.execPath), npmCli: "/synthetic/npm-cli.js", receipt: { simulation: true, nodePinPass: false }, assertLive: async () => { if (state.runtimeChanged) throw new SafetyError("RUNTIME_CHANGED"); } };
  const adapter = {
    toolchain: { simulation: true },
    applicationPort: async () => { if (state.portBusy) throw new SafetyError("APPLICATION_PORT_NOT_FREE"); },
    source: async () => ({ files: 479, freeze: state.changeSource && state.sourceCalls++ ? "changed" : "same" }),
    child: async (args, env, options) => {
      state.children.push({ args, env });
      if (state.childError) throw new SafetyError("SPAWN_ERROR");
      await options.stdout("synthetic output");
      return { exitCode: state.exitCode ?? 0, signal: null, reason: state.reason ?? null, pid: 123, joined: true, executable: process.execPath };
    },
    docker: async (args, env = {}) => {
      state.calls.push(args);
      if (state.dockerError) throw new SafetyError("INFRASTRUCTURE_INTROSPECTION_UNAVAILABLE");
      if (args[0] === "image") return JSON.stringify([{ Id: image, RepoDigests: ["postgres@sha256:" + "e".repeat(64)] }]);
      if (args[0] === "network" && args[1] === "create") {
        state.networkExists = true; state.network = { Id: net, Internal: true, Labels: labels(args), Containers: {} }; return net;
      }
      if (args[0] === "create") {
        state.exists = true;
        state.config = Object.fromEntries(args.flatMap((arg, i) => arg === "--env" && args[i + 1].includes("=") ? [args[i + 1].split("=")] : []));
        state.config.POSTGRES_PASSWORD = env.POSTGRES_PASSWORD;
        state.container = { Id: id, Created: new Date().toISOString(), Image: image, Path: "docker-entrypoint.sh", Args: ["postgres"], Config: { Labels: labels(args), Image: image, Env: Object.entries(state.config).map(([k, v]) => k + "=" + v) }, HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] }, Tmpfs: { "/var/lib/postgresql": "rw,noexec,nosuid" }, NetworkMode: net, Binds: [], Privileged: false }, Mounts: [], State: { Running: false, Pid: 50 }, NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49100" }] }, Networks: { internal: { NetworkID: net } } } };
        state.network.Containers[id] = {}; return id;
      }
      if (args[0] === "inspect") {
        if (!state.exists) throw new SafetyError("INFRASTRUCTURE_INTROSPECTION_UNAVAILABLE");
        return JSON.stringify([state.container]);
      }
      if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([state.network]);
      if (args[0] === "start") { state.container.State.Running = true; return id; }
      if (args[0] === "port") {
        if (state.publicationUnavailable) throw new SafetyError("INFRASTRUCTURE_INTROSPECTION_UNAVAILABLE");
        return state.publicationOutput ?? "127.0.0.1:49100";
      }
      if (args[0] === "exec" && args.includes("/proc/mounts")) return state.badMount ? "/dev/disk /var/lib/postgresql ext4 rw 0 0" : "tmpfs /var/lib/postgresql tmpfs rw 0 0";
      if (args[0] === "exec" && args.includes("psql")) {
        assert.equal(env.PGPASSWORD, state.config.POSTGRES_PASSWORD);
        return JSON.stringify({ database: state.badDatabase ? "persistent_work" : state.config.POSTGRES_DB, role: state.badRole ? "wrong_role" : state.config.POSTGRES_USER, version: state.badVersion ? "18.40" : "18.4", dataDirectory: "/var/lib/postgresql/18/docker", systemIdentifier: state.changedServer ? "999999" : "123456", serverPort: 5432 });
      }
      if (args[0] === "rm") {
        if (state.failRemoval) throw new SafetyError("INFRASTRUCTURE_INTROSPECTION_UNAVAILABLE");
        state.exists = false; state.network.Containers = {}; return id;
      }
      if (args[0] === "ps") return state.exists ? id : "";
      if (args[0] === "network" && args[1] === "rm") { state.networkExists = false; return net; }
      if (args[0] === "network" && args[1] === "ls") return state.networkRemains ? net : state.networkExists ? net : "";
      throw Error("Unexpected fake operation: " + args[0]);
    },
  };
  return { state, runtime, adapter, async harness(extra = {}) { return createRunHarness({ runtime, adapters: adapter, evidenceDirectory: tmpdir(), ...extra }); } };
}

test("environment uses a positive OS allowlist and drops inherited secrets/provider/config", () => {
  const env = cleanEnvironment({ SystemRoot: "C:/Windows", SystemDrive: "C:", HOME: "/home/synthetic", PATH: "/global-node", AUTH_RESTAURANT_ID: "other", APP_ENV: "staging", META_TOKEN: "synthetic-secret", NPM_CONFIG_REGISTRY: "https://remote.invalid", POSTGRES_PASSWORD: "persistent-password" }, "/verified-node");
  assert.equal(env.SystemRoot, "C:/Windows"); assert.equal(env.SystemDrive, "C:"); assert.ok(env.PATH.startsWith("/verified-node"));
  for (const key of ["META_TOKEN", "APP_ENV", "AUTH_RESTAURANT_ID", "NPM_CONFIG_REGISTRY", "POSTGRES_PASSWORD"]) assert.equal(env[key], undefined);
  assert.ok(!env.PATH.includes("global-node"));
});
for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_REPL_EXTERNAL_MODULE", "DATABASE_URL", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "RENDER", "RENDER_SERVICE_ID", "RENDER_EXTERNAL_URL"]) {
  test("rejects untrusted " + key + " without any writer or infrastructure call", () => {
    assert.throws(() => cleanEnvironment({ [key]: "synthetic-untrusted" }, "/node"), fail("UNTRUSTED_ENVIRONMENT"));
  });
}
test("redacts generated secrets, credential URL, session cookie and binding", () => {
  const text = redact("synthetic-password postgresql://u:p@127.0.0.1/db piccadilly_session=synthetic-cookie\nx-piccadilly-draft-session-binding: synthetic-binding", ["synthetic-password"]);
  for (const value of ["synthetic-password", "u:p", "synthetic-cookie", "synthetic-binding"]) assert.ok(!text.includes(value));
});
test("invalid distribution ZIP is rejected", () => { assert.throws(() => zipMembers(Buffer.alloc(24))); });
async function bundle(operation) {
  const dir = await mkdtemp(join(tmpdir(), "m13-p1-bundle-"));
  assert.ok(dir.startsWith(join(tmpdir(), "m13-p1-bundle-")));
  const members = new Map([["node-v24.14.1-win-x64/node.exe", Buffer.from("synthetic-node")], ["node-v24.14.1-win-x64/node_modules/npm/package.json", Buffer.from('{"version":"synthetic"}')], ["node-v24.14.1-win-x64/node_modules/npm/bin/npm-cli.js", Buffer.from("synthetic-npm")]]);
  try {
    for (const [name, bytes] of members) { const path = join(dir, name.slice("node-v24.14.1-win-x64/".length)); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
    await operation(dir, members);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test("bundled inventory hashes node/npm without trusting a version string", async () => bundle(async (dir, members) => {
  const proof = await checkBundledFiles(dir, members);
  assert.equal(proof.npmVersion, "synthetic");
  assert.equal(proof.expected.get("node.exe"), createHash("sha256").update(await readFile(join(dir, "node.exe"))).digest("hex"));
  assert.equal(proof.nodePinPass, undefined);
}));
test("modified npm CLI is rejected even when its package version is unchanged", async () => bundle(async (dir, members) => {
  await writeFile(join(dir, "node_modules/npm/bin/npm-cli.js"), "modified");
  await assert.rejects(checkBundledFiles(dir, members), fail("BUNDLED_FILE_MISMATCH"));
}));
test("unexpected npm dependency file is rejected", async () => bundle(async (dir, members) => {
  await writeFile(join(dir, "node_modules/npm/unexpected.js"), "modified");
  await assert.rejects(checkBundledFiles(dir, members), fail("UNEXPECTED_NPM_FILE"));
}));
test("external or absent distribution never yields pin PASS", async () => { await assert.rejects(verifyRuntime(join(tmpdir(), "not-a-distribution"))); });
test("default real harness rejects a forged runtime receipt", async () => {
  const f = fixture(); await assert.rejects(createRunHarness({ runtime: f.runtime, evidenceDirectory: tmpdir() }), fail("VERIFIED_RUNTIME_CAPABILITY_REQUIRED"));
});
test("an existing loopback server cannot be adopted without create capability", async () => {
  const f = fixture(), h = await f.harness(); await assert.rejects(h.run("seed"), fail("RUN_CREATED_RESOURCE_REQUIRED"));
  assert.equal(f.state.children.length, 0); assert.equal(f.state.calls.length, 0);
});
test("positive task creation rechecks live before each child and tears down only owned IDs", async () => {
  const f = fixture(), h = await f.harness(); await h.create();
  for (const role of ["build", "migrate", "seed", "e2e-core"]) await h.run(role);
  assert.equal(f.state.children.length, 4);
  assert.equal(h.receipt().events.filter(e => e.kind === "preflight-positive").length, 5);
  assert.equal(h.receipt().events.filter(e => e.kind === "first-writer-preflight").length, 1);
  assert.equal(h.receipt().simulated, true); assert.equal(h.receipt().runtime.nodePinPass, false);
  const env = f.state.children[2].env, url = new URL(env.DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "49100"); assert.match(url.pathname, /^\/piccadilly_e2e_[a-f0-9]{32}$/u);
  assert.equal(env.APP_ENV, "development"); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.RENDER, undefined);
  assert.ok(env.AUTH_DEMO_STAFF_PASSWORD.startsWith("M13-only-"));
  assert.equal(await h.close(), true); assert.equal(f.state.exists, false); assert.equal(f.state.networkExists, false);
  const text = JSON.stringify(h.receipt()); assert.ok(!text.includes(url.password)); assert.ok(!text.includes(env.DATABASE_URL));
});
const negatives = {
  "wrong owner label": s => { s.container.Config.Labels["piccadilly.owner"] = "other"; },
  "wrong run label": s => { s.container.Config.Labels["piccadilly.run"] = "other"; },
  "unexpected container": s => { s.container.Id = "f".repeat(64); },
  "replacement creation time": s => { s.container.Created = "other"; },
  "unexpected image": s => { s.container.Image = "sha256:" + "f".repeat(64); },
  "persistent volume": s => { s.container.Mounts = [{ Type: "volume", Destination: "/var/lib/postgresql" }]; },
  "bind mount": s => { s.container.HostConfig.Binds = ["persistent:/var/lib/postgresql"]; },
  "actual persistent filesystem": s => { s.badMount = true; },
  "ambiguous port": s => { s.container.NetworkSettings.Ports["5432/tcp"].push({ HostIp: "127.0.0.1", HostPort: "49101" }); },
  "non-loopback binding": s => { s.container.NetworkSettings.Ports["5432/tcp"][0].HostIp = "0.0.0.0"; },
  "changed loopback target": s => { s.container.NetworkSettings.Ports["5432/tcp"][0].HostPort = "49101"; },
  "external network": s => { s.network.Internal = false; },
  "foreign network member": s => { s.network.Containers["a".repeat(64)] = {}; },
  "changed credentials": s => { s.container.Config.Env = s.container.Config.Env.map(v => v.startsWith("POSTGRES_USER=") ? "POSTGRES_USER=persistent" : v); },
  "persistent database identity": s => { s.badDatabase = true; },
  "wrong role identity": s => { s.badRole = true; },
  "wrong PostgreSQL version": s => { s.badVersion = true; },
  "another server on loopback": s => { s.changedServer = true; },
  "stopped process": s => { s.container.State.Running = false; },
  "wrong entrypoint": s => { s.container.Path = "unexpected"; },
  "runtime modified": s => { s.runtimeChanged = true; },
  "Docker introspection failure": s => { s.dockerError = true; },
};
for (const [label, change] of Object.entries(negatives)) test("fail-closed: " + label + " yields zero sensitive child spawns", async () => {
  const f = fixture(), h = await f.harness(); await h.create(); change(f.state);
  await assert.rejects(h.run("seed")); assert.equal(f.state.children.length, 0);
  assert.equal(h.receipt().firstWriterPreflight, false); await h.close();
});
test("unknown command and shell injection are refused before spawning", async () => {
  const f = fixture(), h = await f.harness(); await h.create();
  for (const role of ["db:reset", "seed && destructive", "/arbitrary", "test:e2e"]) await assert.rejects(h.run(role), fail("COMMAND_NOT_ALLOWLISTED"));
  assert.equal(f.state.children.length, 0); await h.close();
});
test("an existing HTTP server is rejected before canonical E2E can write to it", async () => {
  const f = fixture(), h = await f.harness(); await h.create(); f.state.portBusy = true;
  await assert.rejects(h.run("e2e-core"), fail("APPLICATION_PORT_NOT_FREE"));
  assert.equal(f.state.children.length, 0); await h.close();
});
test("abort before first writer yields zero child spawn and still allows owned teardown", async () => {
  const f = fixture(), controller = new AbortController(), h = await f.harness({ signal: controller.signal });
  await h.create(); controller.abort(); await assert.rejects(h.run("seed"), fail("ABORTED_BEFORE_PREFLIGHT"));
  assert.equal(f.state.children.length, 0); assert.equal(await h.close(), true);
});
test("failed child and changed source are recorded without another command", async () => {
  for (const mode of ["exitCode", "changeSource"]) {
    const f = fixture(), h = await f.harness(); await h.create(); f.state[mode] = mode === "exitCode" ? 7 : true;
    await assert.rejects(h.run("build")); assert.equal(f.state.children.length, 1); assert.equal(h.receipt().commands.length, 1); await h.close();
  }
});
test("incomplete teardown is recorded and never forces foreign cleanup", async () => {
  const f = fixture(), h = await f.harness(); await h.create(); f.state.container.Config.Labels["piccadilly.owner"] = "foreign";
  assert.equal(await h.close(), false); assert.equal(f.state.exists, true);
  assert.equal(f.state.calls.some(args => args[0] === "rm"), false);
  assert.equal(h.receipt().teardown.complete, false);
});
test("build/seed/E2E plan uses individual guarded roles, never the unsafe composite", () => {
  assert.ok(PLANS.core.indexOf("build") < PLANS.core.indexOf("seed")); assert.ok(PLANS.core.indexOf("seed") < PLANS.core.indexOf("e2e-core"));
  const defs = commandDefinitions(fixture().runtime);
  assert.ok(Object.values(defs).every(args => !args.includes("test:e2e") && !args.includes("db:reset")));
});
test("CLI rejects alternative URL, command and unknown flags before any infrastructure", async () => {
  for (const args of [["run", "--database-url", "postgresql://synthetic.invalid/persistent"], ["run", "--command", "seed"], ["unknown"], ["run", "--plan"]]) await assert.rejects(main(args));
});
test("actual harmless child exit code is preserved", async () => {
  const result = await lifecycleProbe("exit"); assert.equal(result.exitCode, 7); assert.equal(result.reason, null); assert.equal(result.joined, true); assert.equal(result.executable, process.execPath);
  console.info("M13_P1_PROCESS_PROBE " + JSON.stringify({ probe: "exit", ...result }));
});
test("actual deadline stops and joins only the spawned process tree", async () => {
  const result = await lifecycleProbe("tree", { deadlineMs: 200 }); assert.equal(result.reason, "CHILD_DEADLINE"); assert.equal(result.joined, true); assert.notEqual(result.exitCode, 0);
  console.info("M13_P1_PROCESS_PROBE " + JSON.stringify({ probe: "deadline-tree", ...result }));
});
test("actual abort stops and joins the owned child", async () => {
  const controller = new AbortController(); const pending = lifecycleProbe("wait", { signal: controller.signal, deadlineMs: 10_000 });
  setTimeout(() => controller.abort(), 150); const result = await pending; assert.equal(result.reason, "ABORTED_AFTER_SPAWN"); assert.equal(result.joined, true);
  console.info("M13_P1_PROCESS_PROBE " + JSON.stringify({ probe: "abort", ...result }));
});

function bindingFixture() {
  return { HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } }, NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49100" }] } } };
}
test("D1 single dynamic loopback binding is positively correlated to its request", () => {
  const result = inspectDockerBinding(bindingFixture());
  assert.equal(result.classification, "METADATA_CORRELATED"); assert.equal(result.code, null);
  assert.deepEqual(result.candidateMapping, { HostIp: "127.0.0.1", HostPort: "49100", containerPort: "5432/tcp" });
});
for (const missing of [{ "5432/tcp": [] }, { "5432/tcp": null }, {}]) test("D1 D0 missing publication stays blocked: " + JSON.stringify(missing), () => {
  const container = bindingFixture(); container.NetworkSettings.Ports = missing;
  const result = inspectDockerBinding(container);
  assert.equal(result.code, "PORT_BINDING_NOT_PUBLISHED"); assert.equal(result.classification, "REJECTED"); assert.equal(result.candidateMapping, null);
  assert.deepEqual(result.networkSettingsPorts, missing);
});
const bindingCases = {
  "two identical mappings": c => { c.NetworkSettings.Ports["5432/tcp"].push({ HostIp: "127.0.0.1", HostPort: "49100" }); },
  "additional port": c => { c.NetworkSettings.Ports["5433/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "49101" }]; },
  "IPv4 wildcard": c => { c.NetworkSettings.Ports["5432/tcp"][0].HostIp = "0.0.0.0"; },
  "IPv6 wildcard": c => { c.NetworkSettings.Ports["5432/tcp"][0].HostIp = "::"; },
  "different loopback interface": c => { c.NetworkSettings.Ports["5432/tcp"][0].HostIp = "127.0.0.2"; },
  "requested wildcard": c => { c.HostConfig.PortBindings["5432/tcp"][0].HostIp = "0.0.0.0"; },
  "missing requested config": c => { c.HostConfig.PortBindings = {}; },
  "multiple requested bindings": c => { c.HostConfig.PortBindings["5432/tcp"].push({ HostIp: "127.0.0.1", HostPort: "" }); },
  "unapproved fixed port config": c => { c.HostConfig.PortBindings["5432/tcp"][0].HostPort = "49100"; },
  "invalid effective port": c => { c.NetworkSettings.Ports["5432/tcp"][0].HostPort = "65536"; },
  "null mapping row": c => { c.NetworkSettings.Ports["5432/tcp"][0] = null; },
};
for (const [label, change] of Object.entries(bindingCases)) test("D1 rejects " + label + " without selecting an endpoint", () => {
  const container = bindingFixture(); change(container); const result = inspectDockerBinding(container);
  assert.equal(result.classification, "REJECTED"); assert.equal(result.candidateMapping, null);
});
for (const output of ["127.0.0.1:49101", "0.0.0.0:49100", "[::]:49100", "127.0.0.1:49100\n127.0.0.1:49100"]) test("D1 Docker publication mismatch produces zero sensitive spawns: " + JSON.stringify(output), async () => {
  const f = fixture(), h = await f.harness(); await h.create(); f.state.publicationOutput = output;
  await assert.rejects(h.run("seed"), fail("PORT_ENDPOINT_MISMATCH")); assert.equal(f.state.children.length, 0);
  assert.equal(h.receipt().events.findLast(e => e.kind === "publication-observed").selectedMapping, null); await h.close();
});
test("D1 container network endpoint mismatch produces zero sensitive spawns", async () => {
  const f = fixture(), h = await f.harness(); await h.create(); f.state.container.NetworkSettings.Networks.internal.NetworkID = "a".repeat(64);
  await assert.rejects(h.run("seed"), fail("NETWORK_TARGET_MISMATCH")); assert.equal(f.state.children.length, 0); await h.close();
});
test("D1 unavailable Docker port check never becomes a positive preflight", async () => {
  const f = fixture(), h = await f.harness(); await h.create(); f.state.publicationUnavailable = true;
  await assert.rejects(h.run("seed"), fail("PORT_PUBLICATION_NOT_VERIFIABLE")); assert.equal(f.state.children.length, 0); await h.close();
});
test("D1 close is idempotent including concurrent requests after successful teardown", async () => {
  const f = fixture(), h = await f.harness(); await h.create();
  assert.deepEqual(await Promise.all([h.close(), h.close()]), [true, true]); assert.equal(await h.close(), true);
  assert.equal(f.state.calls.filter(args => args[0] === "rm").length, 1);
  assert.equal(f.state.calls.filter(args => args[0] === "network" && args[1] === "rm").length, 1);
  assert.equal(h.receipt().events.filter(e => e.kind === "teardown").length, 1);
});
test("D1 unsuccessful close stays unsuccessful and records its cause", async () => {
  const f = fixture(), h = await f.harness(); await h.create(); f.state.failRemoval = true;
  assert.equal(await h.close(), false); assert.equal(await h.close(), false); assert.equal(f.state.exists, true);
  assert.equal(h.receipt().teardown.complete, false);
  assert.equal(h.receipt().events.findLast(e => e.kind === "teardown-incomplete").code, "INFRASTRUCTURE_INTROSPECTION_UNAVAILABLE");
});
test("D1 network removal is not certified until absence is observed", async () => {
  const f = fixture(), h = await f.harness(); await h.create(); f.state.networkRemains = true;
  assert.equal(await h.close(), false); assert.equal(h.receipt().teardown.complete, false);
  assert.equal(h.receipt().events.findLast(e => e.kind === "teardown-incomplete").code, "NETWORK_TEARDOWN_INCOMPLETE");
});
test("D1 real D0 shape preserves primary failure through create cleanup and second close", async () => {
  const f = fixture(), original = f.adapter.docker;
  f.adapter.docker = async (args, env) => { const value = await original(args, env); if (args[0] === "start") f.state.container.NetworkSettings.Ports["5432/tcp"] = []; return value; };
  const h = await f.harness(); let primary;
  try { await h.create(); } catch (error) { primary = error; }
  assert.equal(primary.code, "PORT_BINDING_NOT_PUBLISHED");
  const result = await finishOwnedRun(h, primary);
  assert.equal(result.error, primary); assert.equal(result.cleanupStatus, "COMPLETE"); assert.equal(result.complete, true);
  assert.equal(result.receipt.primaryFailure.code, "PORT_BINDING_NOT_PUBLISHED"); assert.equal(result.receipt.teardown.complete, true);
  assert.equal(f.state.children.length, 0);
  const rejected = result.receipt.events.find(e => e.kind === "resource-rejected");
  assert.deepEqual(rejected.binding.networkSettingsPorts, { "5432/tcp": [] });
  assert.deepEqual(rejected.binding.hostConfigPortBindings, { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] });
  assert.ok(!JSON.stringify(result.receipt).includes(f.state.config.POSTGRES_PASSWORD));
  console.info("M13_P1_D1_PRIMARY " + JSON.stringify({ primary: primary.code, cleanup: result.cleanupStatus, childCount: f.state.children.length, binding: rejected.binding }));
});
test("D1 primary error and genuinely incomplete cleanup remain independently visible", async () => {
  const f = fixture(), h = await f.harness(); await h.create(); f.state.failRemoval = true;
  const primary = new SafetyError("SYNTHETIC_PRIMARY"); const result = await finishOwnedRun(h, primary);
  assert.equal(result.error, primary); assert.equal(result.cleanupStatus, "INCOMPLETE"); assert.equal(result.receipt.teardown.complete, false);
  assert.equal(result.receipt.primaryFailure.code, "SYNTHETIC_PRIMARY"); assert.equal(f.state.children.length, 0);
});
test("D1 incomplete cleanup without a primary error remains blocking", async () => {
  const f = fixture(), h = await f.harness(); await h.create(); f.state.failRemoval = true;
  const result = await finishOwnedRun(h); assert.equal(result.error.code, "TEARDOWN_INCOMPLETE"); assert.equal(result.cleanupStatus, "INCOMPLETE");
});
test("D1 failure before harness creation needs no unknown-resource cleanup", async () => {
  const primary = new SafetyError("INFRASTRUCTURE_INTROSPECTION_UNAVAILABLE"); const result = await finishOwnedRun(undefined, primary);
  assert.equal(result.error, primary); assert.equal(result.cleanupStatus, "NOT_REQUIRED");
});

function proxyFixture() {
  const state = { containers: {}, networks: {}, children: [], calls: [], phase: "provision", identity: {} };
  const ids = { backend: "d".repeat(64), frontend: "e".repeat(64), postgres: "c".repeat(64), haproxy: "b".repeat(64) };
  const runtime = { directory: dirname(process.execPath), npmCli: "/synthetic/npm-cli.js", receipt: { simulation: true, nodePinPass: false }, assertLive: async () => { if (state.badRuntime) throw new SafetyError("RUNTIME_CHANGED"); } };
  const labels = args => Object.fromEntries(args.flatMap((v, i) => v === "--label" ? [args[i + 1].split("=")] : []));
  const get = (args, flag) => args[args.indexOf(flag) + 1];
  const rows = (args, flag) => args.flatMap((v, i) => v === flag ? [args[i + 1]] : []);
  const identity = (lease, clientAddress) => ({ database: lease.database, role: lease.role, version: "18.4", dataDirectory: "/var/lib/postgresql/18/docker", systemIdentifier: "123456", postmasterStart: "2026-11-03 00:00:00+00", serverAddress: "172.20.0.2", clientAddress, serverPort: 5432, ...state.identity });
  const backend = {
    simulation: true,
    budget: async () => { if (state.badBudget) throw new SafetyError("DOCKER_MEMORY_INSUFFICIENT"); return { status: "PASS_REPORTED_ONLY" }; },
    selectPort: async () => ({ port: state.collision ? 5432 : 49100, apiCloseCompleted: !state.socketOpen, closedBeforeDockerCreate: true, kernelRaceExcluded: false }),
    config: async (_id, content) => { state.content = content; return { sha256: createHash("sha256").update(content).digest("hex"), mode: "0444", uid: 0, regular: true }; },
    hostIdentity: async lease => { state.lease = lease; return identity(lease, "172.20.0.3"); },
    sessionCensus: async (lease, name) => ({ identity: identity(lease, "172.20.0.2"), monitor: { pid: 999, backendStart: "2026-11-03 00:00:01+00", applicationName: name, readOnly: "on" }, clients: [{ pid: 999, backendStart: "2026-11-03 00:00:01+00", database: lease.database, role: lease.role, applicationName: name, backendType: "client backend", state: "active", transactionOpen: true }, ...(state.quietRows ?? [])], sameRoleNonClients: [] }),
    monitor: async (_lease, notify) => { state.notify = notify; return { ready: async () => {}, assertLive: () => { if (state.monitorDead) throw new SafetyError("EVENT_STREAM_CLOSED"); }, close: async () => {} }; },
    source: async () => ({ files: 480, freeze: "same" }), applicationPort: async () => {},
    child: async (args, env) => { state.children.push({ args, env }); return { exitCode: 0, reason: null, joined: true, executable: process.execPath }; },
    docker: async (args, extra = {}) => {
      state.calls.push(args);
      if (args[0] === "image") {
        const role = args.at(-1).startsWith("postgres") ? "postgres" : "haproxy", pin = D6_PINS[role];
        return JSON.stringify([{ Id: pin.config, Os: "linux", Architecture: "amd64", RepoDigests: [role + "@" + pin.index] }]);
      }
      if (args[0] === "network" && args[1] === "create") {
        const role = labels(args)["piccadilly.role"], id = ids[role];
        state.networks[id] = { Id: id, Created: "created-" + role, Driver: "bridge", Internal: role === "backend", EnableIPv6: false, Labels: labels(args), Options: role === "backend" ? { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" } : {}, Containers: {} }; return id;
      }
      if (args[0] === "network" && args[1] === "inspect") return JSON.stringify([state.networks[args[2]]]);
      if (args[0] === "create") {
        const role = labels(args)["piccadilly.role"], id = ids[role], pin = D6_PINS[role];
        const env = rows(args, "--env").map(s => s === "POSTGRES_PASSWORD" ? s + "=" + extra.POSTGRES_PASSWORD : s);
        state.containers[id] = { Id: id, Created: "created-" + role, Image: pin.config, Path: "docker-entrypoint.sh", Args: role === "postgres" ? ["postgres"] : ["haproxy", "-f", "/usr/local/etc/haproxy/haproxy.cfg"], Config: { Labels: labels(args), Image: pin.config, Env: env, User: role === "haproxy" ? "99:99" : "" }, HostConfig: { Memory: Number(get(args, "--memory")), MemorySwap: Number(get(args, "--memory-swap")), Binds: [], Tmpfs: Object.fromEntries(rows(args, "--tmpfs").map(s => { const i = s.indexOf(":"); return [s.slice(0, i), s.slice(i + 1)]; })), PortBindings: role === "haproxy" ? { "15432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49100" }] } : {}, CapDrop: role === "haproxy" ? ["ALL"] : [], SecurityOpt: role === "haproxy" ? ["no-new-privileges"] : [] }, Mounts: [], State: { Running: false, Pid: role === "postgres" ? 100 : 101, StartedAt: "2026-11-03T00:00:00Z" }, NetworkSettings: { Networks: {}, Ports: {} } }; return id;
      }
      if (args[0] === "inspect") return JSON.stringify([state.containers[args[1]]]);
      if (args[0] === "start") {
        const c = state.containers[args[1]], role = c.Config.Labels["piccadilly.role"]; c.State.Running = true;
        for (const name of role === "postgres" ? ["backend"] : ["frontend", "backend"]) {
          c.NetworkSettings.Networks[name] = { NetworkID: ids[name], IPAddress: role === "postgres" ? "172.20.0.2" : name === "backend" ? "172.20.0.3" : "172.21.0.2", Gateway: name === "backend" ? "" : "172.21.0.1" };
          state.networks[ids[name]].Containers[c.Id] = {};
        }
        c.NetworkSettings.Ports = c.HostConfig.PortBindings; return c.Id;
      }
      if (args[0] === "port") return state.portOutput ?? "127.0.0.1:49100";
      if (args[0] === "exec") {
        if (args.includes("sha256sum")) return createHash("sha256").update(state.content).digest("hex") + "  config";
        if (args.includes("stat")) return "0:0:444";
        if (args.includes("/proc/mounts")) return "tmpfs /var/lib/postgresql tmpfs rw,size=1048576k 0 0\ntmpfs /run/haproxy tmpfs rw,size=16384k 0 0";
        if (args.includes("/proc/net/route")) return "Iface Destination Gateway Flags";
        if (args.includes("/proc/sys/net/ipv4/ip_forward")) return "0";
        if (args.includes("/sys/fs/cgroup/memory.max")) return String(args.includes(ids.postgres) ? D6_PROFILE.pgMemory : D6_PROFILE.proxyMemory);
        if (args.includes("/sys/fs/cgroup/memory.swap.max")) return "0";
        if (args.includes("/proc/1/status")) return "Uid:\t99\t99\t99\t99\nGid:\t99\t99\t99\t99\nCapEff:\t0000000000000000\nNoNewPrivs:\t1";
        if (args.includes("/proc/1/cmdline")) return "haproxy\0-W\0-db\0-f\0/usr/local/etc/haproxy/haproxy.cfg";
        if (args.includes("socat") || args.includes("sh")) return "1\n# be_name srv_name srv_addr\nowned_back owned_pg 172.20.0.2";
        if (args.includes("psql")) {
          if (args.at(-1).startsWith("SELECT count")) return state.notQuiet ? "1" : "0";
          const pg = state.containers[ids.postgres], env = Object.fromEntries(pg.Config.Env.map(s => { const i = s.indexOf("="); return [s.slice(0, i), s.slice(i + 1)]; }));
          return JSON.stringify(identity({ database: env.POSTGRES_DB, role: env.POSTGRES_USER }, "172.20.0.2"));
        }
      }
      if (args[0] === "stop") { state.containers[args.at(-1)].State.Running = false; return args.at(-1); }
      if (args[0] === "rm") {
        if (state.failRemoval) throw new SafetyError("CONTAINER_TEARDOWN_INCOMPLETE");
        for (const n of Object.values(state.networks)) delete n.Containers[args[1]];
        delete state.containers[args[1]]; return args[1];
      }
      if (args[0] === "ps") return state.containers[args.at(-1).slice(3)] ? args.at(-1).slice(3) : "";
      if (args[0] === "network" && args[1] === "rm") { delete state.networks[args[2]]; return args[2]; }
      if (args[0] === "network" && args[1] === "ls") return state.networks[args.at(-1).slice(3)] ? args.at(-1).slice(3) : "";
      throw Error("Unexpected D6 fake operation: " + args[0]);
    },
  };
  return { state, ids, backend, async harness() { return createProxyRunHarness({ runtime, adapters: backend, evidenceDirectory: tmpdir() }); } };
}
test("D6 config has a single numeric backend and root-owned read-only transfer archive", () => {
  const content = proxyConfiguration("172.20.0.2"), tar = proxyConfigArchive(content);
  assert.equal((content.match(/server owned_pg /gu) ?? []).length, 1); assert.ok(content.includes("172.20.0.2:5432"));
  assert.equal(parseInt(tar.subarray(100, 108).toString(), 8), 0o444); assert.equal(parseInt(tar.subarray(108, 116).toString(), 8), 0);
  assert.equal(tar.subarray(512, 512 + Buffer.byteLength(content)).toString(), content);
  for (const target of ["127.0.0.1", "host.invalid", "172.20.0.2;command", "999.0.0.1"]) assert.throws(() => proxyConfiguration(target));
});
test("D6 positive chain proves both containers and tears down every exact ID once", async () => {
  const f = proxyFixture(), h = await f.harness(); const proof = await h.create();
  assert.equal(proof.status, "PASS_REPORTED_ONLY"); assert.equal(proof.valid, true);
  assert.equal(h.receipt().positiveOwnership, false); // Simulations never certify real ownership.
  for (const role of ["build", "migrate", "seed"]) await h.run(role);
  assert.equal(f.state.children.length, 3);
  assert.deepEqual(await Promise.all([h.close(), h.close()]), [true, true]); assert.equal(await h.close(), true);
  assert.equal(f.state.calls.filter(a => a[0] === "rm").length, 2); assert.equal(f.state.calls.filter(a => a[0] === "network" && a[1] === "rm").length, 2);
  assert.equal(Object.keys(f.state.containers).length, 0); assert.equal(Object.keys(f.state.networks).length, 0);
});
const d6Negatives = {
  "PG frontend attachment": f => { f.state.containers[f.ids.postgres].NetworkSettings.Networks.frontend = { NetworkID: f.ids.frontend }; },
  "PG host publication": f => { f.state.containers[f.ids.postgres].HostConfig.PortBindings = { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5432" }] }; },
  "backend without isolated": f => { f.state.networks[f.ids.backend].Options = {}; },
  "external backend": f => { f.state.networks[f.ids.backend].Internal = false; },
  "IPv6 enabled": f => { f.state.networks[f.ids.backend].EnableIPv6 = true; },
  "foreign network member": f => { f.state.networks[f.ids.backend].Containers["a".repeat(64)] = {}; },
  "wrong container": f => { f.state.containers[f.ids.postgres].Id = "a".repeat(64); },
  "stale resource": f => { f.state.containers[f.ids.postgres].State.StartedAt = "changed"; },
  "memory budget": f => { f.state.containers[f.ids.postgres].HostConfig.Memory++; },
  "persistent mount": f => { f.state.containers[f.ids.postgres].Mounts = [{ Type: "volume", Destination: "/var/lib/postgresql" }]; },
  "privileged proxy": f => { f.state.containers[f.ids.haproxy].HostConfig.Privileged = true; },
  "root proxy": f => { f.state.containers[f.ids.haproxy].Config.User = "0:0"; },
  "capability added": f => { f.state.containers[f.ids.haproxy].HostConfig.CapAdd = ["NET_ADMIN"]; },
  "wildcard binding": f => { f.state.containers[f.ids.haproxy].NetworkSettings.Ports["15432/tcp"][0].HostIp = "0.0.0.0"; },
  "missing effective binding": f => { f.state.containers[f.ids.haproxy].NetworkSettings.Ports = { "15432/tcp": [] }; },
  "unexpected published endpoint": f => { f.state.portOutput = "127.0.0.1:49101"; },
  "proxy configuration changed": f => { f.state.content += "backend other\n"; },
  "wrong database": f => { f.state.identity.database = "wrong"; },
  "wrong role": f => { f.state.identity.role = "wrong"; },
  "cluster replaced": f => { f.state.identity.systemIdentifier = "999999"; },
  "postmaster changed": f => { f.state.identity.postmasterStart = "2026-11-03 01:00:00+00"; },
  "event stream lost": f => { f.state.monitorDead = true; },
  "runtime changed": f => { f.state.badRuntime = true; },
};
for (const [name, change] of Object.entries(d6Negatives)) test("D6 fail closed zero writer: " + name, async () => {
  const f = proxyFixture(), h = await f.harness(); await h.create(); change(f);
  await assert.rejects(h.run("seed")); assert.equal(f.state.children.length, 0); assert.equal(h.receipt().firstWriterPreflight, false);
  assert.ok(h.receipt().events.some(e => e.kind === "lease-revoked")); await h.close();
});
test("D6 Docker event revokes the lease before dispatch", async () => {
  const f = proxyFixture(), h = await f.harness(); await h.create(); f.state.notify({ id: f.ids.postgres, action: "restart" });
  await assert.rejects(h.run("seed")); assert.equal(f.state.children.length, 0); await h.close();
});
for (const mode of ["badBudget", "collision", "socketOpen"]) test("D6 " + mode + " blocks before a sensitive child", async () => {
  const f = proxyFixture(); f.state[mode] = true; const h = await f.harness(); await assert.rejects(h.create());
  assert.equal(f.state.children.length, 0); assert.equal(await h.close(), true);
});
test("D6 incomplete close remains false and retains primary failure", async () => {
  const f = proxyFixture(), h = await f.harness(); await h.create(); f.state.failRemoval = true;
  const primary = new SafetyError("PRIMARY_SYNTHETIC"); const result = await finishOwnedRun(h, primary);
  assert.equal(result.error, primary); assert.equal(result.cleanupStatus, "INCOMPLETE"); assert.equal(await h.close(), false);
});
test("D6 nested runner cannot redirect maintenance or child database endpoint", () => {
  const sourceUrl = new URL("postgresql://127.0.0.1:49100/synthetic_source"), targetUrl = new URL(sourceUrl), maintenanceUrl = new URL(sourceUrl);
  const targetDatabaseName = "piccadilly_vitest_0123456789abcdef0123456789abcdef";
  targetUrl.pathname = "/" + targetDatabaseName; maintenanceUrl.pathname = "/postgres";
  const context = { phase: "vitest:create", plan: { sourceUrl, targetUrl, maintenanceUrl, targetDatabaseName } };
  assert.doesNotThrow(() => assertD6RunnerTarget({ url: sourceUrl.href }, context));
  for (const which of [targetUrl, maintenanceUrl]) { which.port = "5432"; assert.throws(() => assertD6RunnerTarget({ url: sourceUrl.href }, context), fail("RUNNER_DATABASE_MISMATCH")); which.port = "49100"; }
});

function d8Fixture() {
  const f = proxyFixture(); f.state.ms = 0; f.state.controls = []; f.backend.now = () => f.state.ms;
  const original = f.backend.docker;
  f.backend.docker = async (args, extra, control) => { f.state.controls.push({ args, timeoutMs: control?.timeoutMs, remainingMs: control?.remainingMs }); return original(args, extra, control); };
  return f;
}
function noWriter(f, h) {
  assert.equal(f.state.children.length, 0); assert.equal(h.receipt().firstWriterPreflight, false);
  assert.equal(h.receipt().positiveOwnership, false);
}

test("D8 TIME01 global monotonic deadline is shared and not reset by operations", async () => {
  let clock = 0; const events = [], b = new MonotonicBudget({ durationMs: 30_000, code: "TOPOLOGY_BOOTSTRAP_TIMEOUT", now: () => clock, record: (kind, value) => events.push({ kind, ...value }) });
  try {
    await b.run("first", 15_000, async () => { clock = 12_000; });
    await b.run("second", 15_000, async () => { clock = 26_000; });
    await assert.rejects(b.run("third", 15_000, async c => { assert.equal(c.timeoutMs, 4_000); clock = 30_000; }), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT"));
    assert.equal(events.filter(e => e.kind === "operation-start").length, 3);
  } finally { b.dispose(); }
});
test("D8 TIME02 effective timeout never exceeds current remaining time", async () => {
  let clock = 0; const b = new MonotonicBudget({ durationMs: 30_000, code: "TOPOLOGY_BOOTSTRAP_TIMEOUT", now: () => clock });
  try { clock = 29_250; await b.run("query", 5_000, async c => { assert.equal(c.timeoutMs, 750); clock = 29_900; assert.equal(c.effectiveTimeout(), 100); }); } finally { b.dispose(); }
});
test("D8 TIME03 no new operation after expiry, even if wall time would change", async () => {
  let clock = 0, operations = 0; const b = new MonotonicBudget({ durationMs: 30_000, code: "TOPOLOGY_BOOTSTRAP_TIMEOUT", now: () => clock });
  try { clock = 30_001; await assert.rejects(b.run("forbidden", 15_000, async () => operations++), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); assert.equal(operations, 0); } finally { b.dispose(); }
});
test("D8 TIME04 timeout in last optional diagnostic never becomes READY", async () => {
  const f = d8Fixture(), raw = f.backend.docker; let diagnostics = 0;
  f.backend.docker = async (args, extra, c) => { if (args.includes("sh") && ++diagnostics === 2) { f.state.ms = 30_001; throw new SafetyError("TOPOLOGY_BOOTSTRAP_TIMEOUT"); } return raw(args, extra, c); };
  const h = await f.harness(); await assert.rejects(h.create(), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); noWriter(f, h);
  assert.equal(h.receipt().events.some(e => e.kind === "preflight-positive"), false); assert.equal(await h.close(), true);
});
test("D8 TIME05 diagnostic timeout remains primary when cleanup also fails", async () => {
  const f = d8Fixture(), raw = f.backend.docker;
  f.backend.docker = async (args, extra, c) => { if (args.includes("sh")) { f.state.failRemoval = true; throw new SafetyError("TOPOLOGY_BOOTSTRAP_TIMEOUT"); } return raw(args, extra, c); };
  const h = await f.harness(); let primary;
  try { await h.create(); } catch (error) { primary = error; }
  const result = await finishOwnedRun(h, primary); assert.equal(result.error.code, "TOPOLOGY_BOOTSTRAP_TIMEOUT"); assert.equal(result.cleanupStatus, "INCOMPLETE"); noWriter(f, h);
});
test("D8 permitted diagnostic unavailability stays distinct from timeout", async () => {
  const f = d8Fixture(), raw = f.backend.docker;
  f.backend.docker = async (args, extra, c) => { if (args.includes("sh")) throw new SafetyError("DIAGNOSTIC_UNAVAILABLE"); return raw(args, extra, c); };
  const h = await f.harness(); await h.create(); assert.ok(h.receipt().events.some(e => e.kind === "proxy-diagnostic" && e.status === "NOT_VERIFIABLE")); await h.close();
});
test("D8 PROC06 late network ID is recorded before post-deadline rejection", async () => {
  const f = d8Fixture(), raw = f.backend.docker;
  f.backend.docker = async (args, extra, c) => { const result = await raw(args, extra, c); if (args[0] === "network" && args[1] === "create") f.state.ms = 30_001; return result; };
  const h = await f.harness(); await assert.rejects(h.create(), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); noWriter(f, h);
  assert.equal(h.receipt().creationAttempts[0].outcome, "ABSENCE_VERIFIED"); assert.equal(await h.close(), true); assert.equal(Object.keys(f.state.networks).length, 0);
});
test("D8 PROC07 confirmed rejected late create without resource has no invented residual", async () => {
  const f = d8Fixture(), raw = f.backend.docker;
  f.backend.docker = async (args, extra, c) => { if (args[0] === "network" && args[1] === "create") { f.state.ms = 30_001; throw Object.assign(new SafetyError("INFRASTRUCTURE_COMMAND_TIMEOUT"), { joined: true, requestRejected: true, resourceAbsentConfirmed: true }); } return raw(args, extra, c); };
  const h = await f.harness(); await assert.rejects(h.create(), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); noWriter(f, h); assert.equal(h.receipt().creationAttempts[0].outcome, "NO_RESOURCE_CONFIRMED"); assert.equal(await h.close(), true);
});
test("D8 PROC08 interrupted create with retained stdout ID is reconciled safely", async () => {
  const f = d8Fixture(), raw = f.backend.docker;
  f.backend.docker = async (args, extra, c) => { const value = await raw(args, extra, c); if (args[0] === "create") { f.state.ms = 30_001; throw Object.assign(new SafetyError("INFRASTRUCTURE_COMMAND_TIMEOUT"), { stdout: value, joined: true, processStarted: true }); } return value; };
  const h = await f.harness(); await assert.rejects(h.create(), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); noWriter(f, h); assert.equal(await h.close(), true); assert.equal(Object.keys(f.state.containers).length, 0);
});
test("D8 PROC08 late owned CID receipt can recover an ID omitted from stdout", async () => {
  const f = d8Fixture(), raw = f.backend.docker; let lateId;
  f.backend.docker = async (args, extra, c) => { const value = await raw(args, extra, c); if (args[0] === "create") { lateId = value; f.state.ms = 30_001; throw Object.assign(new SafetyError("INFRASTRUCTURE_COMMAND_TIMEOUT"), { joined: true, processStarted: true }); } return value; };
  f.backend.recoverCreation = async () => ({ id: lateId, source: "OWNED_CREATE_CIDFILE" });
  const h = await f.harness(); await assert.rejects(h.create(), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); noWriter(f, h); assert.equal(await h.close(), true); assert.equal(Object.keys(f.state.containers).length, 0);
});
test("D8 PROC09 uncertain create is never adopted from matching name or labels", async () => {
  const f = d8Fixture(), raw = f.backend.docker; let hiddenId;
  f.backend.docker = async (args, extra, c) => {
    if (args[0] === "network" && args[1] === "ls" && args.at(-1).startsWith("label=")) return hiddenId;
    const value = await raw(args, extra, c); if (args[0] === "network" && args[1] === "create") { hiddenId = value; f.state.ms = 30_001; throw Object.assign(new SafetyError("INFRASTRUCTURE_COMMAND_TIMEOUT"), { joined: true, processStarted: true }); } return value;
  };
  const h = await f.harness(); await assert.rejects(h.create(), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); noWriter(f, h); assert.equal(await h.close(), false);
  assert.equal(h.receipt().creationAttempts[0].outcome, "UNCERTAIN"); assert.ok(f.state.networks[hiddenId]); assert.equal(f.state.calls.filter(a => a[0] === "network" && a[1] === "rm").length, 0);
});
test("D8 PROC09 recovered ID with wrong ownership is never removed", async () => {
  const f = d8Fixture(), raw = f.backend.docker; let lateId;
  f.backend.docker = async (args, extra, c) => { const value = await raw(args, extra, c); if (args[0] === "create") { lateId = value; f.state.containers[value].Config.Labels["piccadilly.attempt"] = "unrelated"; f.state.ms = 30_001; throw Object.assign(new SafetyError("INFRASTRUCTURE_COMMAND_TIMEOUT"), { stdout: value, joined: true }); } return value; };
  const h = await f.harness(); await assert.rejects(h.create(), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); noWriter(f, h); assert.equal(await h.close(), false); assert.ok(f.state.containers[lateId]); assert.equal(f.state.calls.filter(a => a[0] === "rm").length, 0);
});
test("D8 PROC10 abort stops and joins the actual adapter child, retaining late stdout", async () => {
  const abort = new AbortController(), child = new EventEmitter(); child.pid = 12345; child.exitCode = null; child.signalCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough(); let killed = 0;
  child.kill = () => { killed++; queueMicrotask(() => { child.stdout.write("c".repeat(64)); child.exitCode = 0; child.emit("close", 0); }); return true; };
  const result = runInfrastructureProcess("synthetic.exe", [], { environment: {}, timeoutMs: 1000, signal: abort.signal, spawnProcess: () => child });
  abort.abort(new SafetyError("TOPOLOGY_BOOTSTRAP_TIMEOUT")); await assert.rejects(result, error => { assert.equal(error.code, "TOPOLOGY_BOOTSTRAP_TIMEOUT"); assert.equal(error.joined, true); assert.equal(error.stdout, "c".repeat(64)); return true; }); assert.equal(killed, 1);
});
test("D8 PROC11 bootstrap expiry does not block owned teardown or change stop caps", async () => {
  const f = d8Fixture(), raw = f.backend.docker;
  f.backend.docker = async (args, extra, c) => { if (args.includes("sh")) { f.state.ms = 30_001; throw new SafetyError("TOPOLOGY_BOOTSTRAP_TIMEOUT"); } return raw(args, extra, c); };
  const h = await f.harness(); await assert.rejects(h.create(), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); noWriter(f, h); assert.equal(await h.close(), true);
  for (const c of f.state.controls.filter(c => c.args[0] === "stop")) { const approved = Number(c.args[2]) * 1000; assert.ok([D8_LIMITS.proxyStopMs, D8_LIMITS.postgresStopMs].includes(approved)); assert.ok(c.timeoutMs <= approved && c.timeoutMs <= c.remainingMs); }
});
test("D8 PROC12 concurrent and subsequent close preserve the verified late-create result", async () => {
  const f = d8Fixture(), h = await f.harness(); await h.create(); const before = f.state.calls.length;
  const [first, second] = await Promise.all([h.close(), h.close()]); const after = f.state.calls.length; assert.equal(first, true); assert.equal(second, true); assert.equal(await h.close(), true); assert.equal(f.state.calls.length, after); assert.ok(after > before);
});
test("D8 OWN07 stale server identity never reuses the prior positive proof", async () => {
  const f = d8Fixture(), h = await f.harness(); await h.create(); f.state.identity.systemIdentifier = "999"; await assert.rejects(h.run("seed")); noWriter(f, h); await h.close();
});
test("D8 OWN08 role timeout prevents dispatch after prior bootstrap PASS", async () => {
  const f = d8Fixture(), raw = f.backend.docker, h = await f.harness(); await h.create();
  f.backend.docker = async (args, extra, c) => { if (args.includes("sh")) f.state.ms += 1_800_001; return raw(args, extra, c); };
  await assert.rejects(h.run("seed"), fail("ROLE_DEADLINE")); noWriter(f, h); await h.close();
});
test("D8 EVID02 receipt has monotonic phase timing and bounded effective command time", async () => {
  const f = d8Fixture(), raw = f.backend.docker; f.backend.docker = async (args, extra, c) => { f.state.ms += 1; return raw(args, extra, c); };
  const h = await f.harness(); await h.create(); await h.close(); const receipt = h.receipt();
  assert.ok(receipt.events.every((e, i, all) => Number.isFinite(e.monotonicMs) && (!i || e.monotonicMs >= all[i - 1].monotonicMs)));
  for (const e of receipt.events.filter(e => e.kind === "operation-start")) assert.ok(e.effectiveTimeoutMs <= e.remainingMs && e.effectiveTimeoutMs <= e.maxTimeoutMs);
  assert.equal(receipt.bootstrapTiming.budgetMs, 30_000); assert.ok(receipt.bootstrapTiming.elapsedMs < 30_000); assert.equal(receipt.teardown.resourceAbsenceVerified, true);
});
test("D8 batched observation parser rejects omissions duplicates and trailing data", () => {
  const good = "__M13_a__\none\n__M13_b__\ntwo\n__M13_end__\n"; assert.deepEqual(parseObservationSections(good, ["a", "b"]), { a: "one", b: "two" });
  for (const value of [good.replace("__M13_b__", "__M13_a__"), good.replace("__M13_end__\n", ""), good + "extra", good.replace("__M13_a__", "__M13_c__")]) assert.throws(() => parseObservationSections(value, ["a", "b"]));
});

function d8BatchedFixture() {
  const f = d8Fixture(), raw = f.backend.docker; f.backend.batched = true;
  f.backend.docker = async (args, extra, c) => {
    if (args[0] === "inspect" && args.length === 3) return JSON.stringify((await Promise.all(args.slice(1).map(id => raw(["inspect", id], extra, c)))).flatMap(JSON.parse));
    if (args[0] === "network" && args[1] === "inspect" && args.length === 4) return JSON.stringify((await Promise.all(args.slice(2).map(id => raw(["network", "inspect", id], extra, c)))).flatMap(JSON.parse));
    return raw(args, extra, c);
  };
  f.backend.observations = async () => ({
    pg: { mounts: "tmpfs /var/lib/postgresql tmpfs rw,size=1048576k 0 0", route: "Iface Destination Gateway Flags", memory: String(D6_PROFILE.pgMemory), swap: "0", ...f.state.pgObserved },
    proxy: { hash: createHash("sha256").update(f.state.content).digest("hex") + "  config", permissions: "0:0:444", forward: "0", memory: String(D6_PROFILE.proxyMemory), swap: "0", status: "Uid:\t99\t99\t99\t99\nGid:\t99\t99\t99\t99\nCapEff:\t0000000000000000\nNoNewPrivs:\t1", cmdline: "haproxy -W -db -f /usr/local/etc/haproxy/haproxy.cfg", mounts: "tmpfs /run/haproxy tmpfs rw,size=16384k 0 0", diagnostic: "EXIT=0\n1\n# be_name srv_name srv_addr\nowned_back owned_pg 172.20.0.2", ...f.state.proxyObserved },
  });
  return f;
}
test("D8 grouped reads preserve the full positive proof and fresh standalone verification", async () => {
  const f = d8BatchedFixture(), h = await f.harness(); await h.create(); const proof = await h.preflight(); assert.equal(proof.valid, true); await h.close(); assert.equal(h.receipt().teardown.resourceAbsenceVerified, true);
});
for (const [name, change] of Object.entries(d6Negatives)) test("D8 grouped reads preserve historical rejection: " + name, async () => {
  const f = d8BatchedFixture(), h = await f.harness(); await h.create(); change(f); await assert.rejects(h.run("seed")); noWriter(f, h); await h.close();
});
for (const [name, change] of Object.entries({
  "PG effective cgroup": f => { f.state.pgObserved = { memory: "1" }; },
  "proxy effective cgroup": f => { f.state.proxyObserved = { swap: "1" }; },
  "PG route": f => { f.state.pgObserved = { route: "eth0 00000000 01000000" }; },
  "proxy forwarding": f => { f.state.proxyObserved = { forward: "1" }; },
  "effective capabilities": f => { f.state.proxyObserved = { status: "Uid:\t99\t99\t99\t99\nGid:\t99\t99\t99\t99\nCapEff:\t0000000000000001\nNoNewPrivs:\t1" }; },
  "effective tmpfs": f => { f.state.proxyObserved = { mounts: "tmpfs /run/haproxy tmpfs rw,size=32768k 0 0" }; },
  "diagnostic target": f => { f.state.proxyObserved = { diagnostic: "EXIT=0\n1\n# be_name srv_name srv_addr\nowned_back owned_pg 172.99.0.1" }; },
})) test("D8 grouped runtime drift rejects " + name, async () => {
  const f = d8BatchedFixture(), h = await f.harness(); await h.create(); change(f); await assert.rejects(h.run("seed")); noWriter(f, h); await h.close();
});
test("D8 changed Engine identity revokes the live proof before a writer", async () => {
  const f = d8BatchedFixture(), raw = f.backend.docker; f.backend.engineId = "expected-engine"; f.state.engine = "expected-engine";
  f.backend.docker = async (args, extra, c) => args[0] === "info" ? JSON.stringify(f.state.engine) : raw(args, extra, c);
  const h = await f.harness(); await h.create(); f.state.engine = "different-engine"; await assert.rejects(h.run("seed"), fail("DOCKER_ENGINE_IDENTITY_CHANGED")); noWriter(f, h); await h.close();
});

function d9IdentityFixture() {
  const lease = { database: "synthetic_db", role: "synthetic_role", pgAddress: "172.20.0.2", proxyAddress: "172.20.0.3" };
  const row = { database: lease.database, role: lease.role, version: "18.4", dataDirectory: "/var/lib/postgresql/18/docker", systemIdentifier: "123456", postmasterStart: "2026-11-04 00:00:00+00", serverAddress: lease.pgAddress, clientAddress: lease.pgAddress, serverPort: 5432 };
  return { lease, internal: { ...row }, host: { ...row, clientAddress: lease.proxyAddress } };
}

test("D9 IP01 bare IPv4 equals the same IPv4 /32", () => {
  assert.equal(canonicalIdentityIPv4("172.20.0.2"), canonicalIdentityIPv4("172.20.0.2/32"));
});
test("D9 IP02 IPv4 /32 equals the same bare IPv4", () => {
  const f = d9IdentityFixture(); f.internal.serverAddress += "/32"; f.internal.clientAddress += "/32";
  assert.doesNotThrow(() => assertD6Identity(f.lease, f.internal, f.host));
});
test("D9 IP03 identical valid host addresses retain strict canonical identity", () => {
  for (const ip of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "255.255.255.255"]) {
    assert.equal(canonicalIdentityIPv4(ip), ip); assert.equal(canonicalIdentityIPv4(ip + "/32"), ip);
  }
});
test("D9 IP04 complete synthetic chain accepts PostgreSQL real-format /32 rows", async () => {
  const f = d8BatchedFixture(), raw = f.backend.docker, host = f.backend.hostIdentity;
  const convert = row => ({ ...row, serverAddress: row.serverAddress + "/32", clientAddress: row.clientAddress + "/32" });
  f.backend.docker = async (args, extra, c) => { const result = await raw(args, extra, c); return args.includes("psql") && !args.at(-1).startsWith("SELECT count") ? JSON.stringify(convert(JSON.parse(result))) : result; };
  f.backend.hostIdentity = async lease => convert(await host(lease));
  const h = await f.harness(); await h.create(); assert.equal((await h.preflight()).valid, true);
  assert.equal(f.state.children.length, 0); assert.equal(await h.close(), true);
});

for (const [id, values] of [
  ["IP06", ["172.20.0.2/0", "172.20.0.2/24", "172.20.0.2/31"]],
  ["IP07", ["172.20.0.2/33", "172.20.0.2/-1", "172.20.0.2/+32", "172.20.0.2/032", "172.20.0.2/32/32", "172.20.0.2/"]],
  ["IP08", ["172.20.0.256", "172.20.2", "172.20.00.2", "0xac140002", "2886991874", "172.20.0.2\n", " 172.20.0.2", "172.20.0.2 ", "database.invalid"]],
  ["IP09", ["::1", "::ffff:172.20.0.2", "::ffff:172.20.0.2/128"]],
  ["IP10", [null, undefined, "", 123, {}, []]],
]) test("D9 " + id + " invalid identity address representations reject", () => {
  for (const value of values) assert.throws(() => canonicalIdentityIPv4(value), fail("DATABASE_IP_ADDRESS_INVALID"));
});

for (const [id, change] of [
  ["IP05", f => { f.host.clientAddress = "172.20.0.4/32"; }],
  ["IP06_identity", f => { f.internal.serverAddress += "/24"; }],
  ["IP07_identity", f => { f.host.clientAddress += "/33"; }],
  ["IP08_identity", f => { f.host.serverAddress = "172.20.0.999/32"; }],
  ["IP09_identity", f => { f.host.serverAddress = "::ffff:172.20.0.2"; }],
  ["IP10_identity", f => { delete f.internal.clientAddress; }],
  ["IP11", f => { f.host.unexpectedServerAddress = f.host.serverAddress + "/32"; delete f.host.serverAddress; }],
  ["IP12", f => { f.host.database += "/32"; }],
  ["IP13", f => { f.host.systemIdentifier = "999999"; }],
  ["IP14", f => { f.host.role = "other_role"; }],
  ["IP15", f => { f.lease.proxyAddress = "172.20.0.4"; }],
  ["IP12_start_time", f => { f.host.postmasterStart = "2026-11-04 01:00:00+00"; }],
  ["IP12_port", f => { f.host.serverPort = 5433; }],
  ["IP12_version", f => { f.host.version = "18.6"; }],
  ["IP12_data_directory", f => { f.host.dataDirectory = "/persistent"; }],
]) test("D9 " + id + " rejects despite other valid /32 fields", () => {
  const f = d9IdentityFixture(); f.internal.serverAddress += "/32"; f.host.serverAddress += "/32";
  change(f); assert.throws(() => assertD6Identity(f.lease, f.internal, f.host), error => error instanceof SafetyError);
});

for (const [id, change] of [
  ["IP05_wrong_server", f => { f.state.identity.serverAddress = "172.20.0.4/32"; }],
  ["IP06_non_host_mask", f => { f.state.identity.serverAddress = "172.20.0.2/24"; }],
  ["IP13_changed_cluster", f => { f.state.identity.systemIdentifier = "999999"; }],
  ["IP14_wrong_role", f => { f.state.identity.role = "wrong_role"; }],
  ["IP15_wrong_proxy", f => { f.state.containers[f.ids.haproxy].NetworkSettings.Ports["15432/tcp"][0].HostPort = "49101"; }],
]) test("D9 " + id + " blocks sensitive dispatch and retains cleanup", async () => {
  const f = d8BatchedFixture(), h = await f.harness(); await h.create(); change(f);
  await assert.rejects(h.run("seed")); noWriter(f, h);
  const cleanup = await h.close();
  if (id === "IP15_wrong_proxy") {
    assert.equal(cleanup, false); assert.equal(h.receipt().teardown.resourceAbsenceVerified, false);
    assert.ok(f.state.containers[f.ids.haproxy]); // Altered ownership is not safe to remove.
  } else assert.equal(cleanup, true);
});

function d9PollBudget({ durationMs = 30_000, code = "TOPOLOGY_BOOTSTRAP_TIMEOUT", signal } = {}) {
  const state = { ms: 0, delays: [] };
  const budget = new MonotonicBudget({ durationMs, code, now: () => state.ms, signal });
  const sleep = async ms => { state.delays.push(ms); state.ms += ms; };
  return { state, budget, sleep };
}
test("D9 POLL01 phase cap equal to nominal delay leaves time for post-wakeup guard", async () => {
  const f = d9PollBudget();
  try {
    await f.budget.run("readiness-poll", 250, c => waitReadinessPoll(c, f.sleep));
    assert.deepEqual(f.state.delays, [125]); assert.equal(f.budget.signal.aborted, false);
  } finally { f.budget.dispose(); }
});
test("D9 POLL02 remaining time below nominal delay is bounded and positive", async () => {
  const f = d9PollBudget({ durationMs: 100 });
  try { await f.budget.run("readiness-poll", 15_000, c => waitReadinessPoll(c, f.sleep)); assert.deepEqual(f.state.delays, [50]); assert.equal(f.budget.remaining(), 50); }
  finally { f.budget.dispose(); }
});
test("D9 POLL03 expired global deadline starts no sleep or query", async () => {
  const f = d9PollBudget(); f.state.ms = 30_000;
  try { await assert.rejects(f.budget.run("readiness-poll", 15_000, c => waitReadinessPoll(c, f.sleep)), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); assert.equal(f.state.delays.length, 0); }
  finally { f.budget.dispose(); }
});
test("D9 POLL04 expired phase budget is not replaced with a new global budget", async () => {
  const f = d9PollBudget();
  try { await assert.rejects(f.budget.run("readiness-poll", 250, c => { f.state.ms = 250; return waitReadinessPoll(c, f.sleep); }), fail("OPERATION_PHASE_TIMEOUT")); assert.equal(f.state.delays.length, 0); }
  finally { f.budget.dispose(); }
});
test("D9 POLL05 transient PostgreSQL readiness retries fresh and succeeds before deadline", async () => {
  const f = d8BatchedFixture(), raw = f.backend.docker; let queries = 0;
  f.backend.pollSleep = async ms => { f.state.ms += ms; };
  f.backend.docker = async (args, extra, c) => { if (args.includes("psql") && ++queries === 1) throw new SafetyError("POSTGRESQL_STARTING"); return raw(args, extra, c); };
  const h = await f.harness(); await h.create(); assert.equal(queries, 2);
  assert.ok(h.receipt().events.some(e => e.kind === "operation-start" && e.name === "readiness-poll" && e.effectiveTimeoutMs > 250));
  assert.equal((await h.preflight()).valid, true); assert.equal(f.state.children.length, 0); assert.equal(await h.close(), true);
});
test("D9 POLL06 non-readiness failure remains primary without a retry", async () => {
  const f = d8BatchedFixture(), raw = f.backend.docker; let queries = 0, sleeps = 0;
  f.backend.pollSleep = async () => { sleeps++; };
  f.backend.docker = async (args, extra, c) => { if (args.includes("psql")) { queries++; throw new SafetyError("DATABASE_IDENTITY_MISMATCH"); } return raw(args, extra, c); };
  const h = await f.harness(); await assert.rejects(h.create(), fail("DATABASE_IDENTITY_MISMATCH")); assert.equal(queries, 1); assert.equal(sleeps, 0); noWriter(f, h); assert.equal(await h.close(), true);
});
test("D9 POLL07 abort during real bounded sleep preserves the abort reason", async () => {
  const controller = new AbortController(), f = d9PollBudget({ signal: controller.signal }), primary = new SafetyError("SYNTHETIC_ABORT");
  try { const pending = f.budget.run("readiness-poll", 15_000, c => waitReadinessPoll(c)); queueMicrotask(() => controller.abort(primary)); await assert.rejects(pending, error => error === primary); }
  finally { f.budget.dispose(); }
});
test("D9 POLL08 repeated starting responses cannot spin with zero delay or renewed deadline", async () => {
  const f = d8BatchedFixture(), raw = f.backend.docker, delays = []; let queries = 0;
  f.backend.pollSleep = async ms => { delays.push(ms); assert.ok(ms >= 1 && ms <= 250); f.state.ms += ms; };
  f.backend.docker = async (args, extra, c) => { if (args.includes("psql")) { queries++; f.state.ms += 100; throw new SafetyError("POSTGRESQL_STARTING"); } return raw(args, extra, c); };
  const h = await f.harness(); await assert.rejects(h.create(), fail("TOPOLOGY_BOOTSTRAP_TIMEOUT")); assert.ok(queries < 150 && delays.length > 0); noWriter(f, h); assert.equal(await h.close(), true);
});
test("D9 POLL09 a prior identity is never reused after readiness or generation changes", async () => {
  const f = d8BatchedFixture(), h = await f.harness(); await h.create(); f.state.identity.systemIdentifier = "different_generation";
  await assert.rejects(h.run("seed")); noWriter(f, h); assert.equal(await h.close(), true);
});
test("D9 POLL10 polling timeout remains primary across successful idempotent teardown", async () => {
  const f = d8BatchedFixture(), raw = f.backend.docker;
  f.backend.pollSleep = async ms => { f.state.ms += ms + 30_000; };
  f.backend.docker = async (args, extra, c) => { if (args.includes("psql")) throw new SafetyError("POSTGRESQL_STARTING"); return raw(args, extra, c); };
  const h = await f.harness(); let primary;
  try { await h.create(); } catch (error) { primary = error; }
  const result = await finishOwnedRun(h, primary); assert.equal(result.error, primary); assert.equal(primary.code, "TOPOLOGY_BOOTSTRAP_TIMEOUT");
  assert.equal(result.cleanupStatus, "COMPLETE"); noWriter(f, h); assert.equal(await h.close(), true);
});

// D12: actual worker exit is independent from message/Promise settlement.
const d12Payload = { root: dirname(process.execPath), mode: "binary", files: [["node.exe", "a".repeat(64)]] };
function d12Factory(body, shared) {
  return data => new Worker(`const {parentPort,workerData}=require('node:worker_threads'); ${body}`, { eval: true, execArgv: [], env: {}, workerData: { ...data, shared } });
}
const d12Proof = "parentPort.postMessage({kind:'verified',id:workerData.id,manifest:workerData.manifest,files:workerData.files.length,version:process.version,execPath:process.execPath});parentPort.close();";
const d12Wait = ms => new Promise(done => setTimeout(done, ms));
async function d12Files(operation) {
  const root = await mkdtemp(join(tmpdir(), "m13-d12-"));
  try { await writeFile(join(root, "synthetic.bin"), "synthetic-only"); const files = [["synthetic.bin", createHash("sha256").update("synthetic-only").digest("hex")]]; return await operation({ root, mode: "psql", files }); }
  finally { assert.ok(root.startsWith(join(tmpdir(), "m13-d12-"))); await rm(root, { recursive: true, force: true }); }
}
test("D12 RT01 deadline before dispatch starts zero workers", async () => {
  let starts = 0; const controller = new AbortController(); controller.abort(new SafetyError("OPERATION_PHASE_TIMEOUT"));
  await assert.rejects(verifyFilesBounded(d12Payload, { signal: controller.signal }, { workerFactory: () => starts++ }), fail("OPERATION_PHASE_TIMEOUT")); assert.equal(starts, 0);
});
test("D12 RT02 deadline cancels an already active asynchronous verifier and observes exit", async () => {
  const registry = new Set(), shared = new SharedArrayBuffer(4);
  await assert.rejects(verifyFilesBounded(d12Payload, { timeoutMs: 500 }, { registry, workerFactory: d12Factory("Atomics.store(new Int32Array(workerData.shared),0,1);setInterval(()=>{},1000)", shared) }), fail("OPERATION_PHASE_TIMEOUT"));
  assert.equal(Atomics.load(new Int32Array(shared), 0), 1); assert.equal(verificationQuiescence(registry).verified, true); assert.equal([...registry][0].exitObserved, true);
});
test("D12 RT03 non-cooperative synchronous CPU work is forcibly terminated and joined", async () => {
  const registry = new Set(), shared = new SharedArrayBuffer(8), values = new Int32Array(shared); let worker;
  const factory = d12Factory("const a=new Int32Array(workerData.shared);Atomics.store(a,0,1);while(true){Atomics.add(a,1,1)}", shared);
  await assert.rejects(verifyFilesBounded(d12Payload, { timeoutMs: 500 }, { registry, workerFactory: data => { worker = factory(data); return worker; } }), error => { assert.equal(error.code, "OPERATION_PHASE_TIMEOUT"); assert.equal(error.verification.exitObserved, true); assert.ok(error.verification.abortJoinElapsedMs < 5000); return true; });
  assert.equal(Atomics.load(values, 0), 1); assert.equal(worker.threadId, -1); const stopped = Atomics.load(values, 1); await d12Wait(25); assert.equal(Atomics.load(values, 1), stopped); assert.equal(verificationQuiescence(registry).verified, true);
  console.info("D12_NON_COOPERATIVE " + JSON.stringify([...registry][0]));
});
test("D12 RT04 success message without exit never grants a positive receipt", async () => {
  const registry = new Set(); await assert.rejects(verifyFilesBounded(d12Payload, { timeoutMs: 500 }, { registry, workerFactory: d12Factory(d12Proof.replace("parentPort.close();", "setInterval(()=>{},1000);")) }), fail("OPERATION_PHASE_TIMEOUT")); assert.equal(verificationQuiescence(registry).verified, true);
});
test("D12 RT05 subordinate verifier receives the smaller current remaining time", async () => {
  const registry = new Set(); await assert.rejects(verifyFilesBounded(d12Payload, { timeoutMs: 1000, effectiveTimeout: () => 100 }, { registry, workerFactory: d12Factory("setInterval(()=>{},1000)") }), fail("OPERATION_PHASE_TIMEOUT")); assert.equal([...registry][0].effectiveTimeoutMs, 100);
});
test("D12 RT06 no phase or global deadline reset is introduced", async () => {
  let clock = 0; const b = new MonotonicBudget({ durationMs: 100, code: "ROLE_DEADLINE", now: () => clock });
  try { await b.run("first", 80, async () => { clock = 70; }); await assert.rejects(b.run("second", 80, async c => { assert.equal(c.timeoutMs, 30); clock = 101; }), fail("ROLE_DEADLINE")); } finally { b.dispose(); }
});
test("D12 RT07 role runtime expiry revokes lease and permits zero sensitive children", async () => {
  const f = d8BatchedFixture(); let expire = false;
  const runtime = { directory: dirname(process.execPath), npmCli: "/synthetic/npm-cli.js", receipt: { simulation: true, nodePinPass: false }, assertLive: async control => { if (expire) { f.state.ms += 1_800_001; control.beforeSpawn(); } } };
  const h = await createProxyRunHarness({ runtime, adapters: f.backend, evidenceDirectory: tmpdir() }); await h.create(); expire = true;
  await assert.rejects(h.run("seed"), fail("ROLE_DEADLINE")); noWriter(f, h); await assert.rejects(h.run("seed")); await h.close();
});
test("D12 RT08 abort is consumed while verification is active", async () => {
  const controller = new AbortController(), shared = new SharedArrayBuffer(4), registry = new Set();
  const task = verifyFilesBounded(d12Payload, { timeoutMs: 2000, signal: controller.signal }, { registry, workerFactory: d12Factory("Atomics.store(new Int32Array(workerData.shared),0,1);setInterval(()=>{},1000)", shared) });
  for (let attempts = 0; attempts < 200 && Atomics.load(new Int32Array(shared), 0) === 0; attempts++) await d12Wait(5);
  controller.abort(new SafetyError("RUN_ABORTED")); await assert.rejects(task, fail("RUN_ABORTED")); assert.equal(Atomics.load(new Int32Array(shared), 0), 1); assert.equal(verificationQuiescence(registry).verified, true);
});
test("D12 RT09 non-cooperative completion cannot bypass the real exit requirement", async () => {
  const registry = new Set(); let worker; const task = verifyFilesBounded(d12Payload, { timeoutMs: 500 }, { registry, workerFactory: data => { worker = d12Factory("while(true){}")(data); return worker; } });
  await assert.rejects(task, fail("OPERATION_PHASE_TIMEOUT")); assert.equal(worker.threadId, -1); assert.equal([...registry][0].state, "JOINED");
});
test("D12 RT10 external abort remains the primary error after join", async () => {
  const controller = new AbortController(), primary = new SafetyError("SYNTHETIC_ABORT"), registry = new Set();
  const task = verifyFilesBounded(d12Payload, { signal: controller.signal, timeoutMs: 1000 }, { registry, workerFactory: d12Factory("setInterval(()=>{},1000)") }); controller.abort(primary);
  await assert.rejects(task, error => error === primary && error.verification.exitObserved);
});
test("D12 RT11 diagnostic failure does not mask the primary timeout", async () => {
  const registry = new Set(); await assert.rejects(verifyFilesBounded(d12Payload, { timeoutMs: 100, record: kind => { if (kind === "runtime-verifier-abort") throw new Error("synthetic diagnostic"); } }, { registry, workerFactory: d12Factory("setInterval(()=>{},1000)") }), error => error.code === "OPERATION_PHASE_TIMEOUT" && error.verification.secondaryDiagnosticFailure === "VERIFIER_RECEIPT_WRITE_FAILED");
});
test("D12 RT12 terminate Promise alone does not prove bounded join", async () => {
  const worker = new EventEmitter(), registry = new Set(); worker.threadId = 123; worker.postMessage = () => {}; worker.terminate = async () => 0; worker.unref = () => {};
  await assert.rejects(verifyFilesBounded(d12Payload, { timeoutMs: 20 }, { registry, workerFactory: () => worker, joinMs: 20 }), error => error.code === "OPERATION_PHASE_TIMEOUT" && error.joinFailure === "VERIFIER_JOIN_INCOMPLETE");
  assert.equal(verificationQuiescence(registry).verified, false); assert.equal([...registry][0].state, "UNKNOWN"); worker.emit("exit", 1);
});
test("D12 RT13 owned children joined is independently observable", () => { assert.equal(ownedProcessQuiescence(new Set([{ pid: 1, state: "JOINED" }])).verified, true); });
test("D12 RT14 active owned child prevents quiescence", () => { const s = ownedProcessQuiescence(new Set([{ pid: 1, state: "ACTIVE" }])); assert.equal(s.verified, false); assert.equal(s.active, 1); });
test("D12 RT15 unknown owned child state cannot produce quiescence PASS", () => { assert.equal(ownedProcessQuiescence(new Set([{ pid: 1, state: "UNKNOWN" }])).verified, false); });
test("D12 RT16 revoked lease never fabricates live SQL quiescence", async () => {
  const f = d8BatchedFixture(), h = await f.harness(); await h.create(); f.state.identity.systemIdentifier = "different"; await assert.rejects(h.run("seed")); await h.close();
  assert.equal(h.receipt().events.find(e => e.kind === "quiescence").status, "NOT_VERIFIABLE"); assert.equal(h.receipt().taskQuiescence.liveSqlQuiescence, "NOT_VERIFIABLE"); noWriter(f, h);
});
test("D12 RT17 actual fixture resource removal is required independently of dispatch", async () => { const f = d8BatchedFixture(), h = await f.harness(); await h.create(); assert.equal(await h.close(), true); assert.equal(h.receipt().teardown.resourceAbsenceVerified, true); assert.equal(h.receipt().taskQuiescence.sqlTermination, "OWNED_POSTGRESQL_STOPPED_AND_ABSENT"); });
test("D12 RT18 immutable expected digest reuse still checks current bytes each time", async () => d12Files(async payload => { const registry = new Set(); await verifyFilesBounded(payload, {}, { registry }); await verifyFilesBounded(payload, {}, { registry }); assert.equal([...registry].length, 2); assert.equal(verificationQuiescence(registry).verified, true); }));
test("D12 RT19 changed artifact invalidates a previously successful check", async () => d12Files(async payload => { await verifyFilesBounded(payload); await writeFile(join(payload.root, "synthetic.bin"), "changed"); await assert.rejects(verifyFilesBounded(payload), fail("PSQL_BUNDLE_CHANGED")); }));
test("D12 RT20 every live identity is checked again after a prior PASS", async () => { const f = d8BatchedFixture(), h = await f.harness(); await h.create(); f.state.identity.role = "wrong"; await assert.rejects(h.run("seed")); noWriter(f, h); await h.close(); });
test("D12 RT21 stale generation never authorizes a new writer", async () => { const f = d8BatchedFixture(), h = await f.harness(); await h.create(); f.state.monitorDead = true; await assert.rejects(h.run("seed")); noWriter(f, h); await h.close(); });
test("D12 RT22 runtime image drift still blocks dispatch and unknown cleanup", async () => { const f = d8BatchedFixture(), h = await f.harness(); await h.create(); Object.values(f.state.containers)[0].Image = "sha256:changed"; await assert.rejects(h.run("seed")); noWriter(f, h); assert.equal(await h.close(), false); });
test("D12 RT23 preserved canonical definitions and original deadline constants", () => { assert.equal(D8_LIMITS.bootstrapMs, 30000); assert.equal(D8_LIMITS.commandMs, 15000); assert.equal(D8_LIMITS.joinMs, 5000); assert.deepEqual(commandDefinitions({ npmCli: "npm" }).unit, ["--test", "scripts/m13-p1-environment.test.mjs", "scripts/run-e2e.test.mjs"]); });
test("D12 RT24 first writer requires a fresh complete guard", async () => { const f = d8BatchedFixture(), h = await f.harness(); await h.create(); f.state.identity.database = "persistent_not_contacted"; await assert.rejects(h.run("seed")); noWriter(f, h); await h.close(); });
test("D12 RT25 uncertain ownership prevents removal even after abort", async () => { const f = d8BatchedFixture(), h = await f.harness(); await h.create(); Object.values(f.state.networks)[0].Labels["piccadilly.owner"] = "other"; await assert.rejects(h.run("seed")); assert.equal(await h.close(), false); assert.equal(h.receipt().taskQuiescence.status, "NOT_VERIFIED"); noWriter(f, h); });


// D13: preserve every previous assertion; exercise only the two-level delta.
test("D13 full qualification has its own bounded maximum and observed exit", async () => {
  const registry = new Set();
  const proof = await verifyFilesBounded(d12Payload, { timeoutMs: 60_000 }, { registry, maximumMs: D13_LIMITS.fullMaximumMs, workerFactory: d12Factory(d12Proof) });
  assert.equal(proof.effectiveTimeoutMs, 60_000); assert.equal(proof.exitObserved, true);
  assert.equal(verificationQuiescence(registry).verified, true); assert.equal(D13_LIMITS.operationalMs, 15_000);
});

test("D13 full qualification timeout terminates a non-cooperative worker", async () => {
  const registry = new Set(); let worker;
  await assert.rejects(verifyFilesBounded(d12Payload, { timeoutMs: 100 }, { registry, maximumMs: D13_LIMITS.fullMaximumMs, workerFactory: data => { worker = d12Factory("while(true){}")(data); return worker; } }), fail("OPERATION_PHASE_TIMEOUT"));
  assert.equal(worker.threadId, -1); assert.equal(verificationQuiescence(registry).verified, true);
});

function d13Fixture(overrides = {}) {
  const f = d8BatchedFixture(), calls = [];
  const runtime = { directory: dirname(process.execPath), npmCli: "/synthetic/npm-cli.js", receipt: { simulation: true },
    assertLive: async () => { throw new Error("unexpected full bundle fallback"); },
    assertExecutionLive: async c => { c.beforeSpawn(); calls.push("execution"); },
    assertQualified: async c => { assert.ok(c.timeoutMs <= 60_000); c.beforeSpawn(); calls.push("full"); },
    assertOperationalLive: async c => { assert.ok(c.timeoutMs <= 15_000); c.beforeSpawn(); calls.push("operational"); },
    ...overrides };
  return { ...f, runtime, calls, harness: () => createProxyRunHarness({ runtime, adapters: f.backend, evidenceDirectory: tmpdir() }) };
}

test("D13 operational guards are fresh and full qualification is repeated after ci only when required", async () => {
  const f = d13Fixture(), h = await f.harness(); await h.create();
  await h.run("ci"); await h.run("unit"); await h.run("validate");
  assert.equal(f.calls.filter(x => x === "full").length, 2);
  assert.equal(f.calls.filter(x => x === "operational").length, 3);
  assert.equal(h.receipt().commands.length, 3);
  for (const e of h.receipt().events.filter(e => e.kind === "operational-guard-end")) assert.ok(e.elapsedMs < 15_000);
  await h.close();
});

test("D13 operational guard cap covers the whole live proof, not independent command windows", async () => {
  const f = d13Fixture(), h = await f.harness(); await h.create(); const raw = f.backend.docker;
  f.backend.docker = async (...args) => { f.state.ms += 4_000; args[2]?.beforeSpawn(); return raw(...args); };
  await assert.rejects(h.run("seed"), fail("OPERATIONAL_GUARD_TIMEOUT")); noWriter(f, h);
  assert.equal(h.receipt().events.findLast(e => e.kind === "operational-guard-end").aborted, true);
  f.backend.docker = raw; await h.close();
});

test("D13 full timeout cannot fall through to an operational guard or writer", async () => {
  const f = d13Fixture(), h = await f.harness(); await h.create();
  f.runtime.assertQualified = async c => { f.state.ms += 60_001; c.beforeSpawn(); };
  await assert.rejects(h.run("seed"), fail("OPERATION_PHASE_TIMEOUT")); noWriter(f, h);
  assert.equal(f.calls.filter(x => x === "operational").length, 0); await h.close();
});

test("D13 immutable digest reuse rejects actual file drift in both verification levels", async () => d12Files(async payload => {
  await verifyFilesBounded(payload, {}, { maximumMs: D13_LIMITS.fullMaximumMs });
  await writeFile(join(payload.root, "synthetic.bin"), "changed");
  await assert.rejects(verifyFilesBounded(payload), fail("PSQL_BUNDLE_CHANGED"));
  await assert.rejects(verifyFilesBounded(payload, {}, { maximumMs: D13_LIMITS.fullMaximumMs }), fail("PSQL_BUNDLE_CHANGED"));
}));

test("D13 qualified runtime does not authorize changed SQL identity or stale generation", async () => {
  for (const change of [f => { f.state.identity.role = "wrong"; }, f => { f.state.monitorDead = true; }]) {
    const f = d13Fixture(), h = await f.harness(); await h.create(); await h.run("unit"); const count = h.receipt().commands.length;
    change(f); await assert.rejects(h.run("seed")); assert.equal(h.receipt().commands.length, count);
    assert.ok(h.receipt().events.some(e => e.kind === "lease-revoked")); await h.close();
  }
});

test("D13 direct npm commands always require fresh full bundle qualification", async () => {
  const f = d13Fixture(), h = await f.harness(); await h.create();
  await h.run("unit"); await h.run("validate"); await h.run("npm-ls");
  assert.equal(f.calls.filter(x => x === "full").length, 2);
  assert.equal(f.calls.filter(x => x === "operational").length, 3);
  await h.close();
});


// D14 adds census protocol support to the common fake; historical assertions stay unchanged.
function quietSnapshot(extra = []) {
  const monitor = { pid: 77, backendStart: "2026-11-04 00:00:00+00", applicationName: "m13-monitor-test", readOnly: "on" };
  const own = { ...monitor, database: "synthetic", role: "synthetic_role", backendType: "client backend", state: "active", transactionOpen: true };
  return { monitor, clients: [own, ...extra], sameRoleNonClients: [{ type: "autovacuum worker", count: 1 }] };
}
const quietExpected = { database: "synthetic", role: "synthetic_role", monitorName: "m13-monitor-test" };
const quietOther = overrides => ({ pid: 88, backendStart: "2026-11-04 00:00:01+00", database: "synthetic", role: "synthetic_role", backendType: "client backend", applicationName: "", state: "idle", transactionOpen: false, ...overrides });

test("D14 QUIET01 monitor is excluded only with matching PID start nonce role and database", () => {
  const s = quietSnapshot(); assert.equal(classifySessionCensus(s, quietExpected).otherClientSessionsCount, 0);
  s.clients[0].backendStart = "different"; assert.throws(() => classifySessionCensus(s, quietExpected), fail("SQL_MONITOR_IDENTITY_INVALID"));
  assert.throws(() => classifySessionCensus({ ...quietSnapshot(), clients: [] }, quietExpected));
});
test("D14 QUIET02 active client is detected and query text is never exported", () => {
  const s = classifySessionCensus(quietSnapshot([quietOther({ state: "active", transactionOpen: true, query: "SYNTHETIC_PRIVATE_QUERY" })]), quietExpected);
  assert.equal(s.activeSessionsCount, 1); assert.equal(s.quiet, false); assert.ok(!JSON.stringify(s).includes("SYNTHETIC_PRIVATE_QUERY"));
});
test("D14 QUIET03 idle unnamed client is never ignored", () => {
  const s = classifySessionCensus(quietSnapshot([quietOther({})]), quietExpected);
  assert.equal(s.idleSessionsCount, 1); assert.equal(s.unknownSessionsCount, 1); assert.equal(s.quiet, false);
});
test("D14 QUIET04 open transactions include idle and aborted transactions", () => {
  for (const state of ["idle in transaction", "idle in transaction (aborted)"]) {
    const s = classifySessionCensus(quietSnapshot([quietOther({ state, transactionOpen: true })]), quietExpected);
    assert.equal(s.idleInTransactionCount, 1); assert.equal(s.openTransactionsCount, 1); assert.equal(s.quiet, false);
  }
});
test("D14 QUIET05 closed clients pass while non-client server backends remain distinct", async () => {
  const s = classifySessionCensus(quietSnapshot(), quietExpected); assert.equal(s.quiet, true); assert.equal(s.sameRoleNonClients[0].count, 1);
  const f = d8BatchedFixture(), h = await f.harness(); await h.create(); assert.equal(await h.close(), true);
  assert.equal(h.receipt().taskQuiescence.liveSqlQuiescence, "PASS_VERIFIED"); assert.equal(await h.close(), true);
});
test("D14 QUIET06 unknown state role database and appname cannot grant PASS", () => {
  const s = classifySessionCensus(quietSnapshot([quietOther({ state: null, role: null, database: null, backendType: null })]), quietExpected);
  assert.equal(s.unknownSessionsCount, 1); assert.equal(s.quiet, false);
  assert.throws(() => classifySessionCensus({ ...quietSnapshot(), monitor: { ...quietSnapshot().monitor, readOnly: "off" } }, quietExpected));
});
test("D14 QUIET07 drain is finite and does not reinterpret an idle connection as quiet", async () => {
  const f = d8BatchedFixture(), h = await f.harness(); await h.create(); f.state.quietRows = [quietOther({})];
  f.backend.pollSleep = async ms => { assert.ok(ms > 0); f.state.ms += ms + 5000; };
  assert.equal(await h.close(), false); const receipt = h.receipt();
  assert.equal(receipt.events.findLast(e => e.kind === "quiescence").status, "FAIL"); assert.ok(receipt.events.some(e => e.kind === "session-census" && e.otherClientSessionsCount === 1));
  assert.equal(receipt.teardown.resourceAbsenceVerified, true);
});
test("D14 QUIET08 lease revocation forbids new SQL census and writers", async () => {
  const f = d8BatchedFixture(), raw = f.backend.sessionCensus; let censuses = 0;
  f.backend.sessionCensus = (...args) => { censuses++; return raw(...args); };
  const h = await f.harness(); await h.create(); f.state.monitorDead = true; await assert.rejects(h.run("seed")); await h.close();
  assert.equal(censuses, 0); assert.equal(h.receipt().taskQuiescence.liveSqlQuiescence, "NOT_VERIFIABLE"); noWriter(f, h);
});
test("D14 QUIET09 SQL drain failure preserves the primary error through PostgreSQL stop", async () => {
  const f = d8BatchedFixture(), h = await f.harness(); await h.create(); f.state.quietRows = [quietOther({ state: "active" })]; f.backend.pollSleep = async () => { f.state.ms += 5001; };
  const primary = new SafetyError("PRIMARY_SYNTHETIC"); const result = await finishOwnedRun(h, primary);
  assert.equal(result.error, primary); assert.equal(result.cleanupStatus, "INCOMPLETE"); assert.equal(result.receipt.taskQuiescence.sqlTermination, "OWNED_POSTGRESQL_STOPPED_AND_ABSENT");
  assert.equal(result.receipt.teardown.resourceAbsenceVerified, true);
});
test("D14 QUIET10 early census detects and joins a correlated read-only client before zero-client proof", async () => {
  const f = d8BatchedFixture(); let connection;
  f.backend.syntheticConnection = async (lease, name) => {
    f.state.quietRows = [quietOther({ pid: 42, database: lease.database, role: lease.role, applicationName: name })];
    connection = { pid: 42, applicationName: name, joined: false, async close() { this.joined = true; f.state.quietRows = []; } }; return connection;
  };
  const h = await f.harness(); await h.create(); const proof = await h.validateQuiescence();
  assert.equal(proof.syntheticClientClosed, true); assert.equal(proof.noApplicationWriter, true); assert.equal(connection.joined, true); assert.equal(f.state.children.length, 0);
  assert.ok(h.receipt().events.some(e => e.kind === "session-census" && e.otherClientSessionsCount === 1)); assert.equal(await h.close(), true);
  assert.equal(h.receipt().teardown.resourceAbsenceVerified, true);
});

// D15 only adds tests: the previous 273 assertions and shared fixtures remain.
const d15EngineId = "ff3b1357-d1cf-4a41-befc-f5b58f388144";
const d15Context = () => [{ Name: "desktop-linux", Endpoints: { docker: { Host: D15_ENGINE_ENDPOINT } } }];
function d15Request({ id = d15EngineId, body, status = 200, stall = false, nonCooperative = false } = {}) {
  const state = { started: false, requestDestroyed: false, socketDestroyed: false, options: null };
  const factory = (options, responseCallback) => {
    state.options = options;
    const req = new EventEmitter(), socket = new EventEmitter(); let requestClosed = false, socketClosed = false;
    req.destroy = () => { state.requestDestroyed = true; if (!nonCooperative && !requestClosed) { requestClosed = true; queueMicrotask(() => req.emit("close")); } };
    socket.destroy = () => { state.socketDestroyed = true; if (!nonCooperative && !socketClosed) { socketClosed = true; queueMicrotask(() => socket.emit("close")); } };
    req.end = () => queueMicrotask(() => {
      state.started = true; req.emit("socket", socket);
      if (!stall) { const response = new PassThrough(); response.statusCode = status; responseCallback(response); response.end(body ?? JSON.stringify({ ID: id })); }
    });
    return req;
  };
  return { state, factory };
}
const d15Read = (control, fake, registry = new Set(), joinMs = 5000) => readLocalEngineIdentity(D15_ENGINE_ENDPOINT, control, { requestFactory: fake.factory, registry, joinMs });
function d15Fixture() {
  const f = d8BatchedFixture(); f.state.engineId = d15EngineId; f.state.context = d15Context(); f.state.engineReads = 0;
  f.backend.engineId = d15EngineId;
  f.backend.verifyEngine = c => { f.state.engineReads++; return verifyDockerEngine(d15EngineId, f.state.context, c, (_endpoint, control) => d15Read(control, d15Request({ id: f.state.engineId }))); };
  return f;
}

test("D15 fixed local API verifies current ID only after request and socket close", async () => {
  const fake = d15Request(), registry = new Set(), b = new MonotonicBudget({ durationMs: 1000, code: "TEST_DEADLINE" });
  try {
    assert.equal(await b.run("engine", 1000, c => d15Read(c, fake, registry)), d15EngineId);
    assert.deepEqual(fake.state.options, { socketPath: "\\\\.\\pipe\\dockerDesktopLinuxEngine", method: "GET", path: "/info", agent: false, headers: { Connection: "close" } });
    assert.equal(fake.state.requestDestroyed && fake.state.socketDestroyed, true);
    assert.equal([...registry][0].state, "JOINED"); assert.equal([...registry][0].requestClosed && [...registry][0].socketClosed, true);
  } finally { b.dispose(); }
});
test("D15 guard bypasses slow info CLI while preserving fresh proof and final census", async () => {
  const f = d15Fixture(), raw = f.backend.docker;
  f.backend.docker = async (...args) => { if (args[0][0] === "info") { f.state.ms += 15001; throw new Error("slow info CLI must not execute in guard"); } return raw(...args); };
  const h = await f.harness(); await h.create(); const n = f.state.engineReads;
  await h.preflight(); assert.ok(f.state.engineReads >= n + 2);
  await h.run("unit"); assert.equal(f.state.children.length, 1);
  assert.equal(await h.close(), true);
  assert.equal(h.receipt().events.findLast(e => e.kind === "quiescence").status, "PASS_VERIFIED");
  assert.equal(h.receipt().teardown.resourceAbsenceVerified, true);
});
test("D15 changed Engine or current context cannot reuse a prior positive proof", async () => {
  for (const change of [f => { f.state.engineId = "aa3b1357-d1cf-4a41-befc-f5b58f388144"; }, f => { f.state.context[0].Name = "other"; }, f => { f.state.context[0].Endpoints.docker.Host = "npipe:////./pipe/other"; }]) {
    const f = d15Fixture(), h = await f.harness(); await h.create(); await h.preflight(); change(f);
    await assert.rejects(h.run("seed"), e => ["DOCKER_ENGINE_IDENTITY_CHANGED", "DOCKER_CONTEXT_IDENTITY_CHANGED"].includes(e.code));
    noWriter(f, h); await h.close();
  }
});
test("D15 optimized path still rejects replaced container network SQL identity and stale lease", async () => {
  for (const change of [f => { Object.values(f.state.containers)[0].Id = "a".repeat(64); }, f => { Object.values(f.state.networks)[0].Id = "a".repeat(64); }, f => { f.state.identity.systemIdentifier = "999999"; }, f => { f.state.monitorDead = true; }]) {
    const f = d15Fixture(), h = await f.harness(); await h.create(); await h.preflight(); change(f);
    await assert.rejects(h.run("seed")); noWriter(f, h); await h.close();
  }
});
test("D15 API deadline destroys an already active request and joins its actual socket", async () => {
  const fake = d15Request({ stall: true }), registry = new Set(), b = new MonotonicBudget({ durationMs: 1000, code: "TEST_DEADLINE" });
  try {
    await assert.rejects(b.run("engine", 25, c => d15Read(c, fake, registry)), fail("OPERATION_PHASE_TIMEOUT"));
    assert.equal(fake.state.started, true); assert.equal(fake.state.requestDestroyed && fake.state.socketDestroyed, true);
    assert.equal([...registry][0].state, "JOINED");
  } finally { b.dispose(); }
});
test("D15 abort during an active API read preserves the primary error and joins", async () => {
  const fake = d15Request({ stall: true }), registry = new Set(), controller = new AbortController(), primary = new SafetyError("PRIMARY_ABORT");
  const b = new MonotonicBudget({ durationMs: 1000, code: "TEST_DEADLINE", signal: controller.signal });
  try {
    const pending = b.run("engine", 1000, c => d15Read(c, fake, registry));
    await new Promise(done => setImmediate(done)); assert.equal(fake.state.started, true); controller.abort(primary);
    await assert.rejects(pending, error => error === primary); assert.equal([...registry][0].state, "JOINED");
  } finally { b.dispose(); }
});
test("D15 non-cooperative transport produces unknown quiescence and never a positive ID", async () => {
  const fake = d15Request({ stall: true, nonCooperative: true }), registry = new Set(), b = new MonotonicBudget({ durationMs: 1000, code: "TEST_DEADLINE" });
  try {
    await assert.rejects(b.run("engine", 25, c => d15Read(c, fake, registry, 25)), error => error.code === "OPERATION_PHASE_TIMEOUT" && error.joinFailure === "ENGINE_API_JOIN_INCOMPLETE");
    assert.equal(fake.state.started, true); assert.equal([...registry][0].state, "UNKNOWN");
  } finally { b.dispose(); }
});
test("D15 malformed or failed API responses and remote endpoints fail closed", async () => {
  for (const options of [{ body: "{}" }, { body: "invalid" }, { status: 500 }, { id: "wrong" }]) {
    const fake = d15Request(options), b = new MonotonicBudget({ durationMs: 1000, code: "TEST_DEADLINE" });
    try { await assert.rejects(b.run("engine", 1000, c => d15Read(c, fake)), fail("DOCKER_ENGINE_RESPONSE_INVALID")); } finally { b.dispose(); }
  }
  assert.throws(() => assertDockerTarget(d15Context(), "tcp://other:2375"), fail("DOCKER_CONTEXT_IDENTITY_CHANGED"));
  await assert.rejects(readLocalEngineIdentity("tcp://other:2375", {}), fail("NON_LOCAL_DOCKER_REJECTED"));
});
test("D15 expired operational budget never starts the identity transport or a writer", async () => {
  const fake = d15Request(), b = new MonotonicBudget({ durationMs: 15_000, code: "OPERATIONAL_GUARD_TIMEOUT", now: () => 0 });
  b.controller.abort(new SafetyError("OPERATIONAL_GUARD_TIMEOUT"));
  try { await assert.rejects(b.run("engine", 15000, c => d15Read(c, fake)), fail("OPERATIONAL_GUARD_TIMEOUT")); assert.equal(fake.state.started, false); } finally { b.dispose(); }
});

// D16 exercises the versioned main() body; no Docker, SQL, or role child is run.
async function d16Cli(options = {}, check) {
  const { validationError, cleanup = true, cleanupError } = options;
  const validation = Object.hasOwn(options, "validation") ? options.validation : { status: "PASS_VERIFIED" };
  const directory = await mkdtemp(join(tmpdir(), "m13-d16-cli-")), calls = [];
  const runtime = { receipt: { status: "TEST_DOUBLE_ONLY_NOT_RUNTIME_QUALIFICATION" } };
  const listeners = ["SIGINT", "SIGTERM"].map(name => process.listenerCount(name));
  let configured, closed = false, closePromise, caught;
  const harness = {
    async create() { calls.push("create"); },
    async validateQuiescence() {
      calls.push("validate:start"); await new Promise(done => setImmediate(done));
      if (validationError) { calls.push("validate:fail"); throw validationError; }
      calls.push(validation?.status === "PASS_VERIFIED" ? "validate:pass" : "validate:non-positive"); return validation;
    },
    async run(role) { calls.push("run:" + role); return { exitCode: 0, result: "TEST_DOUBLE_ONLY_NO_ROLE_EXECUTION" }; },
    close() { return closePromise ??= (async () => { calls.push("close"); closed = true; if (cleanupError) throw cleanupError; return cleanup; })(); },
    receipt() { return { testDoubleOnly: true, closed }; },
  };
  const dependencies = {
    // A CLI invocation has a clean input; do not mutate the Vitest DB environment.
    environment: {},
    async qualifyRuntime() { calls.push("qualify"); return runtime; },
    async createHarness(options) { calls.push("harness"); configured = options; return harness; },
  };
  try {
    try { await main(["run", "--distribution-dir", join(directory, "distribution"), "--evidence-dir", join(directory, "evidence"), "--artifact-dir", join(directory, "artifacts"), "--engine-id", d15EngineId, "--plan", "core"], dependencies); }
    catch (error) { caught = error; }
    const receipt = JSON.parse(await readFile(join(directory, "evidence", "run.json"), "utf8"));
    assert.deepEqual(["SIGINT", "SIGTERM"].map(name => process.listenerCount(name)), listeners);
    assert.equal(configured.runtime, runtime); assert.ok(configured.signal instanceof AbortSignal);
    assert.equal(configured.expectedEngineId, d15EngineId);
    await check({ calls, caught, receipt, harness, configured });
  } finally {
    assert.equal(dirname(directory), tmpdir()); assert.ok(directory.split(/[\\/]/u).at(-1).startsWith("m13-d16-cli-"));
    await rm(directory, { recursive: true, force: true });
  }
}

test("D16 CLI positive main awaits explicit early PASS before first role", async () => {
  await d16Cli({}, async ({ calls, caught, receipt, harness }) => {
    assert.equal(caught, undefined);
    assert.deepEqual(calls, ["qualify", "harness", "create", "validate:start", "validate:pass", ...PLANS.core.map(role => "run:" + role), "close"]);
    assert.equal(receipt.primaryFailure, null); assert.equal(receipt.cleanupStatus, "COMPLETE");
    await harness.close(); await harness.close(); assert.equal(calls.filter(x => x === "close").length, 1);
    console.info("D16_CLI_EVIDENCE " + JSON.stringify({ case: "positive", testDoubleOnly: true, validationResult: "PASS_VERIFIED", calls, cleanupStatus: receipt.cleanupStatus }));
  });
  const directory = join(tmpdir(), "m13-d16-never-created"), calls = [];
  await assert.rejects(main(["run", "--distribution-dir", directory, "--evidence-dir", directory], {
    environment: { DATABASE_URL: "postgresql://synthetic.invalid/never_connected" },
    qualifyRuntime: async () => { calls.push("qualify"); },
    createHarness: async () => { calls.push("harness"); },
  }), fail("UNTRUSTED_ENVIRONMENT"));
  assert.deepEqual(calls, []);
});
test("D16 CLI negative main forbids first dispatch and preserves validation error through cleanup", async () => {
  for (const failure of [{}, { cleanup: false }, { cleanupError: new SafetyError("SYNTHETIC_CLEANUP_FAILURE") }]) {
    const primary = new SafetyError("SYNTHETIC_EARLY_QUIESCENCE_FAILURE");
    await d16Cli({ ...failure, validationError: primary }, async ({ calls, caught, receipt }) => {
      assert.equal(caught, primary); assert.deepEqual(calls, ["qualify", "harness", "create", "validate:start", "validate:fail", "close"]);
      assert.equal(calls.some(x => x.startsWith("run:")), false);
      assert.equal(receipt.primaryFailure.code, primary.code);
      assert.equal(receipt.cleanupStatus, failure.cleanup === false || failure.cleanupError ? "INCOMPLETE" : "COMPLETE");
      assert.equal(receipt.cleanupError, failure.cleanupError?.code ?? null);
      console.info("D16_CLI_EVIDENCE " + JSON.stringify({ case: "validation-error", testDoubleOnly: true, calls, primaryPreserved: caught === primary, cleanupStatus: receipt.cleanupStatus, cleanupError: receipt.cleanupError }));
    });
  }
});
test("D16 CLI main rejects every non-explicit-positive validation result before first role", async () => {
  for (const validation of [undefined, null, true, {}, { status: "FAIL" }, { status: "PASS" }, { status: "PASS_REPORTED_ONLY" }, { status: "PASS_SYNTHETIC_ONLY" }]) {
    await d16Cli({ validation }, async ({ calls, caught, receipt }) => {
      assert.equal(caught?.code, "EARLY_QUIESCENCE_REQUIRED");
      assert.deepEqual(calls, ["qualify", "harness", "create", "validate:start", "validate:non-positive", "close"]);
      assert.equal(receipt.primaryFailure.code, "EARLY_QUIESCENCE_REQUIRED"); assert.equal(receipt.cleanupStatus, "COMPLETE");
      console.info("D16_CLI_EVIDENCE " + JSON.stringify({ case: "non-positive", testDoubleOnly: true, validation: validation ?? null, calls, firstRunCalled: false, cleanupStatus: receipt.cleanupStatus }));
    });
  }
});
