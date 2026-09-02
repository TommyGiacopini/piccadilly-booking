import { describe, expect, it } from "vitest";

import {
  createRateLimitKeyHash,
  isSameOriginRequest,
  resolveClientAddress,
  resolveSafePostLoginPath,
  resolveTrustedRequestOrigin,
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
        "x-forwarded-host": "evil.example, booking.example",
        "x-forwarded-proto": "http, https",
      },
    });

    expect(isSameOriginRequest(direct, false)).toBe(true);
    expect(isSameOriginRequest(crossSite, false)).toBe(false);
    expect(isSameOriginRequest(proxied, false)).toBe(false);
    expect(isSameOriginRequest(proxied, true)).toBe(true);
  });

  it("resolves a direct LAN origin instead of the internal bind origin", () => {
    const request = new Request("http://0.0.0.0:4000/api/auth/login", {
      headers: {
        host: "192.168.1.12:4000",
        origin: "http://192.168.1.12:4000",
      },
    });

    expect(resolveTrustedRequestOrigin(request, false)).toBe(
      "http://192.168.1.12:4000",
    );
  });

  it("preserves the direct localhost origin", () => {
    const request = new Request("http://0.0.0.0:4000/api/auth/login", {
      headers: {
        host: "localhost:4000",
        origin: "http://localhost:4000",
      },
    });

    expect(resolveTrustedRequestOrigin(request, false)).toBe(
      "http://localhost:4000",
    );
  });

  it.each([
    ["external hostname", "attacker.example", "http://attacker.example"],
    [
      "external hostname with port",
      "attacker.example:8080",
      "http://attacker.example:8080",
    ],
    [
      "public IPv4 address",
      "203.0.113.10:4000",
      "http://203.0.113.10:4000",
    ],
  ])(
    "rejects a concordant %s for a wildcard direct request URL",
    (_label, host, origin) => {
      const request = new Request("http://0.0.0.0:4000/api/auth/login", {
        headers: { host, origin },
      });

      expect(resolveTrustedRequestOrigin(request, false)).toBeNull();
    },
  );

  it.each([
    ["10.24.3.9:4000", "http://10.24.3.9:4000"],
    ["172.16.5.4:4000", "http://172.16.5.4:4000"],
    ["172.31.255.254:4000", "http://172.31.255.254:4000"],
    ["127.0.0.1:4000", "http://127.0.0.1:4000"],
  ])("allows local IPv4 fallback %s", (host, origin) => {
    const request = new Request("http://0.0.0.0:4000/api/auth/login", {
      headers: { host, origin },
    });

    expect(resolveTrustedRequestOrigin(request, false)).toBe(origin);
  });

  it("allows bracketed IPv6 loopback for an IPv6 wildcard bind", () => {
    const request = new Request("http://[::]:4000/api/auth/login", {
      headers: { host: "[::1]:4000", origin: "http://[::1]:4000" },
    });

    expect(resolveTrustedRequestOrigin(request, false)).toBe(
      "http://[::1]:4000",
    );
  });

  it("anchors non-wildcard direct requests to request.url", () => {
    const canonical = new Request(
      "https://prenota.example.test/api/auth/login",
      {
        headers: {
          host: "prenota.example.test",
          origin: "https://prenota.example.test",
        },
      },
    );
    const replaced = new Request(
      "https://prenota.example.test/api/auth/login",
      {
        headers: {
          host: "attacker.example",
          origin: "https://attacker.example",
        },
      },
    );

    expect(resolveTrustedRequestOrigin(canonical, false)).toBe(
      "https://prenota.example.test",
    );
    expect(resolveTrustedRequestOrigin(replaced, false)).toBeNull();
  });

  it("rejects unsafe origins and malicious Host/Origin mismatches", () => {
    const crossSite = new Request("http://0.0.0.0:4000/api/auth/login", {
      headers: {
        host: "192.168.1.12:4000",
        origin: "https://evil.example",
      },
    });
    const hostMismatch = new Request("http://0.0.0.0:4000/api/auth/login", {
      headers: {
        host: "attacker.example",
        origin: "http://192.168.1.12:4000",
      },
    });
    const injectedHost = new Request("http://0.0.0.0:4000/api/auth/login", {
      headers: {
        host: "192.168.1.12:4000@attacker.example",
        origin: "http://192.168.1.12:4000",
      },
    });
    const nonHttpOrigin = new Request(
      "http://0.0.0.0:4000/api/auth/login",
      {
        headers: {
          host: "192.168.1.12:4000",
          origin: "ftp://192.168.1.12:4000",
        },
      },
    );

    expect(resolveTrustedRequestOrigin(crossSite, false)).toBeNull();
    expect(resolveTrustedRequestOrigin(hostMismatch, false)).toBeNull();
    expect(resolveTrustedRequestOrigin(injectedHost, false)).toBeNull();
    expect(resolveTrustedRequestOrigin(nonHttpOrigin, false)).toBeNull();
  });

  it("uses the closest trusted proxy hop for redirect origins", () => {
    const request = new Request("http://internal:4000/api/auth/login", {
      headers: {
        host: "internal:4000",
        origin: "https://booking.example",
        "x-forwarded-host": "spoofed.example, booking.example",
        "x-forwarded-proto": "http, https",
      },
    });

    expect(resolveTrustedRequestOrigin(request, true)).toBe(
      "https://booking.example",
    );
  });

  it("ignores spoofed forwarded headers for direct requests", () => {
    const request = new Request("http://0.0.0.0:4000/api/auth/login", {
      headers: {
        host: "192.168.1.12:4000",
        origin: "http://192.168.1.12:4000",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
    });

    expect(resolveTrustedRequestOrigin(request, false)).toBe(
      "http://192.168.1.12:4000",
    );
    expect(resolveTrustedRequestOrigin(request, true)).toBeNull();
  });

  it("uses trusted proxy addresses only when explicitly enabled", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.10, 10.0.0.1" });

    expect(resolveClientAddress(headers, false)).toBe("direct-client");
    expect(resolveClientAddress(headers, true)).toBe("10.0.0.1");
  });

  it("does not let a prepended forwarded address alter a trusted-hop rate-limit key", () => {
    const secret = "test-rate-limit-secret-that-is-long-enough";
    const cleanAddress = resolveClientAddress(
      new Headers({ "x-forwarded-for": "198.51.100.8" }),
      true,
    );
    const spoofedAddress = resolveClientAddress(
      new Headers({ "x-forwarded-for": "203.0.113.99, 198.51.100.8" }),
      true,
    );
    expect(spoofedAddress).toBe(cleanAddress);
    expect(createRateLimitKeyHash("demo.admin", spoofedAddress, secret)).toBe(
      createRateLimitKeyHash("demo.admin", cleanAddress, secret),
    );
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
