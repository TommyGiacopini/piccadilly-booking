import { describe, expect, it } from "vitest";

import {
  AUDIT_CURSOR_MAX_LENGTH,
  AuditQueryError,
  decodeAuditCursor,
  encodeAuditCursor,
  parseAuditListQuery,
} from "@/modules/audit/domain/audit-query";

const eventId = "10000000-0000-4000-8000-000000000001";

describe("audit query contract", () => {
  it("uses the last 30 local days and DST-safe exclusive boundaries", () => {
    const parsed = parseAuditListQuery(
      new URLSearchParams(),
      "Europe/Rome",
      new Date("2026-03-31T22:30:00.000Z"),
    );
    expect(parsed.filters).toMatchObject({ from: "2026-03-03", to: "2026-04-01" });
    expect(parsed.filters.fromInclusive.toISOString()).toBe("2026-03-02T23:00:00.000Z");
    expect(parsed.filters.toExclusive.toISOString()).toBe("2026-04-01T22:00:00.000Z");
    expect(parsed.limit).toBe(25);
  });

  it("accepts exactly 366 days and rejects a longer or inverted range", () => {
    expect(() =>
      parseAuditListQuery(
        new URLSearchParams("from=2026-01-01&to=2027-01-01"),
        "Europe/Rome",
      ),
    ).not.toThrow();
    for (const query of [
      "from=2026-01-01&to=2027-01-02",
      "from=2026-04-02&to=2026-04-01",
    ]) {
      expect(() => parseAuditListQuery(new URLSearchParams(query), "Europe/Rome")).toThrow(AuditQueryError);
    }
  });

  it("rejects unknown, repeated and invalid filters and excessive limits", () => {
    for (const query of [
      "restaurantId=10000000-0000-4000-8000-000000000099",
      "source=RESERVATION&source=ADMINISTRATIVE",
      "category=ARBITRARY",
      "actor=not-a-uuid",
      "entityId=not-a-uuid",
      "limit=101",
      "limit=1.5",
    ]) {
      expect(() => parseAuditListQuery(new URLSearchParams(query), "Europe/Rome")).toThrow(AuditQueryError);
    }
  });

  it("round-trips an opaque versioned cursor without tenant or personal data", () => {
    const query = parseAuditListQuery(
      new URLSearchParams("source=RESERVATION&limit=1"),
      "Europe/Rome",
      new Date("2026-08-13T12:00:00.000Z"),
    );
    const encoded = encodeAuditCursor(
      { timestamp: new Date("2026-08-13T10:00:00.000Z"), sourceRank: 1, eventId },
      query.filterFingerprint,
    );
    expect(encoded.length).toBeLessThanOrEqual(AUDIT_CURSOR_MAX_LENGTH);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("restaurant");
    expect(decodeAuditCursor(encoded, query.filterFingerprint)).toEqual({
      timestamp: new Date("2026-08-13T10:00:00.000Z"),
      sourceRank: 1,
      eventId,
    });
  });

  it("uniformly rejects malformed, unknown-version and filter-mismatched cursors", () => {
    const first = parseAuditListQuery(
      new URLSearchParams("source=RESERVATION"),
      "Europe/Rome",
      new Date("2026-08-13T12:00:00.000Z"),
    );
    const cursor = encodeAuditCursor(
      { timestamp: new Date("2026-08-13T10:00:00.000Z"), sourceRank: 1, eventId },
      first.filterFingerprint,
    );
    const unknownVersion = Buffer.from(
      JSON.stringify({
        v: 2,
        timestamp: "2026-08-13T10:00:00.000Z",
        sourceRank: 1,
        eventId,
        filterFingerprint: first.filterFingerprint,
      }),
    ).toString("base64url");
    const other = parseAuditListQuery(
      new URLSearchParams("source=ADMINISTRATIVE"),
      "Europe/Rome",
      new Date("2026-08-13T12:00:00.000Z"),
    );
    for (const value of ["***", unknownVersion]) {
      expect(() => decodeAuditCursor(value, first.filterFingerprint)).toThrow(AuditQueryError);
    }
    expect(() => decodeAuditCursor(cursor, other.filterFingerprint)).toThrow(AuditQueryError);
  });
});
