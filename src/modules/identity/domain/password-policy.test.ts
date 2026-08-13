import { describe, expect, it } from "vitest";

import {
  SELECTED_PASSWORD_MAXIMUM_CODE_POINTS,
  SELECTED_PASSWORD_MINIMUM_CODE_POINTS,
  unicodeCodePointLength,
  validateSelectedPassword,
} from "@/modules/identity/domain/password-policy";
import {
  generateTemporaryPassword,
  TEMPORARY_PASSWORD_LENGTH,
} from "@/modules/identity/domain/temporary-password";

describe("M9-B selected password policy", () => {
  it("counts Unicode code points without trimming or truncating", () => {
    expect(unicodeCodePointLength("😀".repeat(15))).toBe(15);
    expect(validateSelectedPassword("😀".repeat(15), "operator")).toBeNull();
    expect(
      validateSelectedPassword(" xxxxxxxxxxxxx ", "operator"),
    ).toBeNull();
  });

  it("enforces the 15 to 128 code-point bounds", () => {
    expect(SELECTED_PASSWORD_MINIMUM_CODE_POINTS).toBe(15);
    expect(SELECTED_PASSWORD_MAXIMUM_CODE_POINTS).toBe(128);
    expect(validateSelectedPassword("a".repeat(14), "operator")?.code).toBe(
      "TOO_SHORT",
    );
    expect(validateSelectedPassword("a".repeat(129), "operator")?.code).toBe(
      "TOO_LONG",
    );
  });

  it("rejects controls, local blocked values and the username case-insensitively", () => {
    expect(
      validateSelectedPassword("valid-password\n2026", "operator")?.code,
    ).toBe("CONTROL_CHARACTER");
    expect(
      validateSelectedPassword(
        "PiccadillyDemoAdmin-Local-2026",
        "operator",
      )?.code,
    ).toBe("BLOCKED");
    expect(
      validateSelectedPassword("LONG.USERNAME.2026", "long.username.2026")
        ?.code,
    ).toBe("MATCHES_USERNAME");
  });

  it("generates independent CSPRNG temporary passwords of exactly 24 characters", () => {
    const passwords = new Set(
      Array.from({ length: 32 }, () => generateTemporaryPassword()),
    );

    expect(TEMPORARY_PASSWORD_LENGTH).toBe(24);
    expect(passwords.size).toBe(32);
    for (const password of passwords) {
      expect(unicodeCodePointLength(password)).toBe(24);
      expect(validateSelectedPassword(password, "operator")).toBeNull();
    }
  });
});
