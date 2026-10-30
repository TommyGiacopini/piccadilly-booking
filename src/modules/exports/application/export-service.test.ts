import { ExportPreviewDataError, type ExportPreviewRequest, type ExportPreviewSnapshot } from "@/modules/exports/domain/export-contract";
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ExportSnapshotTooLargeError,
  ExportActorUnavailableError,
  ExportApplicationError,
} from "@/modules/exports/application/export-errors";
import type {
  ExportActorReference,
  ExportAuditWriteInput,
  ExportPorts,
} from "@/modules/exports/application/export-ports";
import {
  createExportPreviewService,
  createExportService,
} from "@/modules/exports/application/export-service";
import {
  EXPORT_MAX_BUFFER_BYTES,
  buildExportDays,
  type ExcelExportRequest,
  type ExportSnapshotDto,
  type PdfExportRequest,
} from "@/modules/exports/domain/export-domain";

const actor = { id: randomUUID(), restaurantId: randomUUID() };
type AuditWriteInput = ExportAuditWriteInput;

interface TestDependencies {
  readSnapshot: ExportPorts["snapshotReader"]["read"];
  writeAudit: ExportPorts["auditWriter"]["write"];
  renderPdf: ExportPorts["pdfRenderer"]["render"];
  renderExcel: ExportPorts["excelRenderer"]["render"];
  now: ExportPorts["clock"]["now"];
  correlationId: ExportPorts["correlationIds"]["generate"];
}

function snapshot(reservationCount = 0): ExportSnapshotDto {
  return {
    restaurantName: "Piccadilly fittizio",
    timezone: "Europe/Rome",
    fromDate: "2026-08-24",
    toDate: "2026-08-24",
    reservationCount,
    days: buildExportDays(["2026-08-24"], []),
  };
}

function testService(overrides: Partial<TestDependencies> = {}) {
  const dependencies: TestDependencies = {
    readSnapshot: async () => snapshot(),
    writeAudit: async () => undefined,
    renderPdf: async () => Buffer.from("pdf"),
    renderExcel: async () => Buffer.from("xlsx"),
    now: () => new Date("2026-08-24T10:00:00.000Z"),
    correlationId: randomUUID,
    ...overrides,
  };
  return createExportService({
    snapshotReader: { read: dependencies.readSnapshot },
    auditWriter: { write: dependencies.writeAudit },
    pdfRenderer: { render: dependencies.renderPdf },
    excelRenderer: { render: dependencies.renderExcel },
    clock: { now: dependencies.now },
    correlationIds: { generate: dependencies.correlationId },
  });
}

function generatePdfExport(input: {
  actor: ExportActorReference;
  request: PdfExportRequest;
  dependencies?: Partial<TestDependencies>;
}) {
  return testService(input.dependencies).generatePdfExport({
    actor: input.actor,
    request: input.request,
  });
}

function generateExcelExport(input: {
  actor: ExportActorReference;
  request: ExcelExportRequest;
  dependencies?: Partial<TestDependencies>;
}) {
  return testService(input.dependencies).generateExcelExport({
    actor: input.actor,
    request: input.request,
  });
}

function expectCode(error: unknown, code: ExportApplicationError["code"]) {
  expect(error).toBeInstanceOf(ExportApplicationError);
  expect((error as ExportApplicationError).code).toBe(code);
}

describe("M11 export orchestration and failure injection", () => {
  it("returns FORBIDDEN without render or audit when the actor disappears during snapshot", async () => {
    const renderPdf = vi.fn(async () => Buffer.from("must-not-be-returned"));
    const writeAudit = vi.fn(async (input: AuditWriteInput) => {
      void input;
    });

    await expect(
      generatePdfExport({
        actor,
        request: { date: "2026-08-24" },
        dependencies: {
          readSnapshot: async () => {
            throw new ExportActorUnavailableError();
          },
          renderPdf,
          writeAudit,
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(renderPdf).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("discards the completed buffer with FORBIDDEN when the final SUCCESS actor read fails", async () => {
    const writeAudit = vi.fn(async (input: AuditWriteInput) => {
      if (input.outcome === "SUCCESS") throw new ExportActorUnavailableError();
    });

    await expect(
      generatePdfExport({
        actor,
        request: { date: "2026-08-24" },
        dependencies: {
          readSnapshot: async () => snapshot(1),
          renderPdf: async () => Buffer.from("must-not-be-returned"),
          writeAudit,
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0]?.[0].outcome).toBe("SUCCESS");
  });

  it("returns FORBIDDEN without retry when the actor disappears during FAILURE audit", async () => {
    const writeAudit = vi.fn(async (input: AuditWriteInput) => {
      expect(input.outcome).toBe("FAILURE");
      throw new ExportActorUnavailableError();
    });

    await expect(
      generateExcelExport({
        actor,
        request: { mode: "DAY", date: "2026-08-24" },
        dependencies: {
          readSnapshot: async () => snapshot(),
          renderExcel: async () => {
            throw new Error("synthetic Excel failure");
          },
          writeAudit,
        },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(writeAudit).toHaveBeenCalledTimes(1);
  });

  it("keeps an ordinary snapshot outage distinct and audits GENERATION_FAILED", async () => {
    const writeAudit = vi.fn(async (input: AuditWriteInput) => {
      void input;
    });

    await expect(
      generatePdfExport({
        actor,
        request: { date: "2026-08-24" },
        dependencies: {
          readSnapshot: async () => {
            throw new Error("synthetic database outage");
          },
          writeAudit,
        },
      }),
    ).rejects.toMatchObject({ code: "EXPORT_GENERATION_FAILED" });

    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0]?.[0]).toMatchObject({
      outcome: "FAILURE",
      metadata: { failureCode: "GENERATION_FAILED" },
    });
  });

  it("returns a PDF buffer only after a SUCCESS audit", async () => {
    const events: string[] = [];
    const result = await generatePdfExport({
      actor,
      request: { date: "2026-08-24" },
      dependencies: {
        readSnapshot: async () => {
          events.push("snapshot");
          return snapshot(2);
        },
        renderPdf: async () => {
          events.push("render");
          return Buffer.from("pdf");
        },
        writeAudit: async (input) => {
          events.push(`audit-${input.outcome}`);
        },
        correlationId: () => "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(events).toEqual(["snapshot", "render", "audit-SUCCESS"]);
    expect(result.buffer.toString()).toBe("pdf");
  });

  it.each([
    ["PDF", generatePdfExport, { date: "2026-08-24" }],
    ["EXCEL", generateExcelExport, { mode: "DAY", date: "2026-08-24" }],
  ] as const)("audits %s generator failure without false SUCCESS", async (_, generate, request) => {
    const writeAudit = vi.fn(async (input: AuditWriteInput) => {
      void input;
    });
    try {
      await generate({
        actor,
        request: request as never,
        dependencies: {
          readSnapshot: async () => snapshot(),
          renderPdf: async () => {
            throw new Error("synthetic PDF failure");
          },
          renderExcel: async () => {
            throw new Error("synthetic Excel failure");
          },
          writeAudit,
        },
      } as never);
      throw new Error("Expected export failure.");
    } catch (error) {
      expectCode(error, "EXPORT_GENERATION_FAILED");
    }
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0]?.[0]).toMatchObject({
      outcome: "FAILURE",
      metadata: { failureCode: "GENERATION_FAILED" },
    });
  });

  it("audits row and byte guardrail failures as EXPORT_TOO_LARGE", async () => {
    for (const input of [
      { reservationCount: 2_001, buffer: Buffer.from("small") },
      {
        reservationCount: 0,
        buffer: Buffer.alloc(EXPORT_MAX_BUFFER_BYTES + 1),
      },
    ]) {
      const writeAudit = vi.fn(async (auditInput: AuditWriteInput) => {
        void auditInput;
      });
      await expect(
        generatePdfExport({
          actor,
          request: { date: "2026-08-24" },
          dependencies: {
            readSnapshot: async () => snapshot(input.reservationCount),
            renderPdf: async () => input.buffer,
            writeAudit,
          },
        }),
      ).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
      expect(writeAudit.mock.calls[0]?.[0]).toMatchObject({
        outcome: "FAILURE",
        metadata: { failureCode: "EXPORT_TOO_LARGE" },
      });
    }
  });

  it("rejects a valid 32-day RANGE with FAILURE audit before snapshot/render", async () => {
    const readSnapshot = vi.fn(async () => snapshot());
    const renderExcel = vi.fn(async () => Buffer.from("xlsx"));
    const writeAudit = vi.fn(async (input: AuditWriteInput) => {
      void input;
    });
    await expect(
      generateExcelExport({
        actor,
        request: {
          mode: "RANGE",
          from: "2026-08-01",
          to: "2026-09-01",
        },
        dependencies: { readSnapshot, renderExcel, writeAudit },
      }),
    ).rejects.toMatchObject({ code: "EXPORT_RANGE_TOO_LARGE" });
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(renderExcel).not.toHaveBeenCalled();
    expect(writeAudit.mock.calls[0]?.[0]).toMatchObject({
      outcome: "FAILURE",
      metadata: {
        dayCount: 32,
        failureCode: "EXPORT_RANGE_TOO_LARGE",
      },
    });
  });

  it("discards a completed buffer when SUCCESS audit fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        generatePdfExport({
          actor,
          request: { date: "2026-08-24" },
          dependencies: {
            readSnapshot: async () => snapshot(1),
            renderPdf: async () => Buffer.from("must-not-be-returned"),
            writeAudit: async (input) => {
              if (input.outcome === "SUCCESS") throw new Error("synthetic audit failure");
            },
          },
        }),
      ).rejects.toMatchObject({ code: "EXPORT_AUDIT_FAILED" });
      expect(consoleError).toHaveBeenCalledWith(
        "Export success audit write failed.",
        expect.objectContaining({ format: "PDF" }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not loop when generation and FAILURE audit both fail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeAudit = vi.fn(async (input: AuditWriteInput) => {
      void input;
      throw new Error("synthetic failure audit failure");
    });
    try {
      await expect(
        generateExcelExport({
          actor,
          request: { mode: "DAY", date: "2026-08-24" },
          dependencies: {
            readSnapshot: async () => snapshot(),
            renderExcel: async () => {
              throw new Error("synthetic Excel failure");
            },
            writeAudit,
          },
        }),
      ).rejects.toMatchObject({ code: "EXPORT_GENERATION_FAILED" });
      expect(writeAudit).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "Export failure audit write failed.",
        expect.objectContaining({
          format: "EXCEL",
          failureCode: "GENERATION_FAILED",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("T09 early limits and read-only preview orchestration", () => {
  const selection: ExportPreviewRequest = { version: 2, target: "PDF", period: { mode: "DAY", date: "2026-10-29" }, service: "DINNER", room: "ALL", order: "CREATED_ASC" };
  const previewSnapshot: ExportPreviewSnapshot = { restaurantName: "Artificial", timezone: "Europe/Rome", reservations: [], availableLegacyRooms: [] };
  it("rejects an oversized legacy snapshot before invoking either renderer and records the original failure", async () => {
    const render = vi.fn(async () => Buffer.from("not-called"));
    const audit = vi.fn(async (input: AuditWriteInput) => { void input; });
    await expect(generatePdfExport({ actor, request: { date: "2026-10-29" }, dependencies: {
      readSnapshot: async () => snapshot(2001), renderPdf: render, writeAudit: audit,
    } })).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
    expect(render).not.toHaveBeenCalled(); expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0]).toMatchObject({ outcome: "FAILURE", metadata: { failureCode: "EXPORT_TOO_LARGE" } });
  });
  it("handles reader-level overflow as the same 413 failure before rendering", async () => {
    const render = vi.fn(async () => Buffer.from("not-called")), audit = vi.fn(async (input: AuditWriteInput) => { void input; });
    await expect(generatePdfExport({ actor, request: { date: "2026-10-29" }, dependencies: {
      readSnapshot: async () => { throw new ExportSnapshotTooLargeError(); }, renderPdf: render, writeAudit: audit,
    } })).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
    expect(render).not.toHaveBeenCalled(); expect(audit).toHaveBeenCalledTimes(1);
  });
  it("rejects a centuries-long RANGE before read/render without enumerating days", async () => {
    const read = vi.fn(async () => snapshot()), render = vi.fn(async () => Buffer.from("not-called")), audit = vi.fn(async (input: AuditWriteInput) => { void input; });
    await expect(generateExcelExport({ actor, request: { mode: "RANGE", from: "1900-01-01", to: "9999-12-31" }, dependencies: {
      readSnapshot: read, renderExcel: render, writeAudit: audit,
    } })).rejects.toMatchObject({ code: "EXPORT_RANGE_TOO_LARGE" });
    expect(read).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1); expect(audit.mock.calls[0]?.[0]).toMatchObject({ outcome: "FAILURE", metadata: { dayCount: 2958464 } });
  });
  it("returns a positive empty preview through ports with no renderer or audit dependency", async () => {
    const read = vi.fn(async () => previewSnapshot);
    const service = createExportPreviewService({ snapshotReader: { read }, clock: { now: () => new Date("2026-10-29T12:00:00Z") } });
    const result = await service.readPreview({ actor, selection });
    expect(result).toMatchObject({ contractVersion: 2, source: "POSTGRESQL", readAt: "2026-10-29T12:00:00.000Z", summary: { reservationCount: 0 } });
    expect(read).toHaveBeenCalledWith({ actor, selection, maximumReservations: 2000 });
  });
  it.each([
    [new ExportActorUnavailableError(), "FORBIDDEN"],
    [new ExportSnapshotTooLargeError(), "EXPORT_TOO_LARGE"],
    [new ExportPreviewDataError(), "EXPORT_DATA_INCONSISTENT"],
    [new Error("PRIVATE_DATABASE_CONTENT"), "EXPORT_PREVIEW_FAILED"],
  ] as const)("maps preview failures without exposing data %#", async (failure, code) => {
    const service = createExportPreviewService({ snapshotReader: { read: async () => { throw failure; } }, clock: { now: () => new Date() } });
    try { await service.readPreview({ actor, selection }); throw new Error("Expected failure"); }
    catch (error) { expect(error).toMatchObject({ code }); expect(String(error)).not.toContain("PRIVATE_DATABASE_CONTENT"); }
  });
  it("rejects adapter overflow even when a non-database reader ignores the cap", async () => {
    const service = createExportPreviewService({
      snapshotReader: { read: async () => ({ ...previewSnapshot, reservations: new Array(2001).fill(null) }) }, clock: { now: () => new Date() },
    });
    await expect(service.readPreview({ actor, selection })).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
  });
});
