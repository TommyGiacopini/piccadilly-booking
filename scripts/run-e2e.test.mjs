import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runE2e } from "./run-e2e.mjs";
import { runIsolatedVitest } from "./run-vitest-isolated.mjs";
const { test } = process.env.VITEST ? await import("vitest") : await import("node:test");

function e2eFixture(change = () => {}) {
  const phases = [], children = [], outcomes = [];
  const options = {
    requireOwnership: true, environment: { DATABASE_URL: "postgresql://127.0.0.1:49100/synthetic_source" }, logger() {},
    ownershipGuard: async context => { phases.push(context.phase); await change(context); return { valid: true, generation: "synthetic-generation" }; },
    waitForServer: async () => {},
    stopChild: async child => { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); },
    onOutcome: value => outcomes.push(value),
    spawnProcess: (_executable, args) => {
      const child = new EventEmitter(); child.pid = 100 + children.length; child.exitCode = null; child.signalCode = null;
      child.stdout = new PassThrough(); child.kill = () => { child.exitCode = 1; child.emit("exit", 1); child.emit("close", 1); return true; };
      children.push({ child, args });
      if (!args.includes("start")) queueMicrotask(() => {
        if (args.some(s => s.endsWith("fingerprint-e2e-database.ts"))) child.stdout.write(JSON.stringify({ nonRunFingerprint: "same", historicalFixtureRows: 0, runTenantRows: 0 }));
        child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0);
      });
      return child;
    },
  };
  return { options, phases, children, outcomes };
}
test("D6 E2E import is inert and strict missing guard spawns nothing", async () => {
  const f = e2eFixture(); delete f.options.ownershipGuard;
  assert.equal(await runE2e(f.options), 1); assert.equal(f.children.length, 0);
  assert.equal(f.outcomes[0].primaryFailure, "OWNERSHIP_GUARD_REQUIRED");
});
test("D6 E2E all canonical phases are guarded in order including both cleanup and fingerprints", async () => {
  const f = e2eFixture(); assert.equal(await runE2e(f.options), 0);
  assert.deepEqual(f.phases, ["e2e:fingerprint-before", "e2e:prepare-fixture", "e2e:cleanup-initial", "e2e:prepare-users", "e2e:application", "e2e:playwright", "e2e:cleanup-final", "e2e:fingerprint-after"]);
  assert.equal(f.outcomes[0].primaryFailure, null); assert.equal(f.outcomes[0].cleanupFailure, null);
});
for (const phase of ["e2e:fingerprint-before", "e2e:prepare-fixture", "e2e:cleanup-initial", "e2e:prepare-users", "e2e:application", "e2e:playwright", "e2e:cleanup-final", "e2e:fingerprint-after"]) test("D6 E2E revocation rejects " + phase, async () => {
  let revoked = false;
  const f = e2eFixture(c => { if (c.phase === phase) revoked = true; if (revoked) throw Object.assign(new Error("synthetic"), { code: "LEASE_REVOKED" }); });
  assert.equal(await runE2e(f.options), 1);
  assert.ok(f.phases.includes(phase));
  assert.ok(!f.children.some(c => c.args.includes("test")) || ["e2e:cleanup-final", "e2e:fingerprint-after"].includes(phase));
  assert.equal(f.outcomes[0].primaryFailure ?? f.outcomes[0].cleanupFailure, "LEASE_REVOKED");
});
test("D6 E2E abort before first phase creates zero children", async () => {
  const f = e2eFixture(), controller = new AbortController(); controller.abort(); f.options.signal = controller.signal;
  assert.equal(await runE2e(f.options), 1); assert.equal(f.children.length, 0);
});
test("D6 E2E primary error survives independently failed final cleanup", async () => {
  const f = e2eFixture(c => { if (c.phase === "e2e:application") throw Object.assign(Error(), { code: "PRIMARY_SYNTHETIC" }); if (c.phase === "e2e:cleanup-final") throw Object.assign(Error(), { code: "CLEANUP_SYNTHETIC" }); });
  assert.equal(await runE2e(f.options), 1); assert.equal(f.outcomes[0].primaryFailure, "PRIMARY_SYNTHETIC"); assert.equal(f.outcomes[0].cleanupFailure, "CLEANUP_SYNTHETIC");
});

function vitestFixture() {
  const phases = [], calls = [], logs = [], exists = [false, true, false];
  return { phases, calls, logs, options: {
    requireOwnership: true, environment: { APP_ENV: "development", DATABASE_URL: "postgresql://127.0.0.1:49100/synthetic_source" }, targetDatabaseName: "piccadilly_vitest_0123456789abcdef0123456789abcdef", logger: e => logs.push(e),
    ownershipGuard: async c => { phases.push(c.phase); return { valid: true, generation: "synthetic-generation" }; },
    dependencies: { databaseExists: async () => { calls.push("exists"); return exists.shift(); }, createDatabase: async () => { calls.push("create"); }, dropDatabase: async () => { calls.push("drop"); }, migrationCount: async () => 16, runChild: async name => { calls.push(name); return 0; } },
  } };
}
test("D6 Vitest strict missing guard permits zero DDL or child", async () => {
  const f = vitestFixture(); delete f.options.ownershipGuard;
  assert.equal(await runIsolatedVitest(f.options), 1); assert.deepEqual(f.calls, []);
  assert.equal(f.logs.find(e => e.state === "failed").code, "OWNERSHIP_GUARD_REQUIRED");
});
test("D6 Vitest protects CREATE migration seed test cleanup and DROP separately", async () => {
  const f = vitestFixture(); assert.equal(await runIsolatedVitest(f.options), 0);
  assert.deepEqual(f.phases, ["vitest:prepare", "vitest:create", "vitest:migrate", "vitest:seed", "vitest:inspect", "vitest:test", "vitest:cleanup", "vitest:drop"]);
  assert.deepEqual(f.calls, ["exists", "create", "migrate", "seed", "vitest", "exists", "drop", "exists"]);
});
for (const reason of ["GUARD_NEGATIVE", "LEASE_EXPIRED", "CONTAINER_CHANGED", "DATABASE_WRONG", "NETWORK_CHANGED", "ENDPOINT_CHANGED"]) test("D6 Vitest " + reason + " prevents first writer", async () => {
  const f = vitestFixture(); f.options.ownershipGuard = async () => { throw Object.assign(Error(), { code: reason }); };
  assert.equal(await runIsolatedVitest(f.options), 1); assert.deepEqual(f.calls, []);
});
for (const phase of ["vitest:create", "vitest:migrate", "vitest:seed", "vitest:test", "vitest:cleanup", "vitest:drop"]) test("D6 Vitest live revocation before " + phase, async () => {
  const f = vitestFixture(); let revoked = false;
  f.options.ownershipGuard = async c => { f.phases.push(c.phase); if (c.phase === phase) revoked = true; if (revoked) throw Object.assign(Error(), { code: "LEASE_REVOKED" }); return { valid: true, generation: "g" }; };
  assert.equal(await runIsolatedVitest(f.options), 1); assert.ok(!f.calls.includes("drop"));
  if (phase === "vitest:create") assert.ok(!f.calls.includes("create"));
  if (phase === "vitest:migrate") assert.ok(!f.calls.includes("migrate"));
  if (phase === "vitest:seed") assert.ok(!f.calls.includes("seed"));
});
test("D6 Vitest primary failure is retained when cleanup guard also fails", async () => {
  const f = vitestFixture();
  f.options.ownershipGuard = async c => { if (c.phase === "vitest:seed") throw Object.assign(Error(), { code: "PRIMARY_SYNTHETIC" }); if (c.phase === "vitest:cleanup") throw Object.assign(Error(), { code: "CLEANUP_SYNTHETIC" }); return { valid: true, generation: "g" }; };
  assert.equal(await runIsolatedVitest(f.options), 1);
  const cleanup = f.logs.find(e => e.state === "cleanup_failed"); assert.equal(cleanup.primaryFailure, "PRIMARY_SYNTHETIC"); assert.equal(cleanup.cleanupFailure, "CLEANUP_SYNTHETIC"); assert.ok(!f.calls.includes("drop"));
});
