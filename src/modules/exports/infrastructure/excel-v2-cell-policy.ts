import { sanitizeSpreadsheetString } from "@/modules/exports/domain/export-domain";
import { ExcelV2DataError } from "@/modules/exports/domain/excel-v2-domain";

// Return SpreadsheetML ST_Xstring data, not XML markup. ExcelJS escapes XML once.
// Escape literal reserved sequences before introducing the CR escape ourselves.
export function excelV2Text(value: string): string {
  if (typeof value !== "string") throw new ExcelV2DataError();
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n < 32 && n !== 9 && n !== 10 && n !== 13 || n === 127 || n === 0xfffe || n === 0xffff) throw new ExcelV2DataError();
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ExcelV2DataError();
    } else if (n >= 0xdc00 && n <= 0xdfff) throw new ExcelV2DataError();
  }
  const safe = sanitizeSpreadsheetString(value);
  if (safe.length > 32767 || (safe.match(/\n/gu)?.length ?? 0) > 253) throw new ExcelV2DataError();
  return safe.replace(/_(?=x[0-9a-fA-F]{4}_)/gu, "_x005F_").replaceAll("\r", "_x000D_");
}

// Excel dates have no timezone. Encode restaurant wall-clock components as an
// ExcelJS Date container in UTC; never consult the machine's local timezone.
export function excelV2LocalDate(instant: string, timezone: string): Date {
  try {
    const source = new Date(instant);
    if (!Number.isFinite(source.getTime())) throw new ExcelV2DataError();
    const parts = new Map(new Intl.DateTimeFormat("en-GB", { timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(source).map(v => [v.type, v.value]));
    const year = Number(parts.get("year"));
    if (year < 1900 || year > 9999) throw new ExcelV2DataError();
    return new Date(Date.UTC(year, Number(parts.get("month")) - 1, Number(parts.get("day")), Number(parts.get("hour")), Number(parts.get("minute")), Number(parts.get("second")), source.getUTCMilliseconds()));
  } catch { throw new ExcelV2DataError(); }
}
export function excelV2Arrival(value: string): number {
  if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(value)) throw new ExcelV2DataError();
  const [h, m] = value.split(":").map(Number); return (h * 60 + m) / 1440;
}

export function excelV2CreatedCell(instant: string, timezone: string): number {
  const wallClock = excelV2LocalDate(instant, timezone);
  const serial = wallClock.getTime() / 86_400_000 + 25569;
  // Excel's 1900 system inserts a fictitious February29. ExcelJS's Date
  // converter assumes the post-February epoch even for earlier dates.
  // A numeric serial with the date/time style is Excel's native date value.
  return serial < 61 ? serial - 1 : serial;
}
