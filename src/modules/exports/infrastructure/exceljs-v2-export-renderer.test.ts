import { inflateRawSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { renderExcelV2, BoundedExcelV2Sink } from "@/modules/exports/infrastructure/exceljs-v2-export-renderer";
import { EXCEL_V2_HEADERS, type ExcelV2Document } from "@/modules/exports/domain/excel-v2-domain";
import { sanitizeSpreadsheetString } from "@/modules/exports/domain/export-domain";

function doc(count = 1): ExcelV2Document {
  return { selection: { version: 2, target: "EXCEL", period: { mode: "DAY", date: "2026-10-31" }, service: "DINNER", room: "ALL", order: "CREATED_ASC" },
    restaurantName: "Synthetic", timezone: "Europe/Rome", readAt: "2026-10-31T10:30:00Z",
    summary: { reservationCount: count, partySizeTotal: count * 4, knownAdultsTotal: 0, knownChildrenTotal: 0, knownCompositionCount: 0, unknownCompositionCount: count },
    rows: Array.from({ length: count }, (_, i) => ({ ordinal: i + 1, room: "DA ASSEGNARE", arrival: "19:15", lastName: "È Test " + i, firstName: "😀 Anna", partySize: 4,
      adultsCount: null, childrenCount: null, composition: "UNKNOWN — bambini segnalati senza conteggio", games: "Non dichiarati", preferredRoom: "Preferenza storica distinta", requests: "Seggiolone\nAllergie: noci", notes: "NC autorizzata", createdAt: "2026-10-25T00:30:00Z" })),
  };
}
function zip(buffer: Buffer): Map<string, Buffer> {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  expect(end).toBeGreaterThanOrEqual(0);
  const count = buffer.readUInt16LE(end + 10), result = new Map<string, Buffer>();
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20), rawSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extraLength = buffer.readUInt16LE(offset + 30), commentLength = buffer.readUInt16LE(offset + 32), local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    expect(result.has(name)).toBe(false); expect(name).not.toContain("..");
    expect(buffer.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28), compressed = buffer.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    expect(data.byteLength).toBe(rawSize); result.set(name, data); offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}
async function read(buffer: Buffer) { const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer as unknown as ExcelJS.Buffer); return book; }
describe("T11 real XLSX streaming file", () => {
  it.each([0, 1, 101])("renders %i rows with one visible Agenda and no artificial bookings", async count => {
    const buffer = await renderExcelV2(doc(count)), book = await read(buffer), sheet = book.worksheets[0];
    expect(book.worksheets).toHaveLength(1); expect(sheet.name).toBe("Agenda"); expect(sheet.state).toBe("visible");
    expect(sheet.rowCount).toBe(7 + count); expect(sheet.columnCount).toBe(14); expect(sheet.getRow(7).values).toEqual([undefined, ...EXCEL_V2_HEADERS]);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", xSplit: 2, ySplit: 7 });
    if (count) expect(sheet.autoFilter).toBe(`A7:N${count + 7}`); else expect(sheet.autoFilter).toBeUndefined();
    expect(sheet.getCell("A5").value).toContain("non cambiano applicando i filtri Excel");
    expect(sheet.getCell("A2").value).toContain("Sala: TUTTO — Ordine: Creazione crescente");
    if (count) {
      expect(sheet.getCell("A8").value).toBe(1); expect(sheet.getCell("F8").value).toBe(4); expect(sheet.getCell("G8").value).toBeNull(); expect(sheet.getCell("H8").value).toBeNull();
      expect(sheet.getCell("C8").value).toEqual(new Date("1899-12-30T19:15:00Z")); expect(sheet.getCell("C8").numFmt).toBe("hh:mm");
      expect(sheet.getCell("N8").value).toEqual(new Date("2026-10-25T02:30:00Z")); expect(sheet.getCell("N8").numFmt).toBe("dd/mm/yyyy hh:mm");
      expect(sheet.getCell("K8").value).toBe("Preferenza storica distinta"); expect(sheet.getCell("L8").value).not.toContain("Preferenza storica distinta");
    }
  });
  it.each(["_x0041_", "_x005F_x0042_", "_xabcd_", "<>&amp;", "CR\rLF\nTAB\t", " e\u0301 é 😀 ", "=HYPERLINK(\"https://bad\")", " \t+cmd", "@SUM(A1)"])("preserves logical authorized string %j in real shared strings", async value => {
    const d = doc(); d.rows[0].notes = value; const b = await renderExcelV2(d), book = await read(b);
    expect(book.worksheets[0].getCell("M8").value).toBe(sanitizeSpreadsheetString(value));
    const parts = zip(b); expect(parts.has("xl/sharedStrings.xml")).toBe(true);
    expect(parts.get("xl/worksheets/sheet1.xml")!.toString()).not.toMatch(/<f[ >]/u);
  });
  it("retains full native-limit text despite capped visual height and no shrinking", async () => {
    const d = doc(); d.rows[0].notes = "A".repeat(32767);
    const sheet = (await read(await renderExcelV2(d))).worksheets[0];
    expect(sheet.getCell("M8").value).toBe(d.rows[0].notes); expect(sheet.getRow(8).height).toBe(409); expect(sheet.getCell("M8").alignment.shrinkToFit).not.toBe(true);
    d.rows[0].notes += "x"; await expect(renderExcelV2(d)).rejects.toThrow("EXCEL_V2_DATA_NOT_REPRESENTABLE");
  });
  it("keeps zero numeric and unknown blank, duplicate DST local times and original ordinals", async () => {
    const d = doc(2); d.rows[0].adultsCount = 4; d.rows[0].childrenCount = 0; d.rows[0].composition = "TA";
    d.rows[1].createdAt = "2026-10-25T01:30:00Z";
    const sheet = (await read(await renderExcelV2(d))).worksheets[0];
    expect(sheet.getCell("H8").value).toBe(0); expect(sheet.getCell("H9").value).toBeNull(); expect(sheet.getCell("N8").value).toEqual(sheet.getCell("N9").value); expect(sheet.getCell("A9").value).toBe(2);
  });
  it("contains no unexpected executable parts, external relationships, hidden sheets or PII metadata", async () => {
    const parts = zip(await renderExcelV2(doc()));
    for (const [name, bytes] of parts) {
      expect(name).not.toMatch(/vba|externalLinks|embeddings|connections|comments|customXml/iu);
      if (/\.xml$|\.rels$/u.test(name)) expect(bytes.toString()).not.toMatch(/<f[ >]|<hyperlink[ >]|TargetMode="External"|state="(?:hidden|veryHidden)"/u);
    }
    const metadata = parts.get("docProps/core.xml")!.toString(); expect(metadata).not.toContain("NC autorizzata"); expect(metadata).not.toContain("Synthetic");
  });
  it("rejects cumulative sink overflow and cleans up without partial output", async () => {
    await expect(renderExcelV2(doc(), { sink: new BoundedExcelV2Sink(100) })).rejects.toThrow();
    expect((await renderExcelV2(doc())).length).toBeGreaterThan(100);
  });
  it("handles injected sink failure and a later generation remains usable", async () => {
    class Broken extends BoundedExcelV2Sink { override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { callback(new Error("SINK_FAILURE")); } }
    await expect(renderExcelV2(doc(101), { sink: new Broken() })).rejects.toThrow("SINK_FAILURE");
    expect((await renderExcelV2(doc(0))).length).toBeGreaterThan(0);
  });
  it("isolates controlled concurrent writers", async () => {
    const a = doc(), b = doc(); a.rows[0].notes = "A_ONLY"; b.rows[0].notes = "B_ONLY";
    const [aa, bb] = await Promise.all([renderExcelV2(a), renderExcelV2(b)]);
    expect((await read(aa)).worksheets[0].getCell("M8").value).toBe("A_ONLY"); expect((await read(bb)).worksheets[0].getCell("M8").value).toBe("B_ONLY");
  });
  it("enforces the exact cumulative 25MiB boundary before accepting another byte", async () => {
    const sink = new BoundedExcelV2Sink(); sink.on("error", () => undefined);
    await new Promise<void>((done, reject) => sink.write(Buffer.alloc(26_214_400), error => error ? reject(error) : done()));
    await expect(new Promise<void>((done, reject) => sink.write(Buffer.alloc(1), error => error ? reject(error) : done()))).rejects.toThrow();
    sink.discard(); sink.destroy();
  });
  it("writes early1900 native date serials correctly in the real XLSX", async () => {
    const d = doc(3); d.timezone = "UTC";
    ["1900-01-01T12:00:00Z", "1900-02-28T00:00:00Z", "1900-03-01T00:00:00Z"].forEach((value, i) => { d.rows[i].createdAt = value; });
    const xml = zip(await renderExcelV2(d)).get("xl/worksheets/sheet1.xml")!.toString();
    for (const [row, value] of [[8, 1.5], [9, 59], [10, 61]]) expect(xml).toMatch(new RegExp(`<c r="N${row}"[^>]*><v>${value}</v></c>`, "u"));
  });
  it("handles late Archiver finalization after sink failure in an independent Node process", () => {
    const url = pathToFileURL(resolve("src/modules/exports/infrastructure/exceljs-v2-export-renderer.ts")).href;
    const script = `import {renderExcelV2,BoundedExcelV2Sink} from ${JSON.stringify(url)};
      class Broken extends BoundedExcelV2Sink { _write(chunk,encoding,callback){callback(new Error('SINK_FAILURE'));} }
      try { await renderExcelV2(${JSON.stringify(doc())},{sink:new Broken()}); throw new Error('EXPECTED_FAILURE'); }
      catch(error){if(error.message!=='SINK_FAILURE')throw error;}
      await new Promise(resolve=>setTimeout(resolve,100)); console.log('CLEAN_EXIT');`;
    const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--conditions=react-server", "--import=tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0); expect(child.stdout).toContain("CLEAN_EXIT");
  }, 15_000);
});
