import {
  EXCEL_MAX_RESERVATIONS,
  EXPORT_MAX_BUFFER_BYTES,
  EXPORT_MAX_RANGE_DAYS,
  PDF_MAX_RESERVATIONS,
  excelExportFilename,
  exportFailureAuditMetadata,
  exportSuccessAuditMetadata,
  pdfExportFilename,
  resolveExcelExportPeriod,
  resolveExcelExportBounds,
  resolvePdfExportPeriod,
  type ExcelExportRequest,
  type ExportFailureCode,
  type ExportFormat,
  type ExportPeriod,
  type ExportSnapshotDto,
  type PdfExportRequest,
} from "@/modules/exports/domain/export-domain";
import {
  ExportActorUnavailableError,
  ExportApplicationError,
  ExportSnapshotTooLargeError,
} from "@/modules/exports/application/export-errors";
import type {
  ExportActorReference,
  ExportPorts,
  ExportPreviewPorts,
} from "@/modules/exports/application/export-ports";
import {
  buildExportPreview, ExportPreviewDataError, exportPreviewResponseSchema, previewReservationLimit,
  type ExportPreviewRequest, type ExportPreviewDto,
} from "@/modules/exports/domain/export-contract";

export interface GeneratedExport {
  buffer: Buffer;
  filename: string;
  contentType: string;
  correlationId: string;
}

export interface ExportService {
  generatePdfExport(input: {
    actor: ExportActorReference;
    request: PdfExportRequest;
  }): Promise<GeneratedExport>;
  generateExcelExport(input: {
    actor: ExportActorReference;
    request: ExcelExportRequest;
  }): Promise<GeneratedExport>;
}

function actorForbidden(): ExportApplicationError {
  return new ExportApplicationError(
    "FORBIDDEN",
    "L'utente non può eseguire esportazioni.",
  );
}

async function failureAudit(
  ports: ExportPorts,
  input: {
    actor: ExportActorReference;
    format: ExportFormat;
    period: ExportPeriod;
    correlationId: string;
    failureCode: ExportFailureCode;
  },
): Promise<void> {
  try {
    await ports.auditWriter.write({
      actor: input.actor,
      format: input.format,
      outcome: "FAILURE",
      correlationId: input.correlationId,
      metadata: exportFailureAuditMetadata({
        format: input.format,
        period: input.period,
        failureCode: input.failureCode,
      }),
      createdAt: ports.clock.now(),
    });
  } catch (error) {
    if (error instanceof ExportActorUnavailableError) throw actorForbidden();
    console.error("Export failure audit write failed.", {
      format: input.format,
      failureCode: input.failureCode,
      correlationId: input.correlationId,
    });
    throw new ExportApplicationError(
      "EXPORT_GENERATION_FAILED",
      "Non è stato possibile generare l'esportazione.",
    );
  }
}

async function executeExport(
  ports: ExportPorts,
  input: {
    actor: ExportActorReference;
    format: ExportFormat;
    period: ExportPeriod;
    filename: string;
    contentType: string;
    maximumReservations: number;
    render: (snapshot: ExportSnapshotDto) => Promise<Buffer>;
  },
): Promise<GeneratedExport> {
  const correlationId = ports.correlationIds.generate();
  let snapshot: ExportSnapshotDto;
  let buffer: Buffer;
  let phase: "SNAPSHOT" | "RENDER" = "SNAPSHOT";

  try {
    snapshot = await ports.snapshotReader.read({
      actor: input.actor,
      period: input.period,
      maximumReservations: input.maximumReservations,
    });
    if (snapshot.reservationCount > input.maximumReservations) throw new ExportSnapshotTooLargeError();
    phase = "RENDER";
    buffer = await input.render(snapshot);
  } catch (error) {
    if (error instanceof ExportActorUnavailableError) throw actorForbidden();
    if (error instanceof ExportSnapshotTooLargeError) {
      await failureAudit(ports, { actor: input.actor, format: input.format, period: input.period, correlationId, failureCode: "EXPORT_TOO_LARGE" });
      throw new ExportApplicationError("EXPORT_TOO_LARGE", "L'esportazione supera i limiti tecnici consentiti.");
    }
    console.error("Export generation failed.", {
      format: input.format,
      phase,
      correlationId,
    });
    await failureAudit(ports, {
      actor: input.actor,
      format: input.format,
      period: input.period,
      correlationId,
      failureCode: "GENERATION_FAILED",
    });
    throw new ExportApplicationError(
      "EXPORT_GENERATION_FAILED",
      "Non è stato possibile generare l'esportazione.",
    );
  }

  if (
    snapshot.reservationCount > input.maximumReservations ||
    buffer.byteLength > EXPORT_MAX_BUFFER_BYTES
  ) {
    await failureAudit(ports, {
      actor: input.actor,
      format: input.format,
      period: input.period,
      correlationId,
      failureCode: "EXPORT_TOO_LARGE",
    });
    throw new ExportApplicationError(
      "EXPORT_TOO_LARGE",
      "L'esportazione supera i limiti tecnici consentiti.",
    );
  }

  try {
    await ports.auditWriter.write({
      actor: input.actor,
      format: input.format,
      outcome: "SUCCESS",
      correlationId,
      metadata: exportSuccessAuditMetadata({
        format: input.format,
        period: input.period,
        reservationCount: snapshot.reservationCount,
      }),
      createdAt: ports.clock.now(),
    });
  } catch (error) {
    if (error instanceof ExportActorUnavailableError) throw actorForbidden();
    console.error("Export success audit write failed.", {
      format: input.format,
      correlationId,
    });
    throw new ExportApplicationError(
      "EXPORT_AUDIT_FAILED",
      "Non è stato possibile registrare l'esportazione.",
    );
  }

  return {
    buffer,
    filename: input.filename,
    contentType: input.contentType,
    correlationId,
  };
}

export function createExportService(ports: ExportPorts): ExportService {
  return {
    generatePdfExport(input) {
      const period = resolvePdfExportPeriod(input.request);
      return executeExport(ports, {
        actor: input.actor,
        format: "PDF",
        period,
        filename: pdfExportFilename(input.request.date),
        contentType: "application/pdf",
        maximumReservations: PDF_MAX_RESERVATIONS,
        render: (snapshot) => ports.pdfRenderer.render(snapshot),
      });
    },

    async generateExcelExport(input) {
      const bounds = resolveExcelExportBounds(input.request);
      if (bounds.dayCount > EXPORT_MAX_RANGE_DAYS) {
        const correlationId = ports.correlationIds.generate();
        await failureAudit(ports, {
          actor: input.actor,
          format: "EXCEL",
          period: { ...bounds, dates: [] },
          correlationId,
          failureCode: "EXPORT_RANGE_TOO_LARGE",
        });
        throw new ExportApplicationError(
          "EXPORT_RANGE_TOO_LARGE",
          "L'intervallo può includere al massimo 31 giorni.",
        );
      }
      const period = resolveExcelExportPeriod(input.request);
      return executeExport(ports, {
        actor: input.actor,
        format: "EXCEL",
        period,
        filename: excelExportFilename(input.request),
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        maximumReservations: EXCEL_MAX_RESERVATIONS,
        render: (snapshot) => ports.excelRenderer.render(snapshot),
      });
    },
  };
}

export function createExportPreviewService(ports: ExportPreviewPorts) {
  return {
    async readPreview(input: { actor: ExportActorReference; selection: ExportPreviewRequest }): Promise<ExportPreviewDto> {
      try {
        const maximumReservations = previewReservationLimit(input.selection.target);
        const snapshot = await ports.snapshotReader.read({ actor: input.actor, selection: input.selection, maximumReservations });
        if (snapshot.reservations.length > maximumReservations) throw new ExportSnapshotTooLargeError();
        const dto = exportPreviewResponseSchema.parse(buildExportPreview({ selection: input.selection, snapshot, readAt: ports.clock.now() }));
        if (Buffer.byteLength(JSON.stringify(dto), "utf8") > EXPORT_MAX_BUFFER_BYTES) throw new ExportSnapshotTooLargeError();
        return dto;
      } catch (error) {
        if (error instanceof ExportActorUnavailableError) throw actorForbidden();
        if (error instanceof ExportSnapshotTooLargeError) throw new ExportApplicationError("EXPORT_TOO_LARGE", "La selezione supera i limiti tecnici consentiti.");
        if (error instanceof ExportPreviewDataError) throw new ExportApplicationError("EXPORT_DATA_INCONSISTENT", "I dati della selezione non sono coerenti. Contatta un amministratore.");
        throw new ExportApplicationError("EXPORT_PREVIEW_FAILED", "Non è stato possibile leggere l'anteprima.");
      }
    },
  };
}
