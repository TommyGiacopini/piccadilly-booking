import { describe, expect, it } from "vitest";

import {
  createRateLimitKeyHash,
  isSameOriginRequest,
  resolveClientAddress,
  resolveSafePostLoginPath,
} from "@/server/auth/request-security";

describe("authentication request security", () => {
  it("allows only known internal post-login destinations", () => {
    expect(resolveSafePostLoginPath("/dashboard")).toBe("/dashboard");
    expect(resolveSafePostLoginPath("/admin")).toBe("/admin");
    expect(resolveSafePostLoginPath("https://example.com")).toBe("/dashboard");
    expect(resolveSafePostLoginPath("//example.com")).toBe("/dashboard");
    expect(resolveSafePostLoginPath(["/admin"])).toBe("/dashboard");
  });

  it("requires a matching origin and respects proxies only when configured", () => {
    const direct = new Request("http://localhost:4000/api/auth/login", {
      headers: { host: "localhost:4000", origin: "http://localhost:4000" },
    });
    const crossSite = new Request("http://localhost:4000/api/auth/login", {
      headers: { host: "localhost:4000", origin: "https://evil.example" },
    });
    const proxied = new Request("http://internal:4000/api/auth/login", {
      headers: {
        host: "internal:4000",
        origin: "https://booking.example",
        "x-forwarded-host": "booking.example",
        "x-forwarded-proto": "https",
      },
    });

    expect(isSameOriginRequest(direct, false)).toBe(true);
    expect(isSameOriginRequest(crossSite, false)).toBe(false);
    expect(isSameOriginRequest(proxied, false)).toBe(false);
    expect(isSameOriginRequest(proxied, true)).toBe(true);
  });

  it("uses trusted proxy addresses only when explicitly enabled", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.10, 10.0.0.1" });

    expect(resolveClientAddress(headers, false)).toBe("direct-client");
    expect(resolveClientAddress(headers, true)).toBe("203.0.113.10");
  });

  it("anonymizes the login rate-limit key", () => {
    const hash = createRateLimitKeyHash(
      "demo.admin",
      "203.0.113.10",
      "test-rate-limit-secret-that-is-long-enough",
    );

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("demo.admin");
    expect(hash).not.toContain("203.0.113.10");
  });
});
