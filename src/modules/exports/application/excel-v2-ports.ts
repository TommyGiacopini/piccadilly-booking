import type { ExportAuditWriter, ExportClock, ExportCorrelationIdGenerator, ExportPreviewReader } from "@/modules/exports/application/export-ports";
import type { ExcelV2Document } from "@/modules/exports/domain/excel-v2-domain";
export interface ExcelV2Ports {
  snapshotReader: ExportPreviewReader;
  renderer: { render(document: ExcelV2Document): Promise<Buffer> };
  auditWriter: ExportAuditWriter; clock: ExportClock; correlationIds: ExportCorrelationIdGenerator;
}
