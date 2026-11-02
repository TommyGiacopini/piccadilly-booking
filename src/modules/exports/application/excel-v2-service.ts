import { buildExportPreview, ExportPreviewDataError, exportPreviewResponseSchema } from "@/modules/exports/domain/export-contract";
import { ExcelV2DataError, buildExcelV2Document, excelV2Filename, excelV2RequestSchema, type ExcelV2Request } from "@/modules/exports/domain/excel-v2-domain";
import { EXPORT_MAX_BUFFER_BYTES, EXCEL_MAX_RESERVATIONS, exportFailureAuditMetadata, exportSuccessAuditMetadata, resolvePdfExportPeriod, type ExportFailureCode } from "@/modules/exports/domain/export-domain";
import { ExportActorUnavailableError, ExportApplicationError, ExportSnapshotTooLargeError } from "@/modules/exports/application/export-errors";
import type { ExportActorReference } from "@/modules/exports/application/export-ports";
import type { GeneratedExport } from "@/modules/exports/application/export-service";
import type { ExcelV2Ports } from "@/modules/exports/application/excel-v2-ports";

const forbidden = () => new ExportApplicationError("FORBIDDEN", "L'utente non può eseguire esportazioni.");

export function createExcelV2Service(ports: ExcelV2Ports) {
  return {
    async generate(input: { actor: ExportActorReference; request: ExcelV2Request }): Promise<GeneratedExport> {
      const selection = excelV2RequestSchema.parse(input.request);
      const period = resolvePdfExportPeriod({ date: selection.period.date });
      const correlationId = ports.correlationIds.generate();
      let buffer: Buffer;
      let reservationCount: number;
      try {
        const snapshot = await ports.snapshotReader.read({ actor: input.actor, selection, maximumReservations: EXCEL_MAX_RESERVATIONS });
        if (snapshot.reservations.length > EXCEL_MAX_RESERVATIONS) throw new ExportSnapshotTooLargeError();
        const preview = exportPreviewResponseSchema.parse(buildExportPreview({ selection, snapshot, readAt: ports.clock.now() }));
        const document = buildExcelV2Document(preview);
        reservationCount = document.summary.reservationCount;
        buffer = await ports.renderer.render(document);
        if (buffer.byteLength > EXPORT_MAX_BUFFER_BYTES) throw new ExportSnapshotTooLargeError();
      } catch (error) {
        if (error instanceof ExportActorUnavailableError) throw forbidden();
        const failureCode: ExportFailureCode = error instanceof ExportSnapshotTooLargeError ? "EXPORT_TOO_LARGE" : "GENERATION_FAILED";
        try {
          await ports.auditWriter.write({ actor: input.actor, format: "EXCEL", outcome: "FAILURE", correlationId,
            metadata: exportFailureAuditMetadata({ format: "EXCEL", period, failureCode }), createdAt: ports.clock.now() });
        } catch (auditError) {
          if (auditError instanceof ExportActorUnavailableError) throw forbidden();
          // Never log raw errors, input, SQL or customer data.
          console.error("Excel V2 failure audit failed.", { correlationId, failureCode });
          throw new ExportApplicationError("EXPORT_GENERATION_FAILED", "Non è stato possibile generare l'esportazione.");
        }
        if (failureCode === "EXPORT_TOO_LARGE") throw new ExportApplicationError("EXPORT_TOO_LARGE", "L'esportazione supera i limiti tecnici consentiti.");
        if (error instanceof ExportPreviewDataError || error instanceof ExcelV2DataError) throw new ExportApplicationError("EXPORT_DATA_INCONSISTENT", "I dati della selezione non sono coerenti. Contatta un amministratore.");
        throw new ExportApplicationError("EXPORT_GENERATION_FAILED", "Non è stato possibile generare l'esportazione.");
      }
      try {
        await ports.auditWriter.write({ actor: input.actor, format: "EXCEL", outcome: "SUCCESS", correlationId,
          metadata: exportSuccessAuditMetadata({ format: "EXCEL", period, reservationCount }), createdAt: ports.clock.now() });
      } catch (error) {
        if (error instanceof ExportActorUnavailableError) throw forbidden();
        console.error("Excel V2 success audit failed.", { correlationId });
        throw new ExportApplicationError("EXPORT_AUDIT_FAILED", "Non è stato possibile registrare l'esportazione.");
      }
      return { buffer, filename: excelV2Filename(selection), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", correlationId };
    },
  };
}
