import { describe, expect, it } from "vitest";
import { excelV2Arrival, excelV2CreatedCell, excelV2LocalDate, excelV2Text } from "@/modules/exports/infrastructure/excel-v2-cell-policy";

describe("T11 lossless SpreadsheetML policy", () => {
  it.each(["=1+1", "+cmd", "-1", "@SUM(A1)", "  =x", "\tHello", "\nHello", "\rHello"])("neutralizes %j without trimming", value => {
    expect(excelV2Text(value)).toBe(("'" + value).replaceAll("\r", "_x000D_"));
  });
  it.each([" café ", "é e\u0301 😀", "<tag>&amp;</tag>", "a\tb\nc"])("preserves authorized %j", value => expect(excelV2Text(value)).toBe(value));
  it.each(["\0", "\u000b", "\u001f", "\u007f", "\ufffe", "\uffff", "\ud800", "\udc00", "\ud800x"])("rejects nonrepresentable UTF16/XML %j", value => expect(() => excelV2Text(value)).toThrow("EXCEL_V2_DATA_NOT_REPRESENTABLE"));
  it("escapes literals once, including overlapping reserved sequences", () => {
    expect(excelV2Text("_x0041_ _x005F_x0042_ _xabcd_\r\n")).toBe("_x005F_x0041_ _x005F_x005F_x005F_x0042_ _x005F_xabcd__x000D_\n");
  });
  it("enforces 32767 UTF16 units after formula prefix and 253 LF", () => {
    expect(excelV2Text("x".repeat(32767))).toHaveLength(32767);
    expect(() => excelV2Text("x".repeat(32768))).toThrow();
    expect(() => excelV2Text("=" + "x".repeat(32766))).toThrow();
    expect(excelV2Text("x\n".repeat(253))).toBe("x\n".repeat(253));
    expect(() => excelV2Text("x\n".repeat(254))).toThrow();
    expect(excelV2Text("😀".repeat(16383) + "x")).toHaveLength(32767);
  });
  it("encodes local restaurant wall-clock across spring DST", () => {
    expect(excelV2LocalDate("2026-03-29T00:30:00Z", "Europe/Rome").toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(excelV2LocalDate("2026-03-29T01:30:00Z", "Europe/Rome").toISOString()).toBe("2026-03-29T03:30:00.000Z");
  });
  it("acknowledges duplicate autumn wall-clock values without inventing offsets", () => {
    expect(excelV2LocalDate("2026-10-25T00:30:00Z", "Europe/Rome")).toEqual(excelV2LocalDate("2026-10-25T01:30:00Z", "Europe/Rome"));
    expect(excelV2LocalDate("2026-01-01T00:00:00Z", "America/New_York").toISOString()).toBe("2025-12-31T19:00:00.000Z");
  });
  it.each([["invalid", "Europe/Rome"], ["2026-01-01T00:00:00Z", "bad/zone"], ["1800-01-01T00:00:00Z", "UTC"]])("rejects date %s timezone %s", (date, tz) => expect(() => excelV2LocalDate(date, tz)).toThrow());
  it("types arrival independently of timezone", () => { expect(excelV2Arrival("12:00")).toBe(0.5); expect(() => excelV2Arrival("24:00")).toThrow(); });
  it.each([["1900-01-01T12:00:00Z", 1.5], ["1900-02-28T00:00:00Z", 59], ["1900-03-01T00:00:00Z", 61]] as const)("preserves Excel1900 native date serial for %s", (instant, serial) => expect(excelV2CreatedCell(instant, "UTC")).toBe(serial));
});
