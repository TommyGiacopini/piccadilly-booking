import { describe, expect, it } from "vitest";

import {
  createSessionToken,
  getSessionCookieName,
  getSessionCookieOptions,
  hashSessionSecret,
  parseSessionToken,
  sessionSecretMatches,
} from "@/server/auth/session-token";

describe("opaque session tokens", () => {
  it("creates a high-entropy token and stores only a verifiable hash", () => {
    const created = createSessionToken();
    const parsed = parseSessionToken(created.token);
    const hash = hashSessionSecret(created.secret);

    expect(parsed).toEqual({ id: created.id, secret: created.secret });
    expect(created.secret).toHaveLength(43);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(created.secret);
    expect(sessionSecretMatches(created.secret, hash)).toBe(true);
    expect(sessionSecretMatches(`${created.secret.slice(0, -1)}A`, hash)).toBe(
      false,
    );
  });

  it("rejects malformed tokens", () => {
    expect(parseSessionToken("not-a-session")).toBeNull();
    expect(parseSessionToken("00000000-0000-4000-8000-000000000000.short")).toBeNull();
  });

  it("uses hardened cookie settings", () => {
    const expires = new Date("2026-08-02T20:00:00.000Z");

    expect(getSessionCookieName("development")).toBe("piccadilly_session");
    expect(getSessionCookieName("production")).toBe(
      "__Host-piccadilly_session",
    );
    expect(getSessionCookieOptions("development", expires)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      expires,
      priority: "high",
    });
    expect(getSessionCookieOptions("production", expires)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });
});
