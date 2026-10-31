import { afterEach, describe, expect, it, vi } from "vitest";
import { createPdfV2Service } from "@/modules/exports/application/pdf-v2-service";
import type { PdfV2Ports } from "@/modules/exports/application/pdf-v2-ports";
import { ExportActorUnavailableError, ExportSnapshotTooLargeError } from "@/modules/exports/application/export-errors";
import { EXPORT_MAX_BUFFER_BYTES } from "@/modules/exports/domain/export-domain";
import type { PdfV2Request } from "@/modules/exports/domain/pdf-v2-domain";
import type { ExportPreviewReservation, ExportPreviewSnapshot } from "@/modules/exports/domain/export-contract";

const request: PdfV2Request = { version: 2, target: "PDF", period: { mode: "DAY", date: "2090-11-20" }, service: "DINNER", room: "ALL", order: "CREATED_ASC" };
const actor = { id: "actor", restaurantId: "tenant" };
function snapshot(count = 0): ExportPreviewSnapshot {
  const rows: ExportPreviewReservation[] = Array.from({ length: count }, (_, index) => ({
    id: String(index).padStart(6, "0"), localDate: request.period.date, serviceType: "DINNER", arrivalTime: "19:00",
    customerFirstName: "Synthetic", customerLastName: "Client", partySize: 4, childrenCount: null, gameRoomPreference: null,
    legacyChildren: false, preferredRoom: "Non indicata", highChair: false, stroller: false, accessibility: false, celiac: false,
    allergies: null, intolerances: null, celebration: null, animals: false, notes: "NC_ALLOWED", createdAt: new Date("2090-11-01T10:00:00Z"), assignment: null,
  }));
  return { restaurantName: "Synthetic", timezone: "Europe/Rome", availableLegacyRooms: [], reservations: rows };
}
function ports(count = 0): PdfV2Ports {
  return { snapshotReader: { read: vi.fn().mockResolvedValue(snapshot(count)) }, renderer: { render: vi.fn().mockResolvedValue(Buffer.from("%PDF-test")) },
    auditWriter: { write: vi.fn().mockResolvedValue(undefined) }, clock: { now: () => new Date("2090-11-20T12:00:00Z") }, correlationIds: { generate: () => "correlation" } };
}
afterEach(() => vi.restoreAllMocks());
describe("T10 PDF V2 service limits and canonical audit", () => {
  it("performs a fresh capped read on every request and releases the buffer only after SUCCESS", async () => {
    const p = ports(1), order: string[] = [];
    vi.mocked(p.renderer.render).mockImplementation(async document => { order.push("render"); expect(document.groups[0].rows[0].notes).toBe("NC_ALLOWED"); return Buffer.from("%PDF-test"); });
    vi.mocked(p.auditWriter.write).mockImplementation(async () => { order.push("audit"); });
    const service = createPdfV2Service(p);
    const result = await service.generate({ actor, request });
    expect(result.contentType).toBe("application/pdf"); expect(order).toEqual(["render", "audit"]);
    expect(p.snapshotReader.read).toHaveBeenCalledWith({ actor, selection: request, maximumReservations: 2000 });
    expect(p.auditWriter.write).toHaveBeenCalledWith(expect.objectContaining({ outcome: "SUCCESS", format: "PDF", correlationId: "correlation", metadata: {
      format: "PDF", mode: "DAY", fromDate: request.period.date, toDate: request.period.date, dayCount: 1, reservationCount: 1,
    } }));
    await service.generate({ actor, request }); expect(p.snapshotReader.read).toHaveBeenCalledTimes(2);
  });
  it.each([0, 1, 101, 2000])("accepts %i rows without truncation", async count => {
    const p = ports(count); await createPdfV2Service(p).generate({ actor, request });
    expect(vi.mocked(p.renderer.render).mock.calls[0][0].summary.reservationCount).toBe(count);
  });
  it("rejects 2001 rows before rendering and audits canonical overflow once", async () => {
    const p = ports(2001);
    await expect(createPdfV2Service(p).generate({ actor, request })).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
    expect(p.renderer.render).not.toHaveBeenCalled(); expect(p.auditWriter.write).toHaveBeenCalledTimes(1);
    expect(p.auditWriter.write).toHaveBeenCalledWith(expect.objectContaining({ outcome: "FAILURE", metadata: expect.objectContaining({ failureCode: "EXPORT_TOO_LARGE" }) }));
  });
  it.each(["reader", "renderer"])("maps overflow from %s without a partial output", async phase => {
    const p = ports();
    vi.mocked(phase === "reader" ? p.snapshotReader.read : p.renderer.render).mockRejectedValueOnce(new ExportSnapshotTooLargeError());
    await expect(createPdfV2Service(p).generate({ actor, request })).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
    expect(p.auditWriter.write).toHaveBeenCalledTimes(1);
  });
  it("rejects byte 26214401 after rendering and records FAILURE", async () => {
    const p = ports(); vi.mocked(p.renderer.render).mockResolvedValueOnce(Buffer.alloc(EXPORT_MAX_BUFFER_BYTES + 1));
    await expect(createPdfV2Service(p).generate({ actor, request })).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
    expect(p.auditWriter.write).toHaveBeenCalledWith(expect.objectContaining({ outcome: "FAILURE" }));
  });
  it("accepts the exact authorized byte limit", async () => {
    const p = ports(); vi.mocked(p.renderer.render).mockResolvedValueOnce(Buffer.alloc(EXPORT_MAX_BUFFER_BYTES));
    expect((await createPdfV2Service(p).generate({ actor, request })).buffer.byteLength).toBe(EXPORT_MAX_BUFFER_BYTES);
  });
  it("does not render or audit an unavailable actor", async () => {
    const p = ports(); vi.mocked(p.snapshotReader.read).mockRejectedValueOnce(new ExportActorUnavailableError());
    await expect(createPdfV2Service(p).generate({ actor, request })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(p.renderer.render).not.toHaveBeenCalled(); expect(p.auditWriter.write).not.toHaveBeenCalled();
  });
  it("fails closed on noncanonical room and audits GENERATION_FAILED", async () => {
    const p = ports(1), s = snapshot(1);
    s.reservations[0].assignment = { roomCode: "unknown", roomName: "unknown", tables: [] };
    vi.mocked(p.snapshotReader.read).mockResolvedValueOnce(s);
    await expect(createPdfV2Service(p).generate({ actor, request })).rejects.toMatchObject({ code: "EXPORT_DATA_INCONSISTENT" });
    expect(p.renderer.render).not.toHaveBeenCalled(); expect(p.auditWriter.write).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ failureCode: "GENERATION_FAILED" }) }));
  });
  it("sanitizes failures without logging exception contents", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined), p = ports();
    vi.mocked(p.renderer.render).mockRejectedValueOnce(new Error("PRIVATE_RAW_ERROR"));
    await expect(createPdfV2Service(p).generate({ actor, request })).rejects.toMatchObject({ code: "EXPORT_GENERATION_FAILED", message: "Non è stato possibile generare l'esportazione." });
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_RAW_ERROR");
  });
  it.each([false, true])("discards the completed buffer after SUCCESS audit fails, revoked=%s", async revoked => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = ports(); vi.mocked(p.auditWriter.write).mockRejectedValueOnce(revoked ? new ExportActorUnavailableError() : new Error("PRIVATE_AUDIT"));
    await expect(createPdfV2Service(p).generate({ actor, request })).rejects.toMatchObject({ code: revoked ? "FORBIDDEN" : "EXPORT_AUDIT_FAILED" });
    expect(p.auditWriter.write).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("does not loop on a failed FAILURE audit, revoked=%s", async revoked => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const p = ports(); vi.mocked(p.renderer.render).mockRejectedValueOnce(new Error("PRIVATE_RENDER"));
    vi.mocked(p.auditWriter.write).mockRejectedValueOnce(revoked ? new ExportActorUnavailableError() : new Error("PRIVATE_AUDIT"));
    await expect(createPdfV2Service(p).generate({ actor, request })).rejects.toMatchObject({ code: revoked ? "FORBIDDEN" : "EXPORT_GENERATION_FAILED" });
    expect(p.auditWriter.write).toHaveBeenCalledTimes(1);
  });
});
