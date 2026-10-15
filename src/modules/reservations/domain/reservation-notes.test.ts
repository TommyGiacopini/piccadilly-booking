import { describe, expect, it } from "vitest";
import { normalizePrivateNotes, privateNotesAuditSnapshot, reservationPrivateNotesInputSchema } from "./reservation-notes";

describe("autonomous private notes", () => {
  it.each(["", null])("canonically normalizes empty/null %s", (privateNotes) => {
    expect(reservationPrivateNotesInputSchema.parse({ version: 1, privateNotes }).privateNotes).toBeNull();
  });
  it("preserves Unicode, whitespace and plain text without silent truncation", () => {
    const text = "  à 😀 e\u0301\n<script>plain text</script>  ";
    expect(normalizePrivateNotes(text)).toBe(text);
    expect(reservationPrivateNotesInputSchema.parse({ version: 1, privateNotes: "😀".repeat(1000) }).privateNotes).toHaveLength(2000);
    expect(reservationPrivateNotesInputSchema.safeParse({ version: 1, privateNotes: "😀".repeat(1001) }).success).toBe(false);
  });
  it.each([
    { version: 1 }, { version: 0, privateNotes: null }, { version: 1, privateNotes: 1 },
    { version: 1, privateNotes: "x", restaurantId: "tenant" },
    { version: 1, privateNotes: "\u0000" }, { version: 1, privateNotes: "\ud800" },
  ])("strictly rejects invalid bodies", (body) => {
    expect(reservationPrivateNotesInputSchema.safeParse(body).success).toBe(false);
  });
  it("audits only presence and version without text, hash or provenance", () => {
    const marker = "NI_AUTONOMOUS_PRIVATE_MARKER";
    expect(privateNotesAuditSnapshot(marker, 2)).toEqual({ privateNotes: { present: true }, version: 2 });
    expect(privateNotesAuditSnapshot("", 3)).toEqual({ privateNotes: { present: false }, version: 3 });
    expect(JSON.stringify(privateNotesAuditSnapshot(marker, 2))).not.toContain(marker);
  });
});
