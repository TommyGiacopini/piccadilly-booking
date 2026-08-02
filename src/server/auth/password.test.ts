import { describe, expect, it } from "vitest";

import {
  hashPassword,
  normalizeUsername,
  verifyPassword,
} from "@/server/auth/password";

describe("staff passwords and usernames", () => {
  it("normalizes usernames consistently", () => {
    expect(normalizeUsername("  Demo.Admin  ")).toBe("demo.admin");
    expect(normalizeUsername("ＤＥＭＯ．ＳＴＡＦＦ")).toBe("demo.staff");
  });

  it("hashes with Argon2id and verifies without exposing plaintext", async () => {
    const password = "Local-Test-Password-2026";
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(password);
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
    await expect(verifyPassword(hash, "Incorrect-Password-2026")).resolves.toBe(
      false,
    );
  });
});
