import { describe, expect, it } from "vitest";

import { resolvePort } from "./resolve-port.mjs";

describe("resolvePort", () => {
  it("uses port 4000 when PORT is not provided", () => {
    expect(resolvePort(undefined)).toBe("4000");
  });

  it("honors the port provided by the hosting environment", () => {
    expect(resolvePort(" 8080 ")).toBe("8080");
  });

  it.each(["0", "65536", "not-a-port", "4000.5"])(
    "rejects invalid PORT value %s",
    (configuredPort) => {
      expect(() => resolvePort(configuredPort)).toThrow(
        "PORT must be an integer between 1 and 65535.",
      );
    },
  );
});
