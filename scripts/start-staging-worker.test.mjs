import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { readExpectedMigrationNames, runStagingWorker } from "./start-staging-worker.mjs";
import { EXPECTED_STAGING_MIGRATION_NAMES, inspectMigrationLedger } from "./staging-worker-startup.mjs";

const names = [...EXPECTED_STAGING_MIGRATION_NAMES];
const rows = () => names.map(migration_name => ({ migration_name, finished_at: new Date(), rolled_back_at: null, logs: null }));
const environment = { APP_ENV: "staging", RENDER: "true", RENDER_SERVICE_TYPE: "worker", DATABASE_URL: "postgresql://synthetic.invalid/staging" };
async function inventory(operation) {
  const root = await mkdtemp(join(tmpdir(), "m13-inventory-"));
  expect(root.startsWith(join(tmpdir(), "m13-inventory-"))).toBe(true);
  try {
    for (const name of names) { await mkdir(join(root, name)); await writeFile(join(root, name, "migration.sql"), "SELECT 1;"); }
    await writeFile(join(root, "migration_lock.toml"), 'provider = "postgresql"');
    await operation(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
describe("M13 versioned SQL inventory", () => {
  it("reads exactly the sixteen canonical names and nonempty regular SQL files", async () => {
    expect(await readExpectedMigrationNames()).toEqual(names);
    await inventory(async root => { expect(await readExpectedMigrationNames(root)).toEqual(names); });
  });
  for (const mode of ["missing", "empty", "directory", "unexpected", "missing-directory", "extra-directory"]) {
    it("rejects " + mode + " before database access", async () => inventory(async root => {
      const sql = join(root, names[0], "migration.sql");
      if (["missing", "empty", "directory"].includes(mode)) await rm(sql);
      if (mode === "empty") await writeFile(sql, " \n\t");
      if (mode === "directory") await mkdir(sql);
      if (mode === "unexpected") await writeFile(join(root, "unexpected"), "x");
      if (mode === "missing-directory") await rm(join(root, names[0]), { recursive: true });
      if (mode === "extra-directory") await mkdir(join(root, "unexpected"));
      await expect(readExpectedMigrationNames(root)).rejects.toThrow();
    }));
  }
  it("rejects a migration-directory symlink or Windows junction", async () => inventory(async root => {
    const real = join(root, names[0]), target = join(root, "link-target");
    await mkdir(target); await rm(real, { recursive: true });
    await symlink(target, real, process.platform === "win32" ? "junction" : "dir");
    await expect(readExpectedMigrationNames(root)).rejects.toThrow();
  }));
  it("rejects a SQL symlink/junction without opening its target", async () => inventory(async root => {
    const sql = join(root, names[0], "migration.sql"), target = join(root, names[1]);
    await rm(sql); await symlink(target, sql, process.platform === "win32" ? "junction" : "dir");
    await expect(readExpectedMigrationNames(root)).rejects.toThrow("regular file");
  }));
});
function wrapper(overrides = {}) {
  const host = new EventEmitter(), child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() });
  const query = vi.fn(async () => ({ rows: rows() })), end = vi.fn(async () => undefined), connect = vi.fn(async () => undefined);
  const spawnProcess = vi.fn(() => { queueMicrotask(() => child.emit("exit", 7, null)); return child; });
  return { host, child, query, end, connect, spawnProcess, options: {
    environment, processHost: host, spawnProcess, readInventory: async () => names,
    createClient: () => ({ query, end, connect }), ...overrides,
  } };
}
describe("M13 READINESS to SINGLE WORKER SPAWN", () => {
  it("does not spawn during two incomplete polls, then spawns once and preserves exit code", async () => {
    const fixture = wrapper(); let checks = 0, clock = 0;
    fixture.query.mockImplementation(async sql => {
      expect(sql).not.toMatch(/WHERE/i); expect(fixture.spawnProcess).not.toHaveBeenCalled();
      checks++; return { rows: checks < 3 ? rows().slice(1) : rows() };
    });
    fixture.options.waitOptions = { now: () => clock, sleep: async ms => { clock += ms; } };
    expect(await runStagingWorker(fixture.options)).toBe(7);
    expect(fixture.spawnProcess).toHaveBeenCalledTimes(1); expect(fixture.end).toHaveBeenCalledTimes(3);
    expect(fixture.spawnProcess.mock.calls[0][1]).toEqual(expect.arrayContaining(["--conditions=react-server", expect.stringMatching(/worker-cli\.ts$/)]));
    expect(fixture.host.listenerCount("SIGTERM")).toBe(0); expect(fixture.host.listenerCount("SIGINT")).toBe(0);
  });
  it("never connects or spawns if inventory validation fails", async () => {
    const fixture = wrapper({ readInventory: async () => { throw Error("invalid inventory"); } });
    await expect(runStagingWorker(fixture.options)).rejects.toThrow("inventory");
    expect(fixture.connect).not.toHaveBeenCalled(); expect(fixture.spawnProcess).not.toHaveBeenCalled();
    expect(fixture.host.listenerCount("SIGTERM")).toBe(0);
  });
  it("times out on sixteen successes plus an incomplete row without spawning", async () => {
    const fixture = wrapper(); let clock = 0;
    fixture.query.mockResolvedValue({ rows: [...rows(), { migration_name: "unexpected", finished_at: null, rolled_back_at: null, logs: null }] });
    fixture.options.waitOptions = { timeoutMs: 10, now: () => clock, sleep: async ms => { clock += ms; } };
    await expect(runStagingWorker(fixture.options)).rejects.toThrow("timed out");
    expect(fixture.spawnProcess).not.toHaveBeenCalled(); expect(fixture.end).toHaveBeenCalled();
  });
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    it("aborts an in-flight database check on " + signal, async () => {
      const fixture = wrapper();
      fixture.query.mockImplementation(async () => { fixture.host.emit(signal); return { rows: rows() }; });
      expect(await runStagingWorker(fixture.options)).toBe(code);
      expect(fixture.spawnProcess).not.toHaveBeenCalled(); expect(fixture.end).toHaveBeenCalled();
    });
    it("propagates " + signal + " after readiness", async () => {
      const fixture = wrapper();
      fixture.spawnProcess.mockImplementation(() => { queueMicrotask(() => { fixture.host.emit(signal); fixture.child.emit("exit", null, signal); }); return fixture.child; });
      expect(await runStagingWorker(fixture.options)).toBe(code);
      expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith(signal);
    });
  }
  it("surfaces spawn failure and cleans signal handlers", async () => {
    const fixture = wrapper();
    fixture.spawnProcess.mockImplementation(() => { queueMicrotask(() => fixture.child.emit("error", Error("synthetic"))); return fixture.child; });
    await expect(runStagingWorker(fixture.options)).rejects.toThrow("failed to start");
    expect(fixture.host.listenerCount("SIGTERM")).toBe(0);
  });
});
describe.runIf(process.env.M13_STAGING_TOOLING_PG_TEST === "true")("M13 observed PostgreSQL ledger", () => {
  it("reads sixteen applied migrations and classifies PostgreSQL timestamps, nulls and failure logs", async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(url.hostname);
    expect(url.pathname).toMatch(/^\/piccadilly_vitest_[0-9a-f]{32}$/u);
    const client = new pg.Client({ connectionString: url.href }); await client.connect();
    try {
      const applied = await client.query('SELECT migration_name, finished_at, rolled_back_at, logs FROM "_prisma_migrations"');
      expect(inspectMigrationLedger(applied.rows, names)).toEqual({ ready: true, anomalies: [] });
      await client.query("CREATE TEMP TABLE m13_ledger (migration_name text, finished_at timestamptz, rolled_back_at timestamptz, logs text)");
      await client.query('INSERT INTO m13_ledger SELECT migration_name, finished_at, rolled_back_at, logs FROM "_prisma_migrations"');
      await client.query("INSERT INTO m13_ledger VALUES ('unexpected', NULL, NULL, 'synthetic failure')");
      const observed = await client.query("SELECT * FROM m13_ledger");
      expect(inspectMigrationLedger(observed.rows, names)).toMatchObject({ ready: false, anomalies: expect.arrayContaining(["FAILED", "INCOMPLETE", "UNEXPECTED"]) });
    } finally { await client.end(); }
  });
});
