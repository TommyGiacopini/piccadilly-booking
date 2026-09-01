import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { resolveNextStartArguments, startNextServer } from "./start.mjs";

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  kill = vi.fn((signal) => {
    this.signalCode = signal;
    return true;
  });
}

class FakeParent extends EventEmitter {
  execPath = "node";
  exitCode;
}

describe("M13 Next.js start wrapper", () => {
  it("binds explicitly to all interfaces and validates PORT", () => {
    expect(resolveNextStartArguments({ PORT: "10000" }, "next-cli")).toEqual([
      "next-cli",
      "start",
      "-H",
      "0.0.0.0",
      "-p",
      "10000",
    ]);
    expect(() => resolveNextStartArguments({ PORT: "invalid" })).toThrow("PORT");
  });

  it.each(["SIGINT", "SIGTERM"])("forwards %s and preserves child exit code", (signal) => {
    const child = new FakeChild();
    const parent = new FakeParent();
    const spawnChild = vi.fn(() => child);
    startNextServer({
      environment: { APP_ENV: "development", PORT: "4000" },
      parentProcess: parent,
      spawnChild,
      nextCliPath: "next-cli",
    });

    parent.emit(signal);
    expect(child.kill).toHaveBeenCalledWith(signal);
    child.exitCode = 27;
    child.emit("exit", 27, null);
    expect(parent.exitCode).toBe(27);
  });
});
