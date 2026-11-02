import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  EXPECTED_STAGING_MIGRATION_COUNT, EXPECTED_STAGING_MIGRATION_NAMES,
  inspectMigrationLedger, migrationSetIsReady, propagateWorkerSignal,
  waitForAbortableDelay, waitForStagingSchemaReady,
} from "./staging-worker-startup.mjs";

const names = [...EXPECTED_STAGING_MIGRATION_NAMES];
const ledger = () => names.map(migration_name => ({
  migration_name, finished_at: new Date("2026-11-02T12:00:00Z"),
  rolled_back_at: null, logs: null,
}));
describe("M13 strict schema16 readiness", () => {
  it("pins sixteen approved nonempty unique migration names", () => {
    expect(EXPECTED_STAGING_MIGRATION_COUNT).toBe(16);
    expect(names).toHaveLength(16); expect(new Set(names).size).toBe(16);
    expect(names.every(name => /^\d{14}_[a-z0-9_]+$/u.test(name))).toBe(true);
    expect(names.at(-1)).toBe("20261014000000_add_reservation_private_notes");
    expect(migrationSetIsReady([...names].reverse(), names)).toBe(true);
    expect(inspectMigrationLedger(ledger().reverse(), names)).toEqual({ ready: true, anomalies: [] });
  });
  it("rejects empty, missing, additional and substituted names", () => {
    for (const applied of [[], names.slice(1), [...names, "unexpected"], [...names.slice(1), "unexpected"]])
      expect(migrationSetIsReady(applied, names)).toBe(false);
    expect(migrationSetIsReady(names, [])).toBe(false);
    expect(migrationSetIsReady(names, names.slice(1))).toBe(false);
  });
  it("rejects real duplicates at cardinality sixteen on either side", () => {
    const duplicate = [...names.slice(0, 15), names[0]];
    expect(duplicate).toHaveLength(16); expect(new Set(duplicate).size).toBe(15);
    expect(migrationSetIsReady(duplicate, names)).toBe(false);
    expect(migrationSetIsReady(names, duplicate)).toBe(false);
    const rows = ledger(); rows[15].migration_name = rows[0].migration_name;
    expect(inspectMigrationLedger(rows, names)).toMatchObject({ ready: false, anomalies: expect.arrayContaining(["DUPLICATE", "MISSING"]) });
  });
  for (const [label, change, code] of [
    ["incomplete", row => { row.finished_at = null; }, "INCOMPLETE"],
    ["failed", row => { row.finished_at = null; row.logs = "synthetic failure"; }, "FAILED"],
    ["rolled back", row => { row.rolled_back_at = new Date(); }, "ROLLED_BACK"],
    ["unexpected", row => { row.migration_name = "unexpected"; }, "UNEXPECTED"],
  ]) it("rejects an observed " + label + " ledger row", () => {
    const rows = ledger(); change(rows[0]);
    expect(inspectMigrationLedger(rows, names)).toMatchObject({ ready: false, anomalies: expect.arrayContaining([code]) });
  });
  it("does not hide an extra anomalous row behind sixteen successful migrations", () => {
    for (const row of [
      { migration_name: "unexpected", finished_at: null, rolled_back_at: null, logs: null },
      { migration_name: "unexpected", finished_at: null, rolled_back_at: null, logs: "synthetic failure" },
      { ...ledger()[0] }, { ...ledger()[0], rolled_back_at: new Date() },
    ]) expect(inspectMigrationLedger([...ledger(), row], names).ready).toBe(false);
    expect(inspectMigrationLedger(ledger().slice(1), names.slice(1)).anomalies).toContain("INVENTORY_INVALID");
  });
  it("polls until readiness and retries a connection failure", async () => {
    let checks = 0, clock = 0; const sleep = vi.fn(async ms => { clock += ms; });
    await waitForStagingSchemaReady({
      signal: new AbortController().signal, now: () => clock, sleep,
      checkReady: async () => { checks++; if (checks === 1) throw Error("synthetic failure"); return checks === 3; },
    });
    expect(checks).toBe(3); expect(sleep.mock.calls.map(call => call[0])).toEqual([2000, 2000]);
  });
  it("times out and bounds the final polling delay", async () => {
    let clock = 0; const sleep = vi.fn(async ms => { clock += ms; });
    await expect(waitForStagingSchemaReady({
      signal: new AbortController().signal, now: () => clock, sleep, timeoutMs: 3000, checkReady: async () => false,
    })).rejects.toThrow("timed out");
    expect(sleep.mock.calls.map(call => call[0])).toEqual([2000, 1000]);
  });
  it("rejects readiness returned after its deadline", async () => {
    let clock = 0;
    await expect(waitForStagingSchemaReady({
      signal: new AbortController().signal, now: () => clock, timeoutMs: 1000,
      checkReady: async () => { clock = 1001; return true; },
    })).rejects.toThrow("timed out");
  });
  it("aborts before polling, during sleep and after an in-flight ready result", async () => {
    const early = new AbortController(); early.abort(); const checkReady = vi.fn(async () => true);
    await expect(waitForStagingSchemaReady({ signal: early.signal, checkReady })).rejects.toMatchObject({ name: "AbortError" });
    expect(checkReady).not.toHaveBeenCalled();
    await expect(waitForAbortableDelay(60000, early.signal)).rejects.toMatchObject({ name: "AbortError" });
    const sleeping = new AbortController(), delay = waitForAbortableDelay(60000, sleeping.signal); sleeping.abort();
    await expect(delay).rejects.toMatchObject({ name: "AbortError" });
    const inFlight = new AbortController();
    await expect(waitForStagingSchemaReady({
      signal: inFlight.signal, checkReady: async () => { inFlight.abort(); return true; },
    })).rejects.toMatchObject({ name: "AbortError" });
    await expect(waitForAbortableDelay(1, new AbortController().signal)).resolves.toBeUndefined();
  });
  for (const signal of ["SIGINT", "SIGTERM"]) it("propagates " + signal + " only to a live child", () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() });
    propagateWorkerSignal(child, signal); expect(child.kill).toHaveBeenCalledExactlyOnceWith(signal);
    child.exitCode = 0; propagateWorkerSignal(child, signal); expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
