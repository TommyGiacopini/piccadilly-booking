import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  migrationSetIsReady,
  propagateWorkerSignal,
  waitForStagingSchemaReady,
} from "./staging-worker-startup.mjs";

describe("M13 staging worker startup", () => {
  it("waits until all thirteen versioned migrations are applied", async () => {
    let checks = 0;
    const sleep = vi.fn(async () => undefined);
    await waitForStagingSchemaReady({
      signal: new AbortController().signal,
      now: () => checks * 2_000,
      sleep,
      checkReady: async () => {
        checks += 1;
        return checks === 3;
      },
    });
    expect(checks).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("accepts exactly the expected thirteen-migration set", () => {
    const expected = Array.from({ length: 13 }, (_, index) => `migration-${index}`);
    expect(migrationSetIsReady(expected, expected)).toBe(true);
  });

  it("rejects a missing migration", () => {
    const expected = Array.from({ length: 13 }, (_, index) => `migration-${index}`);
    expect(migrationSetIsReady(expected.slice(1), expected)).toBe(false);
  });

  it("rejects an unexpected fourteenth migration", () => {
    const expected = Array.from({ length: 13 }, (_, index) => `migration-${index}`);
    expect(
      migrationSetIsReady([...expected, "migration-unexpected"], expected),
    ).toBe(false);
  });

  it("rejects duplicate or inconsistent inventories", () => {
    const expected = Array.from({ length: 13 }, (_, index) => `migration-${index}`);
    expect(
      migrationSetIsReady([...expected.slice(0, 12), expected[0]], expected),
    ).toBe(false);
    expect(
      migrationSetIsReady(expected, [...expected.slice(0, 12), expected[0]]),
    ).toBe(false);
  });

  it("stops an in-progress readiness wait immediately on abort", async () => {
    const controller = new AbortController();
    const promise = waitForStagingSchemaReady({
      signal: controller.signal,
      checkReady: async () => false,
      pollIntervalMs: 60_000,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("propagates worker termination signals", () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    });
    propagateWorkerSignal(child, "SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
