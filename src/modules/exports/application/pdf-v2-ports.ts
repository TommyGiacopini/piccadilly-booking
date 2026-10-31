import type { ExportAuditWriter, ExportClock, ExportCorrelationIdGenerator, ExportPreviewReader } from "@/modules/exports/application/export-ports";
import type { PdfV2Document } from "@/modules/exports/domain/pdf-v2-domain";

export interface PdfV2Ports {
  snapshotReader: ExportPreviewReader;
  renderer: { render(document: PdfV2Document): Promise<Buffer> };
  auditWriter: ExportAuditWriter;
  clock: ExportClock;
  correlationIds: ExportCorrelationIdGenerator;
}
